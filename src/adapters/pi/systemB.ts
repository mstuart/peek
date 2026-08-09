// pi System B (harness v4) mutation-log parsing (Lane D, docs/DESIGN.md § Other v2 subsystems).
// See docs/recon/pi.md § "System B" — this is the harness-SDK (`AgentHarness`)
// persistence format, a different lineage from the pi CLI's System A
// (tree.ts/parse.ts). Replaces the old detect-and-skip path.
//
// RULE (model/types.ts ParseResult): adapters never throw on malformed/
// unknown content — warn and continue; only an unreadable file rejects (and
// even then, this module falls back to a best-effort empty session rather
// than throwing — see parseSystemBHeader).
//
// CAUTION (per task brief): docs/recon/pi.md says System B is source-derived
// with less certainty than System A ("Different lineage ... also a SQLite
// backend"; only `kind`/`seq` on mutation lines are recon-confirmed). Every
// wire-shape decision below beyond `kind`/`seq` is this module's own
// documented assumption, not a recon fact — see
// test/fixtures/pi/README.md's "System B (harness v4) mutation-log shapes"
// section for the full list. Where a shape gap couldn't be reasonably
// inferred from System A's parallel construct, this module stops (warns and
// skips that line/feature) rather than inventing further.
//
// Mutation kinds handled (docs/recon/pi.md: `{kind: "entry"|"record"|"lane"|
// "fact", seq}`):
//   - "entry": tree node, same shape convention as System A's tree entries
//     (`type`, `id`, `parentId`, `timestamp`, + type-specific fields) but
//     unix-ms timestamps (recon, vs. System A's ISO strings) and wrapped in
//     the kind/seq envelope. ASSUMPTION: entry.type is drawn from the same
//     conceptual space as System A ("message carries an AgentMessage" is
//     recon-stated for both systems), but only "message" and "compaction"
//     are implemented here (the task's enumerated scope + what recon
//     explicitly calls out) — any other entry.type is linked into the tree
//     (so pathToRoot still works) but produces no Turn/event, with a warning
//     (forward-compat, mirrors tree.ts's unknown-entry-type handling).
//   - "record": ASSUMPTION — ONLY UsageRecord is modeled (task scope): any
//     record carrying a `usage` field is treated as a cumulative usage
//     cross-check sample, mirroring codex's total_token_usage pattern
//     (src/adapters/codex/usage.ts's checkCumulativeCrossCheck). Other
//     record subtypes are tolerated silently (no warning) — "record" is a
//     recon-confirmed top-level kind, so an unrecognized subtype under it is
//     not treated as unknown top-level shape.
//   - "lane": ASSUMPTION — a lane mutation moves one branch's leaf pointer to
//     `entryId`; the task spec: "active lane's leafId → path (single lane
//     default; multiple lanes → use the lane with the latest seq leaf move,
//     warn 'N other lanes ignored')". Implemented exactly as specified.
//   - "fact": ASSUMPTION — task spec: "facts(name) → session name ... ignore
//     (Session has no name field)". All facts are ignored (no Turn, no
//     event, no warning — a known, deliberately-dropped kind, not unknown).
//   - anything else (unrecognized top-level `kind`, or a malformed/
//     non-object mutation line): ParseWarning, line skipped, never throws.

import type {
  ParseResult,
  ParseWarning,
  Session,
  SessionEvent,
  SessionRef,
  Span,
  Turn,
} from "../../model/types.js";
import {
  buildCompactionEvent,
  buildMessageTurn,
  isRecord,
  prop,
  toNumber,
} from "./shared.js";
import {
  extractCompactionSummarySpans,
  extractPendingMessageSpans,
} from "./spans.js";
import { pathToRoot } from "./tree.js";
import type { PiEntry } from "./tree.js";

interface SystemBHeader {
  version: number | undefined;
  id: string;
  cwd: string;
  timestampMs: number;
}

