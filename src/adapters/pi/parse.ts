// pi System A session parsing: entry tree (tree.ts) → Turn/Event/Session.
// See docs/recon/pi.md § "System A" for the schema this maps and § "System B"
// for the mutation-log path (Lane D, docs/DESIGN.md § Other v2 subsystems — systemB.ts, wired in
// below). RULE (model/types.ts ParseResult): adapters never throw on
// malformed/unknown content — warn and continue; only an unreadable file
// rejects.
//
// Content-span extraction (T6.4) lives in spans.ts; see its file header for
// the pending-spans attachment convention this module drives (pendingSpans
// below). The message-shape -> Turn/CostBreakdown helpers this module and
// systemB.ts both need (System B "entries carry same AgentMessage lineage"
// per docs/recon/pi.md) live in shared.ts, not here, to avoid a
// parse.ts <-> systemB.ts circular import.
//
// Mapping decisions not fully pinned down by docs/recon/pi.md or the task
// spec (flagged for review):
//   - TurnRole has no "tool" variant. toolResult/bashExecution/embedded
//     CustomMessage (message.role:"custom") are mapped to "user", mirroring
//     how Claude Code represents tool_result blocks as user-role messages.
//   - Turn.model is non-optional. For non-assistant turns it carries the
//     last-known model (updated by assistant turns' own `model` field and by
//     `model_change` entries) rather than being left blank.
//   - bashExecution's `excludeFromContext` flag has no dedicated Turn field;
//     per the task note ("note in raw") it is preserved by setting
//     NormalizedUsage.raw to the raw message payload for user/toolResult/
//     bashExecution/custom turns (which otherwise have no numeric usage).
//   - ToolResultMessage.usage (recon: optional) is NOT extracted at parse
//     time — no fixture exercises it and the task's usage-extraction
//     parenthetical only covers assistant turns; left for a future pass.
//   - configSnapshot.modelChanges is filtered to `field === "model"`
//     ModeChange events (thinking-level changes land in `events` only).
//   - CompactionEvent.turnIndex = turns.length at the moment the compaction
//     entry is reached (i.e. the index the *next* turn will occupy).

import { readFile } from "node:fs/promises";
import type {
  ModeChange,
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
} from "./shared.js";
import {
  extractCompactionSummarySpans,
  extractCustomContentSpans,
  extractPendingMessageSpans,
} from "./spans.js";
import { parseSystemBSession } from "./systemB.js";
import { activeLeaf, parsePiEntryTree, pathToRoot } from "./tree.js";

function isModeChange(event: SessionEvent): event is ModeChange {
  return event.kind === "modeChange";
}

/** Minimal empty Session for the unreadable/malformed-header tree === null
 * case (System B now gets a real parse via systemB.ts — see the dispatch
 * below — this fallback is only for files tree.ts can't make sense of at
 * all). Recovers id/cwd/startedAt from the raw header line on a
 * best-effort basis. */
function emptySessionFromHeaderLine(
  ref: SessionRef,
  headerLine: string | undefined,
  harnessVersion: string
): Session {
  const { cwd: refCwd, id: refId, mtime: refMtime } = ref;
  let id = refId;
  let cwd = refCwd ?? "";
  let startedAt = refMtime;

  if (headerLine !== undefined) {
    try {
      const parsed: unknown = JSON.parse(headerLine);
      if (isRecord(parsed)) {
        const { cwd: parsedCwd, id: parsedId, timestamp } = parsed;
        if (typeof parsedId === "string") {
          id = parsedId;
        }
        if (typeof parsedCwd === "string") {
          cwd = parsedCwd;
        }
        if (typeof timestamp === "number" || typeof timestamp === "string") {
          startedAt = new Date(timestamp);
        }
      }
    } catch {
      // ignore — fall back to SessionRef-derived defaults below
    }
  }

  return {
    children: [],
    configSnapshot: { model: "", modelChanges: [] },
    cwd,
    endedAt: startedAt,
    events: [],
    harness: "pi",
    harnessVersion,
    id,
    startedAt,
    turns: [],
    warnings: [],
  };
}

