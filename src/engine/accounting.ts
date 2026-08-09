// Accounting / cost engine (T2.2) — docs/DESIGN.md § "Accounting rules" rule 4.
//
// No network: standing worker rule 2 ("no network in library code; pricing refresh is an
// explicit opt-in command path") still holds — nothing here ever calls
// pricing/modelsDev.ts's fetchModelsDevPricing. What DOES happen here: when the vendored
// LiteLLM snapshot (lookupModelPrice) misses, priceTurn falls through to
// lookupWithFallback against a models.dev snapshot that `peek pricing refresh` already
// cached to disk (pricing/modelsDev.ts's loadCachedModelsDevSnapshot) — a lazy, synchronous,
// memoized local file read, not a network call. A model missing from BOTH tiers still degrades
// to the 2x-input-hardcode / unknown-model paths below exactly as before.
//
// Precondition: callers MUST run dedup.ts's dedupTurns() over a session's turns before pricing
// (accounting rule 2: "dedup precedes all aggregation" — model/types.ts Session invariant).
// priceSession does not dedup for you.

import type {
  CostBreakdown,
  NormalizedUsage,
  Session,
  Turn,
} from "../model/types.js";
import { type ModelPrice, lookupModelPrice } from "../pricing/lookup.js";
import {
  loadCachedModelsDevSnapshot,
  lookupWithFallback,
} from "../pricing/modelsDev.js";

export interface AccountingOptions {
  mode: "display" | "auto" | "calculate";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function zeroCost(mode: CostBreakdown["mode"], priced: boolean): CostBreakdown {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    total: 0,
    mode,
    priced,
  };
}

/**
 * Claude Code logs a precomputed dollar figure on some raw records as `costUSD`. When present,
 * that's the display-mode source of truth; we don't have a per-component breakdown for it (the
 * harness only logs the total), so the four component fields are zeroed and `total` carries the
 * whole figure.
 */
function claudeDisplayCost(
  turn: Turn,
  mode: CostBreakdown["mode"],
): CostBreakdown | undefined {
  const raw = asRecord(turn.usage.raw);
  const costUSD = raw?.costUSD;
  if (typeof costUSD !== "number" || !Number.isFinite(costUSD))
    return undefined;
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    total: costUSD,
    mode,
    priced: true,
  };
}

const PROVIDER_PREFIX_RE = /^[a-z0-9_.]+\//i;

export type ProviderTieringFamily = "marginal" | "wholeRequest" | "none";

/**
 * Infers which long-context tiering shape a model's provider uses, from the model id alone
 * (per the task spec: claude* -> marginal, gpt* / o* / codex* -> whole-request, anything else ->
 * none). Only consulted when the resolved ModelPrice actually carries a `tiering` block —
 * models without any "*_above_200k_tokens" fields in the snapshot never reach this check.
 */
export function inferProviderFamily(modelId: string): ProviderTieringFamily {
  const bare = modelId.replace(PROVIDER_PREFIX_RE, "");
  if (/^claude/i.test(bare)) return "marginal";
  if (/^(gpt|o|codex)/i.test(bare)) return "wholeRequest";
  return "none";
}

interface ComponentPricing {
  tokens: number;
  baseRate: number;
  tierRate: number;
}

/**
 * Anthropic-style MARGINAL split: components are treated as if laid end-to-end in the fixed
 * order they're passed (mirroring the contextTotal invariant's own component order:
 * inputUncached, cacheRead, cacheWrite5m, cacheWrite1h) and the threshold cuts across that
 * concatenation. Tokens before the cut bill at `baseRate`, tokens after at `tierRate`. At
 * exactly the threshold, everything is still "before" (>, not >=, matching the snapshot's
 * "above_200k_tokens" field naming).
 */
function splitMarginal(
  components: readonly ComponentPricing[],
  thresholdTokens: number,
): number[] {
  let offset = 0;
  const costs: number[] = [];
  for (const c of components) {
    const belowTokens = Math.max(
      0,
      Math.min(c.tokens, thresholdTokens - offset),
    );
    const aboveTokens = c.tokens - belowTokens;
    costs.push(belowTokens * c.baseRate + aboveTokens * c.tierRate);
    offset += c.tokens;
  }
  return costs;
}