interface LaneMove {
  laneId: string;
  entryId: string;
  seq: number;
}

interface UsageRecordSample {
  seq: number;
  usage: unknown;
}

const CROSS_CHECK_TOLERANCE = 0.01; // 1% — mirrors codex/usage.ts

/**
 * Header line's `id`/`cwd`/`timestamp` on a best-effort basis, falling back
 * to SessionRef-derived defaults on any parse failure — mirrors parse.ts's
 * emptySessionFromHeaderLine, since a System B header that fails to parse
 * here still must not throw.
 */
function parseSystemBHeader(
  ref: SessionRef,
  headerLine: string | undefined,
): SystemBHeader {
  let id = ref.id;
  let cwd = ref.cwd ?? "";
  let timestampMs = ref.mtime.getTime();
  let version: number | undefined;

  if (headerLine !== undefined) {
    try {
      const parsed: unknown = JSON.parse(headerLine);
      if (isRecord(parsed)) {
        if (typeof parsed.id === "string") id = parsed.id;
        if (typeof parsed.cwd === "string") cwd = parsed.cwd;
        if (typeof parsed.timestamp === "number")
          timestampMs = parsed.timestamp;
        if (typeof parsed.version === "number") version = parsed.version;
      }
    } catch {
      // ignore — fall back to SessionRef-derived defaults above
    }
  }

  return { version, id, cwd, timestampMs };
}

/**
 * Resolves which lane's leaf is "the" active path: the lane whose most
 * recent (highest-seq) move is the latest across all lanes (task spec).
 * Returns the count of OTHER distinct lanes seen, for the "N other lanes
 * ignored" warning.
 */
function resolveActiveLane(laneMoves: LaneMove[]): {
  leafId: string | undefined;
  otherLaneCount: number;
} {
  if (laneMoves.length === 0) return { leafId: undefined, otherLaneCount: 0 };

  const latestByLane = new Map<string, LaneMove>();
  for (const move of laneMoves) {
    const current = latestByLane.get(move.laneId);
    if (!current || move.seq > current.seq) latestByLane.set(move.laneId, move);
  }

  let active: LaneMove | undefined;
  for (const move of latestByLane.values()) {
    if (!active || move.seq > active.seq) active = move;
  }

  return {
    leafId: active?.entryId,
    otherLaneCount: Math.max(0, latestByLane.size - 1),
  };
}

/**
 * UsageRecord cross-check (task spec: "mirroring the codex cumulative
 * pattern" — src/adapters/codex/usage.ts's checkCumulativeCrossCheck).
 * ASSUMPTION: a UsageRecord's `usage.totalTokens` is a CUMULATIVE
 * running total (not a per-record delta), by direct analogy with codex's
 * `total_token_usage.total_tokens` — recon does not specify a shape beyond
 * `kind`/`seq` for records. The LAST UsageRecord seen in the file is
 * compared against Σ(turn.contextTotal + turn.usage.output) over every Turn
 * on the active path (zero-usage turns skipped, same convention as codex).
 * Like codex's documented compaction discontinuity, a session containing a
 * compaction is EXPECTED to fail this check by a wide margin — a real,
 * correctly-detected discontinuity, not a parser bug.
 */
function checkSystemBUsageCrossCheck(
  turns: readonly Turn[],
  usageRecords: readonly UsageRecordSample[],
  warnings: ParseWarning[],
): void {
  if (usageRecords.length === 0) return;

  const last = usageRecords.reduce((a, b) => (b.seq > a.seq ? b : a));
  const cumulative = toNumber(prop(last.usage, "totalTokens"));

  let sum = 0;
  for (const turn of turns) {
    if (turn.contextTotal === 0) continue;
    sum += turn.contextTotal + turn.usage.output;
  }

  const diff = Math.abs(cumulative - sum);
  const denom = Math.max(Math.abs(cumulative), 1);
  if (diff / denom > CROSS_CHECK_TOLERANCE) {
    warnings.push({
      code: "pi-systemb-usage-record-mismatch",
      message: `cumulative UsageRecord total (${cumulative}) diverges from Σ per-turn totals (${sum}) by more than 1%`,
    });
  }
}

