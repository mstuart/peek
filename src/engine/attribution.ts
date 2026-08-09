// Attribution rollups (T2.4) — docs/DESIGN.md CLI surface's `peek cost`
// ("historical attribution: model/tool/MCP server/subagent; cache waste;
// miss-reason spikes") and Positioning's cost-attribution-depth pitch.
//
// PRECONDITION (every function below except bySubagent's own children, which
// carry their precondition via sessionTotals): callers MUST pass a session
// that has already been through dedup.ts's dedupTurns() and accounting.ts's
// priceSession() — token totals would double-count un-deduped streaming-
// split fragments, and cost totals would be zero/undefined on an unpriced
// session. This module does not dedup or price for you (mirrors accounting.ts
// and composition.ts's own documented preconditions).
//
// HONESTY CHOICE (byTool/byMcpServer — read before using either):
//   1. Per-tool COST is never reported. The Anthropic/OpenAI/pi APIs bill a
//      turn's usage as one lump sum; there is no way to know what share of
//      that dollar figure any individual tool call caused. Rather than
//      inventing a proportional split and presenting it as a real number,
//      this module reports token-share ESTIMATES only (char/4 of each
//      tool's spans, the same estimation basis composition.ts uses for every
//      category) and labels them as estimates in the field name
//      (`tokenShareEst`). Exact figures — span/call COUNTS — are reported
//      wherever they're actually exact.
//   2. Per-tool attribution is only as complete as the underlying spans are
//      tagged. `Span.toolName`/`mcpServer` are set on every toolCallArgs
//      span (all three adapters), and on toolResults spans too: codex's
//      items.ts links a result back to its call via `call_id`; pi's
//      toolResult messages carry `toolName` directly; claude-code's
//      spans.ts links a `tool_result`'s `tool_use_id` back to the
//      originating `tool_use` block's name via a session-scoped index (see
//      adapters/claude/spans.ts's buildToolUseIndex). A toolResults span
//      only stays untagged when its tool_use_id/call_id has no matching
//      prior call (orphaned by truncation/replay) — those are summed
//      separately under UNATTRIBUTED_TOOL rather than silently dropped or
//      mis-attributed to whichever tool happens to sort first.

import type { HarnessId, Session, Span, Turn } from "../model/types.js";
import { type SessionTotals, sessionTotals } from "./accounting.js";
import { dedupFamily } from "./dedup.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// byModel
// ---------------------------------------------------------------------------

export interface ModelTokens {
  inputUncached: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  contextTotal: number;
}

export interface ModelAttribution {
  model: string;
  turnCount: number;
  tokens: ModelTokens;
  cost: number;
  /** false if any turn priced under this model was unpriced (CostBreakdown.priced === false) — see accounting.ts's SessionTotals.priced for the same all-or-nothing rationale. */
  priced: boolean;
}

function zeroModelTokens(): ModelTokens {
  return {
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    contextTotal: 0,
  };
}

/** Per-model token + cost rollup, sorted by model id ascending (deterministic). */
export function byModel(session: Session): ModelAttribution[] {
  return byModelFromTurns(session.turns);
}

/** Shared core for byModel/mergeAttribution — see each caller's own doc. */
function byModelFromTurns(turns: readonly Turn[]): ModelAttribution[] {
  const byId = new Map<string, ModelAttribution>();

  for (const turn of turns) {
    let entry = byId.get(turn.model);
    if (!entry) {
      entry = {
        model: turn.model,
        turnCount: 0,
        tokens: zeroModelTokens(),
        cost: 0,
        priced: true,
      };
      byId.set(turn.model, entry);
    }
    entry.turnCount += 1;
    entry.tokens.inputUncached += turn.usage.inputUncached;
    entry.tokens.cacheRead += turn.usage.cacheRead;
    entry.tokens.cacheWrite5m += turn.usage.cacheWrite5m;
    entry.tokens.cacheWrite1h += turn.usage.cacheWrite1h;
    entry.tokens.output += turn.usage.output;
    entry.tokens.contextTotal += turn.contextTotal;
    entry.cost += turn.cost.total;
    if (!turn.cost.priced) entry.priced = false;
  }

  return [...byId.values()].sort((a, b) => a.model.localeCompare(b.model));
}