export interface ParsePiSessionOptions {
  /** See claude/parse.ts's ParseClaudeSessionOptions — same contract: false
   * skips content-span extraction (turns get contentSpans: []); usage/cost/
   * events/compaction are unaffected. Default true. */
  spans?: boolean;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Harness-version dispatch intentionally preserves tolerant parsing in one pass.
export async function parsePiSession(
  ref: SessionRef,
  opts: ParsePiSessionOptions = {}
): Promise<ParseResult> {
  const spansEnabled = opts.spans ?? true;
  const raw = await readFile(ref.path, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim() !== "");

  const result = parsePiEntryTree(lines);

  if (result.systemB) {
    return parseSystemBSession(ref, lines, spansEnabled);
  }

  if (!result.tree) {
    const session = emptySessionFromHeaderLine(ref, lines[0], "unknown");
    session.warnings = result.warnings;
    return { session, warnings: result.warnings };
  }

  const { header, entries } = result.tree;
  const warnings: ParseWarning[] = [...result.warnings];

  const leafId = activeLeaf(entries);
  const path = leafId === undefined ? [] : pathToRoot(entries, leafId);
  const offPathCount = entries.size - path.length;
  if (offPathCount > 0) {
    warnings.push({
      code: "pi-off-path-branches",
      message: `${offPathCount} entries on unvisited branches`,
    });
  }

  if (header.parentSession !== undefined) {
    warnings.push({
      code: "pi-forked-session",
      message: `session forked from parentSession=${header.parentSession} (SessionRef.parentId is reserved for subagent linkage, not fork lineage — left unset)`,
    });
  }

  const turns: Turn[] = [];
  const events: SessionEvent[] = [];
  let lastKnownModel = "";
  let lastThinkingLevel: string | undefined;
  // Spans held since the last assistant Turn (see spans.ts's ATTACHMENT
  // CONVENTION file-header note) — flushed into the next assistant Turn's
  // contentSpans, or reported as unattached if the path ends before one.
  let pendingSpans: Span[] = [];

  for (const id of path) {
    const entry = entries.get(id);
    if (!entry) {
      continue;
    }

    switch (entry.type) {
      case "message": {
        const built = buildMessageTurn(
          entry,
          lastKnownModel,
          pendingSpans,
          spansEnabled
        );
        if (!built) {
          warnings.push({
            code: "pi-unrecognized-message-role",
            message: "message entry has an unrecognized or missing role",
            recordType: entry.type,
          });
          break;
        }
        turns.push(built.turn);
        if (built.newModel !== undefined) {
          lastKnownModel = built.newModel;
        }
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
      case "thinking_level_change": {
        const rawValue = prop(entry.data, "thinkingLevel");
        const to =
          typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
        events.push({
          at: new Date(entry.timestamp),
          field: "thinkingLevel",
          kind: "modeChange",
          ...(lastThinkingLevel === undefined
            ? {}
            : { from: lastThinkingLevel }),
          to,
        });
        lastThinkingLevel = to;
        break;
      }
      case "model_change": {
        const rawValue = prop(entry.data, "modelId");
        const to =
          typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
        events.push({
          at: new Date(entry.timestamp),
          field: "model",
          kind: "modeChange",
          ...(lastKnownModel === "" ? {} : { from: lastKnownModel }),
          to,
        });
        lastKnownModel = to;
        break;
      }
      case "compaction": {
        events.push(buildCompactionEvent(entry, turns.length));
        // The summary is materialized as fresh input on resend (docs/recon/
        // pi.md: "Compaction context rebuild ... substitute summary") — held
        // pending like any other content so it seeds the next assistant
        // Turn's composition, which is exactly the phase composition.ts
        // resets to at this same turnIndex.
        if (spansEnabled) {
          pendingSpans.push(
            ...extractCompactionSummarySpans(prop(entry.data, "summary"))
          );
        }
        break;
      }
      // custom_message: no Turn (mirrors compaction — pure content, no
      // SessionEvent either), but IS materialized in context per
      // docs/recon/pi.md when display:true, so its content is held pending
      // like any other entry (see spans.ts's extractCustomContentSpans for
      // the "coordination" category decision).
      case "custom_message": {
        if (spansEnabled) {
          pendingSpans.push(
            ...extractCustomContentSpans(
              prop(entry.data, "content"),
              prop(entry.data, "display")
            )
          );
        }
        break;
      }
      // branch_summary/custom/label/session_info: no Turn, no SessionEvent
      // variant fits them, and (per docs/DESIGN.md task scope) no span either
      // — branch_summary plausibly also materializes into context per
      // docs/recon/pi.md's "compactionSummary/branchSummary ROLES appear
      // only in materialized context at read time", but extracting it is
      // out of this task's scope (not in the task's enumerated entry list)
      // and is left for a follow-up rather than silently expanded into.
      case "branch_summary":
      case "custom":
      case "label":
      case "session_info":
        break;
      default:
        // Unknown entry type — tree.ts already emitted "pi-unknown-entry-type".
        break;
    }
  }

  if (pendingSpans.length > 0) {
    // Trailing content after the last assistant Turn has no Turn to attach
    // to (see spans.ts file header) — surfaced, not silently dropped,
    // mirroring claude/parse.ts's "trailing-user-content-unattached".
    warnings.push({
      code: "pi-trailing-content-unattached",
      message: `${pendingSpans.length} span(s) from trailing pi entries after the last assistant turn are not attached to any Turn`,
    });
  }

  const lastPathId = path.at(-1);
  const lastEntry =
    lastPathId === undefined ? undefined : entries.get(lastPathId);
  const endedAt = lastEntry
    ? new Date(lastEntry.timestamp)
    : new Date(header.timestamp);

  const session: Session = {
    children: [],
    configSnapshot: {
      model: lastKnownModel,
      modelChanges: events
        .filter(isModeChange)
        .filter((event) => event.field === "model"),
    },
    cwd: header.cwd,
    endedAt,
    events,
    harness: "pi",
    harnessVersion:
      header.version === undefined ? "unknown" : String(header.version),
    id: header.id,
    startedAt: new Date(header.timestamp),
    turns,
    warnings,
  };

  return { session, warnings };
}