/**
 * Parses a pi System B (harness v4) mutation-log session: full file lines
 * (including the header at index 0), already read by parse.ts. Synchronous
 * and pure — no file I/O of its own — so tests can exercise it directly with
 * inline mutation-log lines (see test/unit/pi-systemb.test.ts) without
 * needing a fixture file on disk.
 */
export function parseSystemBSession(
  ref: SessionRef,
  lines: string[],
  spansEnabled: boolean,
): ParseResult {
  const header = parseSystemBHeader(ref, lines[0]);
  const warnings: ParseWarning[] = [];

  const entries = new Map<string, PiEntry>();
  const laneMoves: LaneMove[] = [];
  const usageRecords: UsageRecordSample[] = [];

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    if (raw === undefined || raw.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnings.push({
        code: "pi-systemb-malformed-line",
        message: "System B mutation line is not valid JSON",
        line: lineNo,
      });
      continue;
    }

    if (!isRecord(parsed)) {
      warnings.push({
        code: "pi-systemb-malformed-line",
        message: "System B mutation line is not a JSON object",
        line: lineNo,
      });
      continue;
    }

    const kind = parsed.kind;
    const seq = typeof parsed.seq === "number" ? parsed.seq : lineNo;

    switch (kind) {
      case "entry": {
        const type = parsed.type;
        const id = parsed.id;
        const parentId = parsed.parentId;
        const timestampMsRaw = parsed.timestamp;
        if (
          typeof type !== "string" ||
          typeof id !== "string" ||
          !("parentId" in parsed) ||
          (parentId !== null && typeof parentId !== "string") ||
          typeof timestampMsRaw !== "number"
        ) {
          warnings.push({
            code: "pi-systemb-malformed-entry",
            message: "System B entry mutation is missing required fields",
            line: lineNo,
            ...(typeof type === "string" ? { recordType: type } : {}),
          });
          break;
        }
        // Strip the envelope (kind/seq) and tree fields, same convention as
        // tree.ts's parsePiEntryTree — remainder is entry-type-specific data.
        const {
          kind: _kind,
          seq: _seq,
          type: _type,
          id: _id,
          parentId: _parentId,
          timestamp: _timestamp,
          ...data
        } = parsed;
        entries.set(id, {
          type,
          id,
          parentId,
          // ASSUMPTION (recon: unix-ms for System B timestamps): converted to
          // an ISO string here so PiEntry's timestamp field (shared with
          // System A, declared as `string`) stays uniform — the numeric wire
          // value is not otherwise needed, `new Date(...)` round-trips it.
          timestamp: new Date(timestampMsRaw).toISOString(),
          data,
        });
        break;
      }
      case "lane": {
        const laneId = parsed.laneId;
        const entryId = parsed.entryId;
        if (typeof laneId !== "string" || typeof entryId !== "string") {
          warnings.push({
            code: "pi-systemb-malformed-lane",
            message: "System B lane mutation is missing laneId/entryId",
            line: lineNo,
          });
          break;
        }
        laneMoves.push({ laneId, entryId, seq });
        break;
      }
      case "record": {
        if (parsed.usage !== undefined) {
          usageRecords.push({ seq, usage: parsed.usage });
        }
        break;
      }
      case "fact": {
        // Ignored by design — see file header ("fact" section). No Turn, no
        // event, no warning: this is a recognized, deliberately-dropped
        // mutation kind, not an unknown one.
        break;
      }
      default: {
        const kindStr = typeof kind === "string" ? kind : undefined;
        warnings.push({
          code: "pi-systemb-unknown-kind",
          message: `unrecognized System B mutation kind: ${kindStr ?? "(missing)"}`,
          line: lineNo,
          ...(kindStr !== undefined ? { recordType: kindStr } : {}),
        });
      }
    }
  }

  const { leafId, otherLaneCount } = resolveActiveLane(laneMoves);
  if (otherLaneCount > 0) {
    warnings.push({
      code: "pi-systemb-multiple-lanes",
      message: `${otherLaneCount} other lane(s) ignored`,
    });
  }
  const path = leafId !== undefined ? pathToRoot(entries, leafId) : [];

  const turns: Turn[] = [];
  const events: SessionEvent[] = [];
  let lastKnownModel = "";
  // Same pending-spans attachment convention as parse.ts (see spans.ts file
  // header) — held since the last assistant Turn, flushed into the next one.
  let pendingSpans: Span[] = [];

  for (const id of path) {
    const entry = entries.get(id);
    if (!entry) continue;

    switch (entry.type) {
      case "message": {
        const built = buildMessageTurn(
          entry,
          lastKnownModel,
          pendingSpans,
          spansEnabled,
        );
        if (!built) {
          warnings.push({
            code: "pi-systemb-unrecognized-message-role",
            message: "message entry has an unrecognized or missing role",
            recordType: entry.type,
          });
          break;
        }
        turns.push(built.turn);
        if (built.newModel !== undefined) lastKnownModel = built.newModel;
        if (built.turn.role === "assistant") {
          pendingSpans = [];
        } else if (spansEnabled) {
          const message = prop(entry.data, "message");
          if (isRecord(message)) {
            pendingSpans.push(...extractPendingMessageSpans(message));
          }
        }
        break;
      }
      case "compaction": {
        events.push(buildCompactionEvent(entry, turns.length));
        if (spansEnabled) {
          pendingSpans.push(
            ...extractCompactionSummarySpans(prop(entry.data, "summary")),
          );
        }
        // "retainedTail length noted" (task spec) — the retained
        // AgentMessage[] is NOT replayed as Turns (would double-count
        // against the entry stream's own messages, and recon doesn't
        // confirm whether retainedTail messages are ALSO re-emitted as
        // separate "entry" mutations later in the log) — stop-and-report
        // per the task's CAUTION, rather than inventing a merge rule.
        const retainedTailRaw = prop(entry.data, "retainedTail");
        const retainedTailLength = Array.isArray(retainedTailRaw)
          ? retainedTailRaw.length
          : 0;
        warnings.push({
          code: "pi-systemb-compaction-retained-tail",
          message: `compaction retained ${retainedTailLength} trailing message(s) via retainedTail (not replayed as Turns)`,
        });
        break;
      }
      default:
        warnings.push({
          code: "pi-systemb-unrecognized-entry-type",
          message: `unrecognized System B entry type: ${entry.type}`,
          recordType: entry.type,
        });
        break;
    }
  }

  if (pendingSpans.length > 0) {
    warnings.push({
      code: "pi-systemb-trailing-content-unattached",
      message: `${pendingSpans.length} span(s) from trailing pi entries after the last assistant turn are not attached to any Turn`,
    });
  }

  checkSystemBUsageCrossCheck(turns, usageRecords, warnings);

  const lastPathId = path[path.length - 1];
  const lastEntry =
    lastPathId !== undefined ? entries.get(lastPathId) : undefined;
  const endedAt = lastEntry
    ? new Date(lastEntry.timestamp)
    : new Date(header.timestampMs);

  const session: Session = {
    harness: "pi",
    harnessVersion: header.version !== undefined ? String(header.version) : "4",
    id: header.id,
    cwd: header.cwd,
    startedAt: new Date(header.timestampMs),
    endedAt,
    configSnapshot: { model: lastKnownModel, modelChanges: [] },
    turns,
    events,
    children: [],
    warnings,
  };

  return { session, warnings };
}
