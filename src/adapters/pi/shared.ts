// Shared pi System A / System B mapping helpers.
//
// Extracted from parse.ts (T6.3/T6.4) so systemB.ts (Lane D, docs/DESIGN.md § Other v2 subsystems)
// can reuse the exact same message-shape -> Turn/CostBreakdown logic instead
// of duplicating it: docs/recon/pi.md notes System B "entries carry same
// AgentMessage lineage" as System A, so a "message" mutation entry's `message`
// field is structurally interchangeable with a System A "message" tree
// entry's `message` field, and both are handled by buildMessageTurn below.
// Kept in its own module (rather than re-exported from parse.ts) to avoid a
// parse.ts <-> systemB.ts circular import, since parse.ts also calls into
// systemB.ts to run the System B path.

import { contextTotal, normalizePiUsage } from "../../model/normalize.js";
import type {
  CompactionEvent,
  Composition,
  CompositionCategory,
  CostBreakdown,
  Span,
  Turn,
  TurnRole,
} from "../../model/types.js";
import { extractAssistantMessageSpans } from "./spans.js";
import type { PiEntry } from "./tree.js";

const COMPOSITION_CATEGORIES: CompositionCategory[] = [
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function prop(raw: unknown, key: string): unknown {
  if (!isRecord(raw)) return undefined;
  return raw[key];
}

// composition itself is still all-zero here (T2.3's computeComposition,
// run downstream, fills real values) — only contentSpans are populated at
// parse time (T6.4).
export function zeroComposition(): Composition {
  const categories = {} as Record<CompositionCategory, number>;
  for (const category of COMPOSITION_CATEGORIES) categories[category] = 0;
  return { categories, residual: 0, residualShare: 0, truncated: false };
}

export function zeroDisplayCost(): CostBreakdown {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    total: 0,
    mode: "display",
    priced: false,
  };
}

/**
 * pi's precomputed Usage.cost → CostBreakdown (display mode, priced).
 * cost has no per-TTL cache-write split (docs/recon/pi.md: `cost { input;
 * output; cacheRead; cacheWrite; total }`), so when the sibling token-level
 * `cacheWrite1h` is present, cost.cacheWrite is prorated by the token-level
 * 1h share to estimate the 1h dollar portion; cacheWrite5m is the remainder.
 * Mirrors normalizePiUsage's token-level split (cacheWrite5m = cacheWrite −
 * cacheWrite1h) at the dollar level, since no exact per-TTL cost is logged.
 */
export function buildDisplayCost(usageRaw: unknown): CostBreakdown {
  const costRaw = prop(usageRaw, "cost");
  if (!isRecord(costRaw)) return zeroDisplayCost();

  const input = toNumber(prop(costRaw, "input"));
  const output = toNumber(prop(costRaw, "output"));
  const cacheRead = toNumber(prop(costRaw, "cacheRead"));
  const cacheWriteCost = toNumber(prop(costRaw, "cacheWrite"));
  const total = toNumber(prop(costRaw, "total"));

  const tokenCacheWriteTotal = toNumber(prop(usageRaw, "cacheWrite"));
  const cacheWrite1hRaw = prop(usageRaw, "cacheWrite1h");
  const hasCacheWrite1h =
    cacheWrite1hRaw !== undefined && cacheWrite1hRaw !== null;

  let cacheWrite1h = 0;
  let cacheWrite5m = cacheWriteCost;
  if (hasCacheWrite1h && tokenCacheWriteTotal > 0) {
    const tokenCacheWrite1h = toNumber(cacheWrite1hRaw);
    const share = tokenCacheWrite1h / tokenCacheWriteTotal;
    cacheWrite1h = cacheWriteCost * share;
    cacheWrite5m = cacheWriteCost - cacheWrite1h;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite5m,
    cacheWrite1h,
    total,
    mode: "display",
    priced: true,
  };
}