/**
 * Computes a priced CostBreakdown for a turn's usage against a resolved ModelPrice. Exported
 * (in addition to priceTurn) so tests can exercise tiering/fallback math directly against
 * synthetic ModelPrice fixtures without needing a matching snapshot entry.
 *
 * Fallback rules (DESIGN.md rule 4 + task spec):
 *   - cacheRead: price.cacheRead ?? 0 (no hardcode specified when absent — treated as unpriced,
 *     i.e. free, since the snapshot simply doesn't carry a cache-read cost for that model).
 *   - cacheWrite5m: price.cacheCreation5m ?? price.input * 1.25 (Anthropic's public 5m-TTL
 *     cache-write multiplier).
 *   - cacheWrite1h: price.cacheCreation1h ?? price.input * 2.0 (PLAN's hardcode rule — the case
 *     this is actually expected to trigger for, since the 1h field is the one commonly absent).
 *
 * Tiering: only applied when `price.tiering` is non-null AND the model's inferred provider
 * family recognizes a tiering shape AND turn.contextTotal exceeds the tier threshold.
 *   - wholeRequest (gpt* / o* / codex*): every component switches entirely to its tier rate (or the
 *     base rate, if that specific tier field is absent) once contextTotal crosses the threshold.
 *   - marginal (claude*): the four context-total components split at the threshold per
 *     splitMarginal above. `output` has no "before/after" concept against the *input*-side
 *     threshold — Anthropic's real long-context pricing switches the whole request's output
 *     rate once the request's context crossed 200k, so output bills entirely at the tier rate
 *     (or base, if absent) rather than being split.
 */
export function calculateCost(
  turn: Pick<Turn, "usage" | "contextTotal" | "model">,
  price: ModelPrice,
  mode: CostBreakdown["mode"],
): CostBreakdown {
  const usage: NormalizedUsage = turn.usage;
  const base5m = price.cacheCreation5m ?? price.input * 1.25;
  const base1h = price.cacheCreation1h ?? price.input * 2.0;
  const baseCacheRead = price.cacheRead ?? 0;

  const family = price.tiering ? inferProviderFamily(turn.model) : "none";
  const threshold = price.tiering?.thresholdTokens;
  const overThreshold =
    price.tiering !== null &&
    threshold !== undefined &&
    turn.contextTotal > threshold;

  let input: number;
  let output: number;
  let cacheRead: number;
  let cacheWrite5m: number;
  let cacheWrite1h: number;

  if (family === "wholeRequest" && overThreshold && price.tiering) {
    const t = price.tiering;
    input = usage.inputUncached * (t.input ?? price.input);
    output = usage.output * (t.output ?? price.output);
    cacheRead = usage.cacheRead * (t.cacheRead ?? baseCacheRead);
    cacheWrite5m = usage.cacheWrite5m * (t.cacheCreation5m ?? base5m);
    cacheWrite1h = usage.cacheWrite1h * (t.cacheCreation1h ?? base1h);
  } else if (
    family === "marginal" &&
    overThreshold &&
    price.tiering &&
    threshold !== undefined
  ) {
    const t = price.tiering;
    const [inputCost, cacheReadCost, cache5mCost, cache1hCost] = splitMarginal(
      [
        {
          tokens: usage.inputUncached,
          baseRate: price.input,
          tierRate: t.input ?? price.input,
        },
        {
          tokens: usage.cacheRead,
          baseRate: baseCacheRead,
          tierRate: t.cacheRead ?? baseCacheRead,
        },
        {
          tokens: usage.cacheWrite5m,
          baseRate: base5m,
          tierRate: t.cacheCreation5m ?? base5m,
        },
        {
          tokens: usage.cacheWrite1h,
          baseRate: base1h,
          tierRate: t.cacheCreation1h ?? base1h,
        },
      ],
      threshold,
    );
    input = inputCost ?? 0;
    cacheRead = cacheReadCost ?? 0;
    cacheWrite5m = cache5mCost ?? 0;
    cacheWrite1h = cache1hCost ?? 0;
    output = usage.output * (t.output ?? price.output);
  } else {
    input = usage.inputUncached * price.input;
    output = usage.output * price.output;
    cacheRead = usage.cacheRead * baseCacheRead;
    cacheWrite5m = usage.cacheWrite5m * base5m;
    cacheWrite1h = usage.cacheWrite1h * base1h;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite5m,
    cacheWrite1h,
    total: input + output + cacheRead + cacheWrite5m + cacheWrite1h,
    mode,
    priced: true,
  };
}