// ---------------------------------------------------------------------------
// byTool / byMcpServer
// ---------------------------------------------------------------------------

export const UNATTRIBUTED_TOOL = "(unattributed)";

export interface ToolSpanStats {
  chars: number;
  spanCount: number;
}

export interface ToolAttribution {
  toolName: string;
  /** First mcpServer seen tagging this toolName; undefined for built-in (non-MCP) tools and for the UNATTRIBUTED_TOOL bucket. */
  mcpServer?: string;
  toolCallArgs: ToolSpanStats;
  toolResults: ToolSpanStats;
  totalChars: number;
  totalSpanCount: number;
  /** ESTIMATE — ceil(totalChars / 4), the same char/4 basis composition.ts uses. Never a cost figure; see file header. */
  tokenShareEst: number;
}

interface ToolBucket {
  toolName: string;
  mcpServer?: string;
  toolCallArgs: ToolSpanStats;
  toolResults: ToolSpanStats;
}

function zeroSpanStats(): ToolSpanStats {
  return { chars: 0, spanCount: 0 };
}

function isToolSpan(span: Span): boolean {
  return span.category === "toolCallArgs" || span.category === "toolResults";
}

function toolBucketKey(span: Span): string {
  return span.toolName ?? UNATTRIBUTED_TOOL;
}

function foldSpanIntoBucket(bucket: ToolBucket, span: Span): void {
  const stats =
    span.category === "toolCallArgs" ? bucket.toolCallArgs : bucket.toolResults;
  stats.chars += span.charCount;
  stats.spanCount += 1;
  if (bucket.mcpServer === undefined && span.mcpServer !== undefined) {
    bucket.mcpServer = span.mcpServer;
  }
}

function finalizeToolBucket(bucket: ToolBucket): ToolAttribution {
  const totalChars = bucket.toolCallArgs.chars + bucket.toolResults.chars;
  return {
    toolName: bucket.toolName,
    ...(bucket.mcpServer !== undefined ? { mcpServer: bucket.mcpServer } : {}),
    toolCallArgs: bucket.toolCallArgs,
    toolResults: bucket.toolResults,
    totalChars,
    totalSpanCount:
      bucket.toolCallArgs.spanCount + bucket.toolResults.spanCount,
    tokenShareEst: Math.ceil(totalChars / 4),
  };
}

/**
 * Per-tool rollup over every toolCallArgs/toolResults span in the session,
 * keyed by Span.toolName (spans lacking a toolName — see the HONESTY CHOICE
 * note above — are grouped under UNATTRIBUTED_TOOL rather than dropped).
 * Sorted by totalChars descending (biggest contributors first), ties broken
 * by toolName ascending.
 */
export function byTool(session: Session): ToolAttribution[] {
  return byToolFromTurns(session.turns);
}

/** Shared core for byTool/mergeAttribution — see each caller's own doc. */
function byToolFromTurns(turns: readonly Turn[]): ToolAttribution[] {
  const buckets = new Map<string, ToolBucket>();

  for (const turn of turns) {
    for (const span of turn.contentSpans) {
      if (!isToolSpan(span)) continue;
      const key = toolBucketKey(span);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          toolName: key,
          toolCallArgs: zeroSpanStats(),
          toolResults: zeroSpanStats(),
        };
        buckets.set(key, bucket);
      }
      foldSpanIntoBucket(bucket, span);
    }
  }

  return [...buckets.values()]
    .map(finalizeToolBucket)
    .sort(
      (a, b) =>
        b.totalChars - a.totalChars || a.toolName.localeCompare(b.toolName),
    );
}

export interface McpServerAttribution {
  mcpServer: string;
  toolCallArgs: ToolSpanStats;
  toolResults: ToolSpanStats;
  totalChars: number;
  totalSpanCount: number;
  /** ESTIMATE — see byTool's tokenShareEst / the file-header honesty note. */
  tokenShareEst: number;
  /** Distinct tool names seen under this server. */
  tools: string[];
}

