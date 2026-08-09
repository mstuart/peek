// Pure aggregation over TrialResult[] (A4 deliverable #2, DESIGN.md § "Lane
// A — `peek bench`" "Output": "prints an A/B table (per task: success a/b,
// median tokens, median cost, compaction counts, deltas)").
//
// No I/O — takes TrialResult[] (already loaded via results.ts), returns a
// fully-computed, already-labeled structure. src/commands/bench.ts renders
// it as a text table (render/table.ts) and reportHtml.ts renders it as HTML;
// neither re-derives any arithmetic here.
//
// Honesty convention (matches engine/accounting.ts's SessionTotals.priced
// and commands/cost.ts's costLabel pattern throughout the codebase): a
// trial's `totals` is absent when its session couldn't be parsed (crashed
// run, unresolved transcript path, adapter parse failure) — those trials
// still count toward trialCount/successCount/medianWallMs (verify pass/fail
// and wall-clock are always known from TrialOutcome), but are excluded from
// the token/cost/compaction medians, and `totalsCount`/`pricedCount` report
// exactly how many trials DID contribute to those medians so a "—" reads as
// "no data" rather than "zero".

import { formatCost } from "../commands/shared.js";
import { formatNumber } from "../render/table.js";
import type { TrialResult } from "./types.js";

// ---------------------------------------------------------------------------
// Median helper.
// ---------------------------------------------------------------------------

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lo = sorted[mid - 1];
    const hi = sorted[mid];
    return lo === undefined || hi === undefined ? null : (lo + hi) / 2;
  }
  const v = sorted[mid];
  return v === undefined ? null : v;
}

// ---------------------------------------------------------------------------
// Formatting — local to this module (same "compute the label alongside the
// value" pattern as commands/cost.ts's buildCostReport).
// ---------------------------------------------------------------------------

function formatWallMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Always formats the ABSOLUTE value and prepends the sign itself, rather
 * than trusting `format` to render a negative input correctly — formatWallMs
 * in particular treats a negative ms as invalid ("—", since a real wall-
 * clock duration can never be negative), which broke a negative WALL DELTA
 * (b faster than a) when this used to just call `format(n)` directly for
 * n < 0 instead of `format(Math.abs(n))`. */