/**
 * Prices a single Turn per DESIGN.md rule 4's three modes.
 *
 *   - "calculate": always computes from tokens x the pricing table — ignores any precomputed
 *     cost the adapter attached, even if present.
 *   - "display": returns a logged precomputed cost verbatim when the adapter surfaced one
 *     (pi's parse-time display CostBreakdown, or Claude's raw.costUSD); otherwise zeros with
 *     priced:false.
 *   - "auto" (default): same precomputed-cost search as "display"; falls through to "calculate"
 *     when nothing is found.
 *
 * Mode-field convention: when priceTurn returns an EXISTING CostBreakdown verbatim (pi's
 * already-priced display-mode object), its own `mode` field is preserved unchanged — it stays
 * "display" even under an "auto" request, since that's literally what pi's parser recorded and
 * relabeling it would misrepresent the source. Every OTHER path here constructs a fresh
 * CostBreakdown, and that fresh object's `mode` is set to the requested `opts.mode` ("mode
 * preserved" per the task spec) — including the unknown-model and auto-fallthrough-to-calculate
 * cases, so a caller can always tell what was asked for even when priced:false.
 *
 * Never throws: an unresolvable model id degrades to zeros with priced:false.
 */
export function priceTurn(turn: Turn, opts: AccountingOptions): CostBreakdown {
  const { mode } = opts;

  if (mode !== "calculate") {
    if (turn.cost.mode === "display" && turn.cost.priced) {
      return turn.cost;
    }
    const claudeCost = claudeDisplayCost(turn, mode);
    if (claudeCost) return claudeCost;
    if (mode === "display") return zeroCost("display", false);
    // mode === "auto" with nothing precomputed: fall through to calculate below.
  }

  const price = resolveModelPrice(turn.model);
  if (!price) return zeroCost(mode, false);
  return calculateCost(turn, price, mode);
}

/** LiteLLM snapshot first, then the cached models.dev fallback (DESIGN.md rule 4's two-tier
 * pricing lookup) — see file header for why the fallback tier is still "no network" here. */
function resolveModelPrice(modelId: string): ModelPrice | null {
  return (
    lookupModelPrice(modelId) ??
    lookupWithFallback(modelId, {
      modelsDevSnapshot: loadCachedModelsDevSnapshot(),
    })
  );
}

/**
 * Prices every turn in a session. Callers must have already run dedup.ts's dedupTurns() over
 * session.turns (accounting rule 2) — this function does not dedup.
 *
 * CompactionEvent.cost is left exactly as the adapter set it. Adapters attach a usage-derived
 * cost only when they have real per-compaction token/dollar data to work from (currently: pi,
 * via its own display-cost math at parse time — see adapters/pi/parse.ts's buildDisplayCost).
 * Other adapters (claude, codex) set it to null because a CompactionEvent carries only
 * before/after context totals, not a NormalizedUsage-shaped breakdown accounting.ts could price
 * against — there's nothing here for this function to compute.
 */
export function priceSession(
  session: Session,
  opts: AccountingOptions,
): Session {
  return {
    ...session,
    turns: session.turns.map((turn) => ({
      ...turn,
      cost: priceTurn(turn, opts),
    })),
  };
}

export interface SessionTotals {
  tokens: {
    inputUncached: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
    contextTotal: number;
  };
  cost: number;
  /**
   * false if ANY turn in the session is unpriced (CostBreakdown.priced === false). Deliberate
   * all-or-nothing choice: a partial dollar total (e.g. "$4.12" that silently excludes three
   * turns priced at an unresolvable model) reads as complete when it isn't. Downstream
   * commands (list/cost, T3.1) should treat `cost` as informative-only and show a "partial" /
   * "incomplete" indicator whenever priced is false, rather than presenting it as the total.
   */
  priced: boolean;
}

/** Rollup helper used by later list/cost commands (T3.1). Does not dedup or price — call
 * priceSession first if turns aren't already priced. */
export function sessionTotals(session: Session): SessionTotals {
  const tokens = {
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    contextTotal: 0,
  };
  let cost = 0;
  let priced = true;

  for (const turn of session.turns) {
    tokens.inputUncached += turn.usage.inputUncached;
    tokens.cacheRead += turn.usage.cacheRead;
    tokens.cacheWrite5m += turn.usage.cacheWrite5m;
    tokens.cacheWrite1h += turn.usage.cacheWrite1h;
    tokens.output += turn.usage.output;
    tokens.contextTotal += turn.contextTotal;
    cost += turn.cost.total;
    if (!turn.cost.priced) priced = false;
  }

  return { tokens, cost, priced };
}