/**
 * Per-MCP-server rollup, grouped by Span.mcpServer. Spans without an
 * mcpServer (built-in/non-MCP tools, and untagged claude-code toolResults —
 * see the HONESTY CHOICE note) are excluded entirely: there is no server to
 * attribute them to, and lumping them into a fake "(unattributed)" server
 * bucket would misrepresent MCP usage specifically. Sorted by totalChars
 * descending, ties broken by mcpServer ascending.
 */
export function byMcpServer(session: Session): McpServerAttribution[] {
  return byMcpServerFromTurns(session.turns);
}

/** Shared core for byMcpServer/mergeAttribution — see each caller's own doc. */
function byMcpServerFromTurns(turns: readonly Turn[]): McpServerAttribution[] {
  interface Bucket {
    mcpServer: string;
    toolCallArgs: ToolSpanStats;
    toolResults: ToolSpanStats;
    tools: Set<string>;
  }
  const buckets = new Map<string, Bucket>();

  for (const turn of turns) {
    for (const span of turn.contentSpans) {
      if (!isToolSpan(span) || span.mcpServer === undefined) continue;
      let bucket = buckets.get(span.mcpServer);
      if (!bucket) {
        bucket = {
          mcpServer: span.mcpServer,
          toolCallArgs: zeroSpanStats(),
          toolResults: zeroSpanStats(),
          tools: new Set(),
        };
        buckets.set(span.mcpServer, bucket);
      }
      const stats =
        span.category === "toolCallArgs"
          ? bucket.toolCallArgs
          : bucket.toolResults;
      stats.chars += span.charCount;
      stats.spanCount += 1;
      if (span.toolName !== undefined) bucket.tools.add(span.toolName);
    }
  }

  return [...buckets.values()]
    .map((bucket) => {
      const totalChars = bucket.toolCallArgs.chars + bucket.toolResults.chars;
      return {
        mcpServer: bucket.mcpServer,
        toolCallArgs: bucket.toolCallArgs,
        toolResults: bucket.toolResults,
        totalChars,
        totalSpanCount:
          bucket.toolCallArgs.spanCount + bucket.toolResults.spanCount,
        tokenShareEst: Math.ceil(totalChars / 4),
        tools: [...bucket.tools].sort(),
      };
    })
    .sort(
      (a, b) =>
        b.totalChars - a.totalChars || a.mcpServer.localeCompare(b.mcpServer),
    );
}

// ---------------------------------------------------------------------------
// mergeAttribution — cross-session byModel/byTool/byMcpServer merge
// (docs/DESIGN.md Lane C: `peek cost --all`).
// ---------------------------------------------------------------------------

/**
 * Minimal, local re-read of the same raw.message.id field dedup.ts's private
 * rawMessageId reads (off Turn.usage.raw). Duplicated rather than imported:
 * it's a one-line raw-field read, and mergeAttribution's replay-exclusion
 * below is deliberately independent of dedupFamily's own zeroing — see
 * mergeAttribution's doc comment for why.
 */
