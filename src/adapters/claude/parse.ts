// Claude Code session parser — CORE (T1.4) + spans/compaction (T1.5).
//
// Scope: record dispatch (records.ts) + Session/Turn assembly + usage
// extraction (T1.4), plus content-span extraction (spans.ts) and
// compaction-event anchoring (compaction.ts) wired in below (T1.5). Real
// subagent-CONTENT linking (join key parent toolu_id ↔ child file) remains
// unconfirmed (docs/DESIGN.md § Deferred / limitations ledger item 3) — findChildRefs below is the shipped
// directory-fallback, refs-only.
//
// Turn/span attachment convention (T1.5 design decision — Turn.contentSpans
// is per-assistant-record, per T1.4's header note below, and the frozen
// model has no separate "user turn"): each user record's spans (userText,
// coordination, compactionSummaries, toolResults) are held as "pending" and
// attached to the NEXT assistant Turn's contentSpans, alongside that
// assistant record's own output spans (assistantText/thinking/toolCallArgs).
// This makes each Turn's contentSpans the INCREMENTAL content added at that
// point in the conversation (what the preceding user message contributed +
// what the model produced), which is what composition.ts (T2.3) is expected
// to accumulate across turns to reconstruct a turn's full context — matching
// contextTotal, which is itself cumulative. Trailing user content after the
// last assistant record (no following Turn to attach to) is dropped with a
// "trailing-user-content-unattached" ParseWarning rather than silently lost.
//
// RULE (types.ts): adapters never throw on malformed/unknown records — warn
// and continue. Dedup (T2.1) and composition (T2.3) are downstream engine
// stages; this parser emits ONE Turn per assistant RECORD, including every
// streaming-split fragment, undeduped.

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { contextTotal, normalizeClaudeUsage } from "../../model/normalize.js";
import type {
  Composition,
  CompositionCategory,
  CostBreakdown,
  NormalizedUsage,
  ParseResult,
  ParseWarning,
  Session,
  SessionEvent,
  SessionRef,
  Span,
  Turn,
} from "../../model/types.js";
import { type AnchorableTurn, buildCompactionEvent } from "./compaction.js";
import { type RawClaudeRecord, readClaudeRecords } from "./records.js";
import {
  buildToolUseIndex,
  extractAssistantContentSpans,
  extractUserContentSpans,
} from "./spans.js";

const COMPOSITION_CATEGORIES: readonly CompositionCategory[] = [
  "userText",
  "assistantText",
  "thinking",
  "toolResults",
  "toolCallArgs",
  "instructionInjection",
  "systemPrompt",
  "toolSchemas",
  "compactionSummaries",
  "coordination",
];

function zeroComposition(): Composition {
  const categories = {} as Record<CompositionCategory, number>;
  for (const category of COMPOSITION_CATEGORIES) categories[category] = 0;
  return { categories, residual: 0, residualShare: 0, truncated: false };
}

// T2.2 fills real cost figures; mode "auto" / priced:false marks these as
// not-yet-priced rather than "priced at zero".
function zeroCost(): CostBreakdown {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    total: 0,
    mode: "auto",
    priced: false,
  };
}

function getProp(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  return (obj as Record<string, unknown>)[key];
}