function signedFormat(n: number, format: (n: number) => string): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${format(Math.abs(n))}`;
}

function pctChangeSuffix(a: number, b: number): string {
  if (a === 0) return "";
  const pct = ((b - a) / Math.abs(a)) * 100;
  const sign = pct > 0 ? "+" : "";
  return ` (${sign}${pct.toFixed(1)}%)`;
}

// ---------------------------------------------------------------------------
// Per-cell stats (one task x one config, or an "all tasks" rollup for one
// config — CompareSummaryRow reuses the same shape minus taskName).
// ---------------------------------------------------------------------------

export interface CompareStats {
  trialCount: number;
  successCount: number;
  successRate: number; // 0..1
  successRateLabel: string; // "4/5 (80%)"
  medianWallMs: number; // always known — TrialOutcome.wallMs is never absent
  medianWallLabel: string;
  totalsCount: number; // trials whose session parsed (totals present)
  medianTokens: number | null; // null when totalsCount === 0
  medianTokensLabel: string; // "—" when null
  pricedCount: number; // of totalsCount, how many were priced (real $ figures)
  medianCost: number | null; // null when pricedCount === 0
  medianCostLabel: string;
  compactionTotal: number | null; // sum across the totalsCount trials; null when totalsCount === 0
  compactionTotalLabel: string;
}

function computeStats(trials: readonly TrialResult[]): CompareStats {
  const trialCount = trials.length;
  const successCount = trials.filter((t) => t.verify.passed).length;
  const successRate = trialCount > 0 ? successCount / trialCount : 0;

  const medianWallMs = median(trials.map((t) => t.wallMs)) ?? 0;

  const withTotals = trials.filter(
    (t): t is TrialResult & { totals: NonNullable<TrialResult["totals"]> } =>
      t.totals !== undefined,
  );
  const totalsCount = withTotals.length;
  const medianTokens =
    totalsCount > 0
      ? median(withTotals.map((t) => t.totals.tokens.contextTotal))
      : null;
  const compactionTotal =
    totalsCount > 0
      ? withTotals.reduce((sum, t) => sum + t.totals.compactionCount, 0)
      : null;

  const priced = withTotals.filter((t) => t.totals.priced);
  const pricedCount = priced.length;
  const medianCost =
    pricedCount > 0 ? median(priced.map((t) => t.totals.cost)) : null;

  return {
    trialCount,
    successCount,
    successRate,
    successRateLabel: `${successCount}/${trialCount} (${Math.round(successRate * 100)}%)`,
    medianWallMs,
    medianWallLabel: formatWallMs(medianWallMs),
    totalsCount,
    medianTokens,
    medianTokensLabel: medianTokens === null ? "—" : formatNumber(medianTokens),
    pricedCount,
    medianCost,
    medianCostLabel: medianCost === null ? "—" : formatCost(medianCost),
    compactionTotal,
    compactionTotalLabel:
      compactionTotal === null ? "—" : formatNumber(compactionTotal),
  };
}

export interface CompareCell extends CompareStats {
  taskName: string;
  configName: string;
}

export interface CompareSummaryRow extends CompareStats {
  configName: string;
}

// ---------------------------------------------------------------------------
// Grouping — task x config cells, any number of distinct config names (the
// CLI only ever compares two, but this stays general since it's pure
// aggregation over whatever configNames the results actually carry).
// ---------------------------------------------------------------------------

/** Groups TrialResult[] by (taskName, configName) into one CompareCell per
 * group. Order: tasks in first-seen order, configs in first-seen order
 * within each task. */
export function groupCells(results: readonly TrialResult[]): CompareCell[] {
  const taskOrder: string[] = [];
  const byTask = new Map<string, Map<string, TrialResult[]>>();

  for (const r of results) {
    let byConfig = byTask.get(r.taskName);
    if (!byConfig) {
      byConfig = new Map();
      byTask.set(r.taskName, byConfig);
      taskOrder.push(r.taskName);
    }
    const bucket = byConfig.get(r.configName);
    if (bucket) {
      bucket.push(r);
    } else {
      byConfig.set(r.configName, [r]);
    }
  }

  const cells: CompareCell[] = [];
  for (const taskName of taskOrder) {
    const byConfig = byTask.get(taskName);
    if (!byConfig) continue;
    for (const [configName, trials] of byConfig) {
      cells.push({ taskName, configName, ...computeStats(trials) });
    }
  }
  return cells;
}

/** Aggregates every trial for one configName across ALL tasks — the "overall
 * summary row". */
function summaryFor(
  results: readonly TrialResult[],
  configName: string,
): CompareSummaryRow | null {
  const trials = results.filter((r) => r.configName === configName);
  if (trials.length === 0) return null;
  return { configName, ...computeStats(trials) };
}

// ---------------------------------------------------------------------------
// A-vs-B deltas.
// ---------------------------------------------------------------------------

export interface CompareDeltaRow {
  taskName: string;
  a: CompareStats;
  b: CompareStats;
  successDeltaLabel: string; // percentage points, e.g. "+20pp"
  wallDeltaLabel: string;
  tokensDeltaLabel: string;
  costDeltaLabel: string;
  compactionDeltaLabel: string;
}

function buildDeltaRow(
  taskName: string,
  a: CompareStats,
  b: CompareStats,
): CompareDeltaRow {
  const successDeltaPp = (b.successRate - a.successRate) * 100;
  const successDeltaLabel = `${successDeltaPp > 0 ? "+" : ""}${successDeltaPp.toFixed(1)}pp`;

  const wallDeltaLabel =
    signedFormat(b.medianWallMs - a.medianWallMs, formatWallMs) +
    pctChangeSuffix(a.medianWallMs, b.medianWallMs);

  const tokensDeltaLabel =
    a.medianTokens === null || b.medianTokens === null
      ? "—"
      : signedFormat(b.medianTokens - a.medianTokens, formatNumber) +
        pctChangeSuffix(a.medianTokens, b.medianTokens);

  const costDeltaLabel =
    a.medianCost === null || b.medianCost === null
      ? "—"
      : signedFormat(b.medianCost - a.medianCost, formatCost) +
        pctChangeSuffix(a.medianCost, b.medianCost);

  const compactionDeltaLabel =
    a.compactionTotal === null || b.compactionTotal === null
      ? "—"
      : signedFormat(b.compactionTotal - a.compactionTotal, formatNumber);

  return {
    taskName,
    a,
    b,
    successDeltaLabel,
    wallDeltaLabel,
    tokensDeltaLabel,
    costDeltaLabel,
    compactionDeltaLabel,
  };
}

export interface CompareMissing {
  taskName: string;
  missingConfig: "a" | "b"; // which side (configA/configB) has zero trials for this task
}

export interface CompareTable {
  configA: string;
  configB: string;
  /** Every task x config cell present in the input — ANY config names, not
   * just configA/configB (transparency: a stray/typo'd configName in the
   * results file is still visible here even though it's excluded from
   * `deltas`, which is strictly configA-vs-configB). */
  cells: CompareCell[];
  /** One row per task present in BOTH configA and configB — tasks missing
   * from one side are listed in `missing` instead of silently dropped. */
  deltas: CompareDeltaRow[];
  missing: CompareMissing[];
  /** Grand-total row across all tasks for configA/configB, and their delta —
   * null when either config has zero trials in the input. */
  overall: {
    a: CompareSummaryRow;
    b: CompareSummaryRow;
    delta: CompareDeltaRow;
  } | null;
}

const OVERALL_LABEL = "ALL TASKS";

/** Builds the full A/B comparison table from a flat TrialResult[] (e.g. one
 * results.jsonl's worth, or several concatenated). Pure; no I/O. */
export function buildCompareTable(
  results: readonly TrialResult[],
  configA: string,
  configB: string,
): CompareTable {
  const cells = groupCells(results);

  const byTask = new Map<string, Map<string, CompareCell>>();
  const taskOrder: string[] = [];
  for (const cell of cells) {
    let byConfig = byTask.get(cell.taskName);
    if (!byConfig) {
      byConfig = new Map();
      byTask.set(cell.taskName, byConfig);
      taskOrder.push(cell.taskName);
    }
    byConfig.set(cell.configName, cell);
  }

  const deltas: CompareDeltaRow[] = [];
  const missing: CompareMissing[] = [];
  for (const taskName of taskOrder) {
    const byConfig = byTask.get(taskName);
    const a = byConfig?.get(configA);
    const b = byConfig?.get(configB);
    if (a && b) {
      deltas.push(buildDeltaRow(taskName, a, b));
    } else if (!a) {
      missing.push({ taskName, missingConfig: "a" });
    } else if (!b) {
      missing.push({ taskName, missingConfig: "b" });
    }
  }

  const summaryA = summaryFor(results, configA);
  const summaryB = summaryFor(results, configB);
  const overall =
    summaryA && summaryB
      ? {
          a: summaryA,
          b: summaryB,
          delta: buildDeltaRow(OVERALL_LABEL, summaryA, summaryB),
        }
      : null;

  return { configA, configB, cells, deltas, missing, overall };
}