function turnMessageId(turn: Turn): string | undefined {
  const message = asRecord(asRecord(turn.usage.raw)?.message);
  const id = message?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export interface MergedAttribution {
  byModel: ModelAttribution[];
  byTool: ToolAttribution[];
  byMcpServer: McpServerAttribution[];
}

/**
 * Merges byModel/byTool/byMcpServer across one or more session families —
 * `peek cost --all`'s cross-session attribution. Each element of `families`
 * is itself a family in dedupFamily/bySubagent's positional precedence order
 * (family[0] = the parent main session, the rest its subagent children —
 * same contract bySubagent already documents). Passing several single-
 * session families (`[[a], [b], [c]]`) is how the `--all` cross-HARNESS
 * merge works: byTool/byMcpServer rows for the same toolName/mcpServer
 * across otherwise-unrelated sessions fold into one bucket exactly like
 * within one family.
 *
 * REPLAY-EXCLUSION (engine review finding, 2026-08-08 — the latent risk this
 * function exists to close): dedup.ts's dedupFamily zeros a cross-file
 * replay turn's usage/cost/contextTotal but DELIBERATELY leaves its
 * contentSpans untouched (zeroOutTurn's doc comment — a replayed session's
 * own, non-family view still needs to show its real content/shape). Folding
 * byTool/byMcpServer straight over dedupFamily's output would therefore
 * silently double-count that replay's tool-call/tool-result spans even
 * though its token/cost contribution is correctly zeroed elsewhere. Rather
 * than detecting an already-zeroed turn after the fact (a zeroed turn's
 * usage/cost signature — all-zero usage, cost.total 0, cost.priced true —
 * isn't reliably distinguishable from a genuinely zero-usage turn, e.g. the
 * isApiErrorMessage records compaction.test.ts's F2-trap case is built
 * around), this function independently replicates dedupFamily's OWN
 * decision (same key — an assistant turn's raw message.id, alone; same
 * precedence — first occurrence wins, family order, family[0] first) and
 * excludes a later replay's turn from the merge ENTIRELY, rather than
 * folding its zeroed usage alongside its unzeroed spans. The "seen" set
 * resets per family (matches dedupFamily's own scope and cost.ts's
 * FAMILY_DEDUP_NOTE: there is no dedup ACROSS separate families, only
 * within one). Non-assistant turns and assistant turns without a raw
 * message.id are never excluded (matches dedupFamily's own scope).
 *
 * PRECONDITION: same as every function in this file — each session must
 * already be per-file deduped (dedup.ts's dedupSession) and priced.
 */
export function mergeAttribution(
  families: readonly (readonly Session[])[],
): MergedAttribution {
  const canonicalTurns: Turn[] = [];

  for (const family of families) {
    const seenMessageId = new Set<string>();
    for (const session of family) {
      for (const turn of session.turns) {
        if (turn.role === "assistant") {
          const messageId = turnMessageId(turn);
          if (messageId !== undefined) {
            if (seenMessageId.has(messageId)) continue;
            seenMessageId.add(messageId);
          }
        }
        canonicalTurns.push(turn);
      }
    }
  }

  return {
    byModel: byModelFromTurns(canonicalTurns),
    byTool: byToolFromTurns(canonicalTurns),
    byMcpServer: byMcpServerFromTurns(canonicalTurns),
  };
}

// ---------------------------------------------------------------------------
// bySubagent
// ---------------------------------------------------------------------------

export interface SubagentAttribution {
  id: string;
  harness: HarnessId;
  totals: SessionTotals;
}

export interface SubagentRollup {
  parent: SessionTotals;
  children: SubagentAttribution[];
  /** Sum of every child's totals (tokens + cost). */
  childrenCombined: SessionTotals;
  /** parent + childrenCombined. */
  combined: SessionTotals;
  /** childrenCombined.cost / combined.cost; 0 when combined.cost is 0 (avoids NaN, not a claim of zero subagent spend). */
  childCostShare: number;
}

function zeroSessionTotals(): SessionTotals {
  return {
    tokens: {
      inputUncached: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 0,
      contextTotal: 0,
    },
    cost: 0,
    priced: true,
  };
}

function mergeSessionTotals(a: SessionTotals, b: SessionTotals): SessionTotals {
  return {
    tokens: {
      inputUncached: a.tokens.inputUncached + b.tokens.inputUncached,
      cacheRead: a.tokens.cacheRead + b.tokens.cacheRead,
      cacheWrite5m: a.tokens.cacheWrite5m + b.tokens.cacheWrite5m,
      cacheWrite1h: a.tokens.cacheWrite1h + b.tokens.cacheWrite1h,
      output: a.tokens.output + b.tokens.output,
      contextTotal: a.tokens.contextTotal + b.tokens.contextTotal,
    },
    cost: a.cost + b.cost,
    priced: a.priced && b.priced,
  };
}

/**
 * Rolls up child-subagent totals against their parent. `sessions[0]` is the
 * parent; every remaining element is a parsed child session (this module
 * doesn't correlate SubagentSpawn events to child files — the caller is
 * expected to have already resolved which parsed sessions are this parent's
 * children, e.g. via Session.children's SessionRefs). Each session must
 * already be deduped + priced (module precondition); sessionTotals()
 * (accounting.ts) does the actual per-session summing.
 *
 * Routes every session through dedup.ts's dedupFamily() first (T2.5
 * reconciliation follow-up) — subagent files can replay parent-session
 * messages (same message.id, sometimes same requestId), which per-file
 * dedup can't see; dedupFamily zeros out the later-file replay's usage/cost
 * so it doesn't inflate this rollup. sessions[0] is dedupFamily's canonical
 * (parent) member too — same positional contract as this function already
 * has, so the two line up without extra bookkeeping.
 */
export function bySubagent(sessions: readonly Session[]): SubagentRollup {
  const [parentSession, ...childSessions] = dedupFamily(sessions);
  if (!parentSession) {
    throw new Error(
      "bySubagent: sessions must be non-empty (sessions[0] is the parent)",
    );
  }

  const parent = sessionTotals(parentSession);
  const children: SubagentAttribution[] = childSessions.map((child) => ({
    id: child.id,
    harness: child.harness,
    totals: sessionTotals(child),
  }));
  const childrenCombined = children.reduce(
    (acc, child) => mergeSessionTotals(acc, child.totals),
    zeroSessionTotals(),
  );
  const combined = mergeSessionTotals(parent, childrenCombined);
  const childCostShare =
    combined.cost > 0 ? childrenCombined.cost / combined.cost : 0;

  return { parent, children, childrenCombined, combined, childCostShare };
}

// ---------------------------------------------------------------------------
// cacheAnalysis
// ---------------------------------------------------------------------------

export interface CacheTotals {
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  inputUncached: number;
}

export interface CacheMissEntry {
  turnIndex: number;
  timestamp: Date;
  /** `diagnostics.cache_miss_reason.type` when present and a string (e.g. "system_changed"). */
  type?: string;
  /** `diagnostics.cache_miss_reason.cache_missed_input_tokens` when present and a number. */
  cacheMissedInputTokens?: number;
  raw: unknown;
}

export interface CacheAnalysis {
  totals: CacheTotals;
  /** cacheRead / (cacheRead + inputUncached + cacheWrite5m + cacheWrite1h); 0 when that denominator is 0. */
  hitRate: number;
  /** Turns carrying a Turn.cacheMissReason, in turn order — the "miss-reason spikes" data for `peek cost`. */
  missReasons: CacheMissEntry[];
}

/**
 * Cache-read vs. cache-write vs. uncached-input totals and hit rate, plus
 * the list of turns whose raw cache_miss_reason diagnostic explains a
 * cache-cost spike (only claude-code currently sets Turn.cacheMissReason;
 * other harnesses simply produce an empty missReasons list).
 */
export function cacheAnalysis(session: Session): CacheAnalysis {
  const totals: CacheTotals = {
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    inputUncached: 0,
  };
  const missReasons: CacheMissEntry[] = [];

  session.turns.forEach((turn: Turn, turnIndex: number) => {
    totals.cacheRead += turn.usage.cacheRead;
    totals.cacheWrite5m += turn.usage.cacheWrite5m;
    totals.cacheWrite1h += turn.usage.cacheWrite1h;
    totals.inputUncached += turn.usage.inputUncached;

    if (turn.cacheMissReason === undefined) return;
    const rec = asRecord(turn.cacheMissReason);
    const type = typeof rec?.type === "string" ? rec.type : undefined;
    const cacheMissedInputTokens =
      typeof rec?.cache_missed_input_tokens === "number"
        ? rec.cache_missed_input_tokens
        : undefined;
    missReasons.push({
      turnIndex,
      timestamp: turn.timestamp,
      ...(type !== undefined ? { type } : {}),
      ...(cacheMissedInputTokens !== undefined
        ? { cacheMissedInputTokens }
        : {}),
      raw: turn.cacheMissReason,
    });
  });

  const denominator =
    totals.cacheRead +
    totals.inputUncached +
    totals.cacheWrite5m +
    totals.cacheWrite1h;
  const hitRate = denominator > 0 ? totals.cacheRead / denominator : 0;

  return { totals, hitRate, missReasons };
}