function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** First non-empty string value of `key` across records, in file order. */
function firstStringField(
  records: RawClaudeRecord[],
  key: string,
): string | undefined {
  for (const record of records) {
    const value = record.raw[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * usage.iterations[] walk (docs/recon/claude-code.md § assistant records):
 * exactly 1 element mirrors the top-level totals in every local sample, but
 * multi-element (advisor/fallback) usage must be walked and summed rather
 * than trusting the top-level fields, per ccusage precedent. When present,
 * each iteration is normalized and accumulated; the per-iteration detail
 * survives for attribution because it is nested inside the whole raw record
 * that becomes `usage.raw` below (message.usage.iterations).
 */
function buildTurnUsage(usageRaw: unknown): NormalizedUsage {
  const iterations = getProp(usageRaw, "iterations");
  if (!Array.isArray(iterations) || iterations.length === 0) {
    return normalizeClaudeUsage(usageRaw);
  }

  const acc: NormalizedUsage = {
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    raw: usageRaw,
  };
  for (const iteration of iterations) {
    const normalized = normalizeClaudeUsage(iteration);
    acc.inputUncached += normalized.inputUncached;
    acc.cacheRead += normalized.cacheRead;
    acc.cacheWrite5m += normalized.cacheWrite5m;
    acc.cacheWrite1h += normalized.cacheWrite1h;
    acc.output += normalized.output;
  }
  return acc;
}

/**
 * Builds a Turn from one assistant record. Preserves message.id, requestId,
 * isSidechain, and every other field on the record for downstream
 * attribution/dedup (T2.1) by using the WHOLE raw record — not just the
 * usage sub-object — as `usage.raw` (Turn has no room for these fields
 * directly; types.ts is frozen). `pendingUserSpans` are the spans held over
 * from the user record(s) preceding this one (see file header) — prepended
 * to this record's own output spans.
 */
function buildAssistantTurn(
  record: RawClaudeRecord,
  events: SessionEvent[],
  pendingUserSpans: Span[],
  spansEnabled: boolean,
): Turn {
  const raw = record.raw;
  const message = (raw.message ?? {}) as Record<string, unknown>;
  const model = typeof message.model === "string" ? message.model : "unknown";
  const timestamp = parseTimestamp(raw.timestamp) ?? new Date(0);

  const usage = buildTurnUsage(message.usage);
  usage.raw = raw;

  const contentSpans: Span[] = spansEnabled
    ? [...pendingUserSpans, ...extractAssistantContentSpans(message.content)]
    : [];

  const diagnostics = message.diagnostics;
  const cacheMissReason = getProp(diagnostics, "cache_miss_reason");

  const contextManagement = message.context_management;
  const appliedEdits = getProp(contextManagement, "applied_edits");
  if (Array.isArray(appliedEdits) && appliedEdits.length > 0) {
    events.push({ kind: "contextEdit", at: timestamp, raw: appliedEdits });
  }

  if (raw.isApiErrorMessage === true) {
    events.push({
      kind: "error",
      at: timestamp,
      message: "api-error assistant record",
      raw: { messageId: message.id },
    });
  }

  return {
    role: "assistant",
    model,
    timestamp,
    contentSpans,
    usage,
    contextTotal: contextTotal(usage),
    composition: zeroComposition(), // T2.3 fills real values
    cost: zeroCost(), // T2.2 fills real values
    ...(cacheMissReason !== undefined ? { cacheMissReason } : {}),
  };
}

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Mirrors discover.ts's directory-tree convention for
// `<sessionId>/subagents/agent-<id>.jsonl` (incl. nested
// `subagents/workflows/wf_<id>/...` trees) but scoped to a single ref's
// subagents dir — refs only, never recurses into parsing the children
// (docs/recon/claude-code.md § Subagents; PLAN risk 3: directory fallback,
// no join-key chase).
async function walkSubagentRefs(
  dir: string,
  parentId: string,
  cwd: string,
  refs: SessionRef[],
): Promise<void> {
  for (const entry of await readDirSafe(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkSubagentRefs(full, parentId, cwd, refs);
      continue;
    }
    if (!entry.isFile()) continue;
    const match = /^agent-(.+)\.jsonl$/.exec(entry.name);
    if (!match) continue;
    const id = match[1] as string;
    let info: { size: number; mtime: Date };
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    refs.push({
      harness: "claude-code",
      id,
      path: full,
      cwd,
      sizeBytes: info.size,
      mtime: info.mtime,
      kind: "subagent",
      parentId,
    });
  }
}

async function findChildRefs(
  ref: SessionRef,
  cwd: string,
): Promise<SessionRef[]> {
  const sessionDir = path.join(path.dirname(ref.path), ref.id);
  const refs: SessionRef[] = [];
  await walkSubagentRefs(path.join(sessionDir, "subagents"), ref.id, cwd, refs);
  refs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return refs;
}

/**
 * Offloaded tool-result ids (docs/recon/claude-code.md: `tool-results/*.{pdf,txt}`),
 * derived from a directory listing next to this ref — never from file
 * content (spans.ts must not read the sidecar). Basenames map 1:1 to
 * `tool_use_id` per the offloaded fixture (`toolu-offload-0001.txt` →
 * `toolu-offload-0001`). Same `sessionDir` convention as findChildRefs.
 */
async function computeOffloadedToolIds(ref: SessionRef): Promise<Set<string>> {
  const sessionDir = path.join(path.dirname(ref.path), ref.id);
  const ids = new Set<string>();
  for (const entry of await readDirSafe(
    path.join(sessionDir, "tool-results"),
  )) {
    if (!entry.isFile()) continue;
    const id = entry.name.replace(/\.[^./]+$/, "");
    if (id) ids.add(id);
  }
  return ids;
}

export interface ParseClaudeSessionOptions {
  /** When false, skips content-span extraction entirely: turns get
   * contentSpans: [] (the pre-T1.5 shape) and the offloaded-tool-ids
   * directory listing + tool-use index build (both only feed span
   * extraction) are skipped too. usage/cost/contextTotal/events/compaction
   * are all computed independently of spans and are unaffected. Composition
   * is not computable from an empty contentSpans, but no caller that passes
   * spans:false needs it. Default true — existing callers unchanged. */
  spans?: boolean;
}

export async function parseClaudeSession(
  ref: SessionRef,
  opts: ParseClaudeSessionOptions = {},
): Promise<ParseResult> {
  const spansEnabled = opts.spans ?? true;
  const { records, warnings: readWarnings } = await readClaudeRecords(ref.path);
  const warnings: ParseWarning[] = [...readWarnings];

  const harnessVersion = firstStringField(records, "version") ?? "";
  const cwd = firstStringField(records, "cwd") ?? ref.cwd ?? "";
  const gitBranch = firstStringField(records, "gitBranch");

  let startedAt: Date | undefined;
  let endedAt: Date | undefined;
  for (const record of records) {
    const ts = parseTimestamp(record.raw.timestamp);
    if (!ts) continue;
    if (!startedAt) startedAt = ts;
    endedAt = ts;
  }

  const offloadedToolIds = spansEnabled
    ? await computeOffloadedToolIds(ref)
    : new Set<string>();
  const toolUseIndex = buildToolUseIndex(spansEnabled ? records : []);

  const events: SessionEvent[] = [];
  const turns: Turn[] = [];
  const turnLines: number[] = []; // parallel to turns[]; originating record.line, for compaction anchoring
  let pendingUserSpans: Span[] = [];

  for (const record of records) {
    if (record.type === "user") {
      if (spansEnabled) {
        pendingUserSpans.push(
          ...extractUserContentSpans(record, offloadedToolIds, toolUseIndex),
        );
      }
      continue;
    }
    if (record.type !== "assistant") continue;
    turns.push(
      buildAssistantTurn(record, events, pendingUserSpans, spansEnabled),
    );
    turnLines.push(record.line);
    pendingUserSpans = [];
  }

  if (pendingUserSpans.length > 0) {
    // Trailing user content after the last assistant record has no Turn to
    // attach to (see file header) — surfaced, not silently dropped.
    warnings.push({
      code: "trailing-user-content-unattached",
      message: `${pendingUserSpans.length} span(s) from trailing user record(s) after the last assistant turn are not attached to any Turn`,
    });
  }

  // Second pass: compaction events, anchored against the now-complete turns[]
  // (anchoring needs to look both before AND after the marker's position).
  const anchorTurns: AnchorableTurn[] = turns.map((turn, i) => ({
    line: turnLines[i] as number,
    contextTotal: turn.contextTotal,
    isApiError:
      (turn.usage.raw as Record<string, unknown>).isApiErrorMessage === true,
  }));

  for (const record of records) {
    if (record.type !== "user" || record.raw.isCompactSummary !== true)
      continue;
    const message = record.raw.message;
    const content =
      typeof message === "object" && message !== null
        ? (message as Record<string, unknown>).content
        : undefined;
    const summaryContent =
      typeof content === "string" ? content : JSON.stringify(content ?? "");
    const at = parseTimestamp(record.raw.timestamp) ?? new Date(0);
    events.push(buildCompactionEvent(record, at, summaryContent, anchorTurns));
  }

  const lastTurn = turns.at(-1);
  const children = await findChildRefs(ref, cwd);

  const session: Session = {
    harness: "claude-code",
    harnessVersion,
    id: ref.id,
    cwd,
    ...(gitBranch !== undefined ? { gitBranch } : {}),
    startedAt: startedAt ?? new Date(0),
    endedAt: endedAt ?? startedAt ?? new Date(0),
    configSnapshot: {
      model: lastTurn?.model ?? "unknown",
      modelChanges: [], // "mode"/"permission-mode" record handling is T1.5+
    },
    turns,
    events,
    children,
    warnings,
  };

  return { session, warnings };
}