export function mapTurnRole(role: string): TurnRole | undefined {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
    case "bashExecution":
    case "custom":
      return "user";
    default:
      return undefined;
  }
}

export function messageTimestamp(
  entry: PiEntry,
  message: Record<string, unknown>,
): Date {
  const ts = message.timestamp;
  if (typeof ts === "number") return new Date(ts);
  return new Date(entry.timestamp);
}

/**
 * "message" entry (System A tree entry OR System B mutation-log entry,
 * identical `message` shape per docs/recon/pi.md) -> a Turn. See parse.ts's
 * file header for the pendingSpans attachment convention this drives.
 */
export function buildMessageTurn(
  entry: PiEntry,
  lastKnownModel: string,
  pendingSpans: Span[],
  spansEnabled: boolean,
): { turn: Turn; newModel?: string } | undefined {
  const message = prop(entry.data, "message");
  if (!isRecord(message) || typeof message.role !== "string") return undefined;

  const turnRole = mapTurnRole(message.role);
  if (!turnRole) return undefined;

  const timestamp = messageTimestamp(entry, message);

  if (message.role === "assistant") {
    const model =
      typeof message.model === "string" ? message.model : lastKnownModel;
    const usage = normalizePiUsage(message.usage);
    const cost = buildDisplayCost(message.usage);
    // ATTACHMENT CONVENTION (spans.ts file header, mirrors claude/parse.ts):
    // every pending span held since the last assistant Turn — from
    // user/toolResult/bashExecution/custom message entries and from
    // Turn-less entries (compaction, custom_message) — lands here, ahead of
    // this assistant record's own output spans.
    const contentSpans: Span[] = spansEnabled
      ? [...pendingSpans, ...extractAssistantMessageSpans(message.content)]
      : [];
    const turn: Turn = {
      role: "assistant",
      model,
      timestamp,
      contentSpans,
      usage,
      contextTotal: contextTotal(usage),
      composition: zeroComposition(),
      cost,
    };
    return { turn, newModel: model };
  }

  // user / toolResult / bashExecution / embedded custom: no numeric usage
  // extracted (see parse.ts file-header note). raw preserves the message
  // payload — this is where bashExecution's excludeFromContext flag surfaces.
  const usage = normalizePiUsage(undefined);
  usage.raw = message;
  const turn: Turn = {
    role: turnRole,
    model: lastKnownModel,
    timestamp,
    contentSpans: [],
    usage,
    contextTotal: 0,
    composition: zeroComposition(),
    cost: zeroDisplayCost(),
  };
  return { turn };
}

/**
 * "compaction" entry -> CompactionEvent. Reads `tokensBefore`/`summary`/
 * `usage` only — fields common to both System A's compaction tree entry
 * (docs/recon/pi.md: `firstKeptEntryId`) and System B's CompactionEntry
 * (`retainedTail`), neither of which this function touches, so it is safe
 * to share as-is; systemB.ts additionally reads `retainedTail` itself.
 */
export function buildCompactionEvent(
  entry: PiEntry,
  turnIndex: number,
): CompactionEvent {
  const tokensBeforeRaw = prop(entry.data, "tokensBefore");
  const tokensBeforeExact =
    typeof tokensBeforeRaw === "number" ? tokensBeforeRaw : null;

  const summaryRaw = prop(entry.data, "summary");
  const summary = typeof summaryRaw === "string" ? summaryRaw : "";
  const summaryTokensEst = Math.ceil(summary.length / 4);

  const usageRaw = prop(entry.data, "usage");
  const cost =
    isRecord(usageRaw) && isRecord(prop(usageRaw, "cost"))
      ? buildDisplayCost(usageRaw)
      : null;

  return {
    kind: "compaction",
    at: new Date(entry.timestamp),
    turnIndex,
    tokensBeforeExact,
    tokensAfterExact: null, // engine fills from the next turn's contextTotal
    shrinkExact: null, // engine computes (before − after)
    discardedEst: null, // engine computes
    summaryTokensEst,
    cost,
  };
}
