// `peek diff` (T5.1b) — docs/DESIGN.md § "CLI surface": "README headline:
// totals/composition/cost/compactions/config deltas" + `--last N`'s
// zero-argument selection algorithm (audits R3-P1, R3-F3; generalized from
// v1's fixed `--last 2` to `--last <n>` (2..5) in v2, Lane F5).
//
// engine/diff.ts (T5.1a, DONE) owns the comparison math (diffSessions) and
// the pure `--last N` selection primitive (selectLastComparable) — this file
// owns argument parsing, session resolution/loading, and printing only, per
// that module's own file header. Consumed, not modified in shape (only its
// generalized `take`/`refs` surface, per that file's own v2 update).
//
// Two halves, same separation as commands/context.ts / commands/list.ts:
//   - buildDiffReport: PURE, SessionDiff -> report structure (labels +
//     raw values, "honesty convention" throughout). What
//     test/unit/diff-command.test.ts snapshots. Used for the N=2 case.
//   - buildDiffLastNReport: PURE, Session[] -> compact pairwise-vs-first
//     report structure, used for the N>2 case (v2, Lane F5) — see its own
//     doc comment below.
//   - loadDiffSession / resolveLastN / runDiffCommand: I/O (discovery,
//     parse, stdout).
//
// Pipeline per diffSessions' documented precondition (engine/diff.ts file
// header): parse -> dedupSession -> computeComposition -> finalizeCompactions
// -> priceSession. commands/shared.ts's parseAndDedup covers parse +
// dedupSession only (its own file header explains why composition/pricing
// are skipped for list/cost/compactions); the remaining three stages are
// added locally in loadDiffSession below — shared.ts is not modified.

import { existsSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { priceSession, sessionTotals } from "../engine/accounting.js";
import { finalizeCompactions } from "../engine/compaction.js";
import { computeComposition } from "../engine/composition.js";
import {
  diffSessions,
  type SelectLastComparableOptions,
  type SelectLastComparableResult,
  type SessionDiff,
  type SessionDiffCompactions,
  type SessionDiffComposition,
  type SessionDiffConfig,
  type SessionDiffCost,
  type SessionDiffMeta,
  type SessionDiffTotals,
  selectLastComparable,
} from "../engine/diff.js";
import type {
  CompositionCategory,
  HarnessId,
  Session,
  SessionRef,
} from "../model/types.js";
import { serializeJSON } from "../render/json.js";
import { formatNumber, renderTable } from "../render/table.js";
import { RESIDUAL_LABEL } from "./context.js";
import {
  type DiscoverAllOptions,
  discoverAll,
  formatCost,
  parseAndDedup,
  parseHarnessOption,
  type ResolveOptions,
  resolveSessionRef,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Report structure — pure, JSON-serializable.
// ---------------------------------------------------------------------------

export interface DiffMetaColumn {
  durationLabel: string;
  durationMs: number;
  harness: HarnessId;
  harnessVersion: string;
  id: string;
  modelLabel: string;
  models: string[];
  turns: number;
}

export type DiffTokenClass =
  | "inputUncached"
  | "cacheRead"
  | "cacheWrite5m"
  | "cacheWrite1h"
  | "output";

export interface DiffTotalsRow {
  a: number;
  aLabel: string;
  b: number;
  bLabel: string;
  delta: number;
  deltaLabel: string; // signed
  pct: number | null;
  pctLabel: string; // signed, or "—" when pct is null
  tokenClass: DiffTokenClass;
  tokenClassLabel: string;
}

export interface DiffCostLine {
  a: number;
  aLabel: string; // "—" unless bothPriced (honesty convention)
  b: number;
  bLabel: string;
  bothPriced: boolean;
  delta: number;
  deltaLabel: string;
  pct: number | null;
  pctLabel: string;
}

export interface DiffCompositionRow {
  a: number;
  aLabel: string;
  b: number;
  bLabel: string;
  category: CompositionCategory | "residual";
  categoryLabel: string;
  delta: number;
  deltaLabel: string;
  /** Set only on the residual row (RESIDUAL_LABEL, verbatim per PLAN). */
  label?: string;
}

export interface DiffCompactionsBlock {
  countA: number;
  countB: number;
  discardedEstA: number | null;
  discardedEstB: number | null;
  discardedEstLabelA: string; // "~"-prefixed estimate, or "unknown"
  discardedEstLabelB: string;
  shrinkTotalA: number | null;
  shrinkTotalB: number | null;
  shrinkTotalLabelA: string; // exact ("headline" number per PLAN), or "unknown"
  shrinkTotalLabelB: string;
}

export interface DiffReport {
  compactions: DiffCompactionsBlock;
  /** Printed prominently at the TOP when non-empty — PLAN's "⚠ these
   * sessions diverge strongly on ..." requirement. */
  comparabilityWarnings: string[];
  /** Non-zero categories only (a!==0 || b!==0), declaration order. */
  composition: DiffCompositionRow[];
  /** "model changed? version changed? systemPrompt same/differs/unknown"
   * (+ projectInstructions, same convention) — one line per config field. */
  config: string[];
  cost: DiffCostLine;
  meta: { a: DiffMetaColumn; b: DiffMetaColumn };
  /** Always present, regardless of whether it's zero. */
  residual: DiffCompositionRow;
  totals: DiffTotalsRow[];
}

// ---------------------------------------------------------------------------
// Formatting helpers — diff-specific (signed deltas), local to this command.
// ---------------------------------------------------------------------------

/** "1234" -> "+1,234"; "-1234" -> "-1,234" (formatNumber already signs
 * negatives); "0" -> "0" (no bare "+0"). */
function formatSigned(n: number): string {
  if (n === 0) {
    return "0";
  }
  return n > 0 ? `+${formatNumber(n)}` : formatNumber(n);
}

/** Same signed convention as formatSigned, over a dollar amount via
 * shared.ts's formatCost (which already signs negatives). */
function formatSignedCost(usd: number): string {
  if (usd === 0) {
    return formatCost(0);
  }
  return usd > 0 ? `+${formatCost(usd)}` : formatCost(usd);
}

/** null -> "—" (the same zero-guard TokenClassDelta.pct/SessionDiffCost.pct
 * document: "a percentage-of-zero has no honest value"). */
function formatSignedPct(pct: number | null): string {
  if (pct === null) {
    return "—";
  }
  const value = pct * 100;
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

/** ms -> "1h23m" / "4m05s" / "12s" (no sub-second precision — session
 * durations are always seconds-plus at minimum). */
function formatDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const totalSeconds = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${sign}${h}h${m}m`;
  }
  if (m > 0) {
    return `${sign}${m}m${s}s`;
  }
  return `${sign}${s}s`;
}

/** "userText" -> "user text", "cacheWrite5m" columns use their own literal
 * labels (TOKEN_CLASS_LABELS) rather than this — this is for
 * CompositionCategory keys only, which are always camelCase. */
function humanizeCategory(category: string): string {
  return category.replace(/([A-Z])/g, " $1").toLowerCase();
}

// ---------------------------------------------------------------------------
// buildDiffReport — pure, SessionDiff -> DiffReport.
// ---------------------------------------------------------------------------

function buildMetaColumn(meta: SessionDiffMeta): DiffMetaColumn {
  return {
    durationLabel: formatDuration(meta.durationMs),
    durationMs: meta.durationMs,
    harness: meta.harness,
    harnessVersion: meta.harnessVersion,
    id: meta.id,
    modelLabel: meta.models.join(" + "),
    models: meta.models,
    turns: meta.turns,
  };
}

const TOKEN_CLASS_ORDER: readonly DiffTokenClass[] = [
  "inputUncached",
  "cacheRead",
  "cacheWrite5m",
  "cacheWrite1h",
  "output",
];

const TOKEN_CLASS_LABELS: Record<DiffTokenClass, string> = {
  cacheRead: "cache read",
  cacheWrite1h: "cache write (1h)",
  cacheWrite5m: "cache write (5m)",
  inputUncached: "input (uncached)",
  output: "output",
};

function buildTotalsRows(totals: SessionDiffTotals): DiffTotalsRow[] {
  return TOKEN_CLASS_ORDER.map((tokenClass) => {
    const d = totals[tokenClass];
    return {
      a: d.a,
      aLabel: formatNumber(d.a),
      b: d.b,
      bLabel: formatNumber(d.b),
      delta: d.delta,
      deltaLabel: formatSigned(d.delta),
      pct: d.pct,
      pctLabel: formatSignedPct(d.pct),
      tokenClass,
      tokenClassLabel: TOKEN_CLASS_LABELS[tokenClass],
    };
  });
}

function buildCostLine(cost: SessionDiffCost): DiffCostLine {
  if (!cost.bothPriced) {
    return {
      a: cost.a,
      aLabel: "—",
      b: cost.b,
      bLabel: "—",
      bothPriced: false,
      delta: cost.delta,
      deltaLabel: "—",
      pct: cost.pct,
      pctLabel: "—",
    };
  }
  return {
    a: cost.a,
    aLabel: formatCost(cost.a),
    b: cost.b,
    bLabel: formatCost(cost.b),
    bothPriced: true,
    delta: cost.delta,
    deltaLabel: formatSignedCost(cost.delta),
    pct: cost.pct,
    pctLabel: formatSignedPct(cost.pct),
  };
}

// CompositionCategory's declared order (model/types.ts) — re-declared here,
// same convention composition.ts/commands/context.ts each keep privately
// (small, frozen union per PLAN; not exported anywhere in this codebase).
const COMPOSITION_CATEGORY_ORDER: readonly CompositionCategory[] = [
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

function buildCompositionRows(composition: SessionDiffComposition): {
  rows: DiffCompositionRow[];
  residual: DiffCompositionRow;
} {
  const rows: DiffCompositionRow[] = [];
  for (const category of COMPOSITION_CATEGORY_ORDER) {
    const cmp = composition.categories[category];
    if (cmp.a === 0 && cmp.b === 0) {
      continue;
    }
    rows.push({
      a: cmp.a,
      aLabel: `~${formatNumber(cmp.a)}`,
      b: cmp.b,
      bLabel: `~${formatNumber(cmp.b)}`,
      category,
      categoryLabel: humanizeCategory(category),
      delta: cmp.delta,
      deltaLabel: formatSigned(cmp.delta),
    });
  }

  const residual: DiffCompositionRow = {
    a: composition.residual.a,
    // Unprefixed, like ContextResidualRow.tokensLabel — exact total minus Σ
    // estimates, not itself a char/4 read (commands/context.ts convention).
    aLabel: formatNumber(composition.residual.a),
    b: composition.residual.b,
    bLabel: formatNumber(composition.residual.b),
    category: "residual",
    categoryLabel: "residual",
    delta: composition.residual.delta,
    deltaLabel: formatSigned(composition.residual.delta),
    label: RESIDUAL_LABEL,
  };

  return { residual, rows };
}

function exactOrUnknown(value: number | null): string {
  return value === null ? "unknown" : formatNumber(value);
}

function estOrUnknown(value: number | null): string {
  return value === null ? "unknown" : `~${formatNumber(value)}`;
}

function buildCompactionsBlock(
  compactions: SessionDiffCompactions
): DiffCompactionsBlock {
  return {
    countA: compactions.countA,
    countB: compactions.countB,
    discardedEstA: compactions.discardedEstA,
    discardedEstB: compactions.discardedEstB,
    discardedEstLabelA: estOrUnknown(compactions.discardedEstA),
    discardedEstLabelB: estOrUnknown(compactions.discardedEstB),
    shrinkTotalA: compactions.shrinkTotalA,
    shrinkTotalB: compactions.shrinkTotalB,
    shrinkTotalLabelA: exactOrUnknown(compactions.shrinkTotalA),
    shrinkTotalLabelB: exactOrUnknown(compactions.shrinkTotalB),
  };
}

function buildConfigLines(
  config: SessionDiffConfig,
  metaA: SessionDiffMeta,
  metaB: SessionDiffMeta
): string[] {
  return [
    config.modelChanged
      ? `model: changed (${metaA.models.join(" + ")} → ${metaB.models.join(" + ")})`
      : `model: unchanged (${metaA.models.join(" + ")})`,
    config.harnessVersionChanged
      ? `harness version: changed (${metaA.harnessVersion} → ${metaB.harnessVersion})`
      : `harness version: unchanged (${metaA.harnessVersion})`,
    `system prompt: ${config.systemPromptChanged}`,
    `project instructions: ${config.projectInstructionsChanged}`,
  ];
}

/**
 * Builds the full diff report from an already-computed SessionDiff (see
 * engine/diff.ts's diffSessions). Pure; does no I/O.
 */
export function buildDiffReport(diff: SessionDiff): DiffReport {
  const { rows: composition, residual } = buildCompositionRows(
    diff.composition
  );
  return {
    compactions: buildCompactionsBlock(diff.compactions),
    comparabilityWarnings: [...diff.comparability.warnings],
    composition,
    config: buildConfigLines(diff.config, diff.meta.a, diff.meta.b),
    cost: buildCostLine(diff.cost),
    meta: { a: buildMetaColumn(diff.meta.a), b: buildMetaColumn(diff.meta.b) },
    residual,
    totals: buildTotalsRows(diff.totals),
  };
}

// ---------------------------------------------------------------------------
// buildDiffLastNReport — `peek diff --last N` for N>2 (v2, Lane F5): a
// compact pairwise-vs-first table rather than N separate full DiffReports.
// `sessions` MUST already be ordered most-recent-first (sessions[0] = base,
// matching selectLastComparable's `refs` ordering) and each session must
// already satisfy diffSessions' documented precondition (see this file's
// header) — same as buildDiffReport's caller does via loadDiffSession.
// ---------------------------------------------------------------------------

export interface DiffLastNColumn {
  harness: HarnessId;
  id: string;
  modelLabel: string;
}

/** One comparison field group: the base's value, plus one signed delta per
 * older session (index-aligned with DiffLastNReport.others). "unknown" is
 * used instead of a delta wherever the underlying value isn't honestly
 * comparable (unpriced cost, a compaction shrink total that isn't fully
 * known) — same honesty convention as DiffReport's own fields. */
export interface DiffLastNRow {
  baseLabel: string;
  deltaLabels: string[];
  label: string;
}

export interface DiffLastNReport {
  base: DiffLastNColumn;
  /** Per-other-session comparability warnings (base vs that session) — one
   * diffSessions() `comparability.warnings` list per entry in `others`,
   * index-aligned. Empty array = no warnings for that pair. */
  comparabilityWarnings: string[][];
  others: DiffLastNColumn[];
  rows: DiffLastNRow[];
}

/** Same signed convention as formatSigned, applied to a millisecond delta
 * via formatDuration (which already renders an unsigned magnitude). */
function formatSignedDuration(deltaMs: number): string {
  if (deltaMs === 0) {
    return "0s";
  }
  const label = formatDuration(Math.abs(deltaMs));
  return deltaMs > 0 ? `+${label}` : `-${label}`;
}

export function buildDiffLastNReport(sessions: Session[]): DiffLastNReport {
  const [base] = sessions;
  if (!base || sessions.length < 2) {
    throw new Error("buildDiffLastNReport requires at least 2 sessions");
  }
  const olderSessions = sessions.slice(1);
  const diffs = olderSessions.map((s) => diffSessions(base, s));
  const baseTotals = sessionTotals(base);

  const baseColumn: DiffLastNColumn = {
    harness: base.harness,
    id: base.id,
    modelLabel: (diffs[0]?.meta.a.models ?? [base.configSnapshot.model]).join(
      " + "
    ),
  };
  const others: DiffLastNColumn[] = diffs.map((d) => ({
    harness: d.meta.b.harness,
    id: d.meta.b.id,
    modelLabel: d.meta.b.models.join(" + "),
  }));
  const comparabilityWarnings = diffs.map((d) => [...d.comparability.warnings]);

  const rows: DiffLastNRow[] = [];

  rows.push({
    baseLabel: formatNumber(diffs[0]?.meta.a.turns ?? base.turns.length),
    deltaLabels: diffs.map((d) =>
      formatSigned(d.meta.b.turns - d.meta.a.turns)
    ),
    label: "turns",
  });
  rows.push({
    baseLabel: formatDuration(
      diffs[0]?.meta.a.durationMs ??
        base.endedAt.getTime() - base.startedAt.getTime()
    ),
    deltaLabels: diffs.map((d) =>
      formatSignedDuration(d.meta.b.durationMs - d.meta.a.durationMs)
    ),
    label: "duration",
  });

  for (const tokenClass of TOKEN_CLASS_ORDER) {
    rows.push({
      baseLabel: formatNumber(diffs[0]?.totals[tokenClass].a ?? 0),
      deltaLabels: diffs.map((d) => formatSigned(d.totals[tokenClass].delta)),
      label: TOKEN_CLASS_LABELS[tokenClass],
    });
  }

  rows.push({
    baseLabel: baseTotals.priced ? formatCost(baseTotals.cost) : "—",
    deltaLabels: diffs.map((d) =>
      d.cost.bothPriced ? formatSignedCost(d.cost.delta) : "—"
    ),
    label: "cost",
  });

  rows.push({
    baseLabel: formatNumber(diffs[0]?.compactions.countA ?? 0),
    deltaLabels: diffs.map((d) =>
      formatSigned(d.compactions.countB - d.compactions.countA)
    ),
    label: "compactions (count)",
  });
  rows.push({
    baseLabel: exactOrUnknown(diffs[0]?.compactions.shrinkTotalA ?? 0),
    deltaLabels: diffs.map((d) =>
      d.compactions.shrinkTotalA === null || d.compactions.shrinkTotalB === null
        ? "unknown"
        : formatSigned(d.compactions.shrinkTotalB - d.compactions.shrinkTotalA)
    ),
    label: "compactions (shrink)",
  });

  return { base: baseColumn, comparabilityWarnings, others, rows };
}

function printDiffLastNReport(report: DiffLastNReport): void {
  const out: string[] = [];

  report.others.forEach((other, i) => {
    const warnings = report.comparabilityWarnings[i] ?? [];
    if (warnings.length === 0) {
      return;
    }
    out.push(
      pc.yellow(pc.bold(`⚠ ${report.base.id} vs ${other.id} diverges on:`))
    );
    for (const warning of warnings) {
      out.push(pc.yellow(`  - ${warning}`));
    }
  });
  if (out.length > 0) {
    out.push("");
  }

  out.push(pc.bold(`peek diff --last ${report.others.length + 1}`));
  out.push(pc.dim(`  base: ${report.base.id} (${report.base.harness})`));
  out.push("");

  const headers = [
    { header: "field" },
    { align: "right" as const, header: "base" },
    ...report.others.map((o) => ({
      align: "right" as const,
      header: `Δ ${o.id}`,
    })),
  ];
  out.push(
    renderTable(
      headers,
      report.rows.map((r) => [r.label, r.baseLabel, ...r.deltaLabels])
    )
  );

  process.stdout.write(`${out.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// I/O — session loading, `--last N` scope resolution, stdout.
// ---------------------------------------------------------------------------

export interface DiffCommandOptions {
  allProjects?: boolean;
  cwd?: string;
  harness?: HarnessId;
  json?: boolean;
  /** 2..5 supported (v2, Lane F5 — generalized from v1's fixed `--last 2`).
   * n===2 renders the full DiffReport; n>2 renders the compact
   * pairwise-vs-first DiffLastNReport (buildDiffLastNReport). */
  last?: number;
  /** Discovery root overrides — test-only escape hatch, same shape as
   * commands/shared.ts's ResolveOptions.roots. */
  roots?: Partial<Record<HarnessId, string[]>>;
}

function findGitRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return;
    }
    dir = parent;
  }
}

/** "current cwd's slug / git repo root" — PLAN's `--last N` default scope.
 * Walks up from `cwd` for a `.git` entry; falls back to `cwd` itself when
 * none is found (e.g. a session run outside any git repo). I/O (fs.existsSync
 * ) — kept separate from buildSelectLastComparableOptions below so that
 * function stays pure and directly testable. */
export function resolveProjectScope(cwd: string): string {
  return findGitRoot(cwd) ?? cwd;
}

/**
 * Pure mapping from `peek diff --last N`'s CLI options onto
 * engine/diff.ts's SelectLastComparableOptions — the "resolving 'current
 * project scope' from the real filesystem is the CLI wrapper's job, not this
 * pure function's" half that selectLastComparable's own doc comment defers
 * to its caller. `scope` is the ALREADY-resolved project-scope value
 * (resolveProjectScope(process.cwd()), or the raw --cwd override) — this
 * function does no filesystem work, so it's directly unit-testable against
 * synthetic SessionRef sets the same way diff-core.test.ts's own
 * selectLastComparable tests are.
 */
export function buildSelectLastComparableOptions(
  opts: Pick<DiffCommandOptions, "cwd" | "allProjects" | "harness">,
  scope: string
): SelectLastComparableOptions {
  const selectOpts: SelectLastComparableOptions = {
    allProjects: Boolean(opts.allProjects),
  };
  if (!opts.allProjects) {
    selectOpts.scopeCwd = opts.cwd ?? scope;
  }
  if (opts.harness !== undefined) {
    selectOpts.harness = opts.harness;
  }
  return selectOpts;
}

/** discoverAll (unfiltered — selectLastComparable does its own scoping) ->
 * buildSelectLastComparableOptions -> selectLastComparable, with `take` set
 * from `options.last` (default 2). Returns a report structure ({refs} or
 * {reason}), never throws and never touches process.exitCode — that's
 * runDiffCommand's job (the runner layer), so this stays testable without
 * process-global side effects. */
async function resolveLastN(
  options: DiffCommandOptions
): Promise<SelectLastComparableResult> {
  const discoverOpts: DiscoverAllOptions = {};
  if (options.roots !== undefined) {
    discoverOpts.roots = options.roots;
  }
  const refs = await discoverAll(discoverOpts);
  const scope = options.cwd ?? resolveProjectScope(process.cwd());
  const selectOpts = buildSelectLastComparableOptions(options, scope);
  selectOpts.take = options.last ?? 2;
  return selectLastComparable(refs, selectOpts);
}

/**
 * parse -> dedupSession -> computeComposition -> finalizeCompactions ->
 * priceSession — diffSessions' documented precondition (see this file's
 * header). shared.ts's parseAndDedup covers the first two stages only.
 */
export async function loadDiffSession(ref: SessionRef): Promise<Session> {
  const { session } = await parseAndDedup(ref);
  const composed = computeComposition(session);
  const finalized = finalizeCompactions(composed);
  return priceSession(finalized, { mode: "auto" });
}

function printDiffReport(report: DiffReport): void {
  const out: string[] = [];

  if (report.comparabilityWarnings.length > 0) {
    out.push(pc.yellow(pc.bold("⚠ these sessions diverge strongly on:")));
    for (const warning of report.comparabilityWarnings) {
      out.push(pc.yellow(`  - ${warning}`));
    }
    out.push("");
  }

  out.push(pc.bold("peek diff"));
  out.push("");

  out.push(
    renderTable(
      [{ header: "field" }, { header: "a" }, { header: "b" }],
      [
        ["id", report.meta.a.id, report.meta.b.id],
        ["harness", report.meta.a.harness, report.meta.b.harness],
        ["version", report.meta.a.harnessVersion, report.meta.b.harnessVersion],
        ["model", report.meta.a.modelLabel, report.meta.b.modelLabel],
        [
          "turns",
          formatNumber(report.meta.a.turns),
          formatNumber(report.meta.b.turns),
        ],
        ["duration", report.meta.a.durationLabel, report.meta.b.durationLabel],
      ]
    )
  );
  out.push("");

  out.push(pc.bold("totals"));
  out.push(
    renderTable(
      [
        { header: "class" },
        { align: "right", header: "a" },
        { align: "right", header: "b" },
        { align: "right", header: "Δ" },
        { align: "right", header: "%" },
      ],
      report.totals.map((r) => [
        r.tokenClassLabel,
        r.aLabel,
        r.bLabel,
        r.deltaLabel,
        r.pctLabel,
      ])
    )
  );
  out.push("");

  out.push(pc.bold("cost"));
  out.push(
    report.cost.bothPriced
      ? `  ${report.cost.aLabel} → ${report.cost.bLabel}   Δ ${report.cost.deltaLabel} (${report.cost.pctLabel})`
      : `  ${pc.dim("— (one or both sessions have unpriced turns)")}`
  );
  out.push("");

  out.push(pc.bold("composition (final turn)"));
  out.push(
    renderTable(
      [
        { header: "category" },
        { align: "right", header: "a" },
        { align: "right", header: "b" },
        { align: "right", header: "Δ" },
      ],
      [...report.composition, report.residual].map((r) => [
        r.categoryLabel,
        r.aLabel,
        r.bLabel,
        r.deltaLabel,
      ])
    )
  );
  out.push(`  ${pc.dim(RESIDUAL_LABEL)}`);
  out.push("");

  out.push(pc.bold("compactions"));
  out.push(
    `  a: ${formatNumber(report.compactions.countA)} compaction(s), shrink ${report.compactions.shrinkTotalLabelA}, discarded ${report.compactions.discardedEstLabelA}`
  );
  out.push(
    `  b: ${formatNumber(report.compactions.countB)} compaction(s), shrink ${report.compactions.shrinkTotalLabelB}, discarded ${report.compactions.discardedEstLabelB}`
  );
  out.push("");

  out.push(pc.bold("config"));
  for (const line of report.config) {
    out.push(`  ${line}`);
  }

  process.stdout.write(`${out.join("\n")}\n`);
}

const LAST_MIN = 2;
const LAST_MAX = 5;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Mutually exclusive CLI modes are validated and dispatched together.
export async function runDiffCommand(
  a: string | undefined,
  b: string | undefined,
  options: DiffCommandOptions
): Promise<void> {
  let refs: SessionRef[];

  if (options.last === undefined) {
    if (a === undefined || b === undefined) {
      throw new Error("peek diff requires <a> <b>, or --last <n>");
    }
    const resolveOpts: ResolveOptions = {};
    if (options.harness !== undefined) {
      resolveOpts.harness = options.harness;
    }
    if (options.cwd !== undefined) {
      resolveOpts.cwd = options.cwd;
    }
    if (options.roots !== undefined) {
      resolveOpts.roots = options.roots;
    }
    refs = await Promise.all([
      resolveSessionRef(a, resolveOpts),
      resolveSessionRef(b, resolveOpts),
    ]);
  } else {
    if (options.last < LAST_MIN || options.last > LAST_MAX) {
      throw new Error(
        `--last must be between ${LAST_MIN} and ${LAST_MAX} (got: ${options.last})`
      );
    }
    if (a !== undefined || b !== undefined) {
      throw new Error("pass either <a> <b> or --last <n>, not both");
    }
    const result = await resolveLastN(options);
    if (!result.refs) {
      process.stdout.write(
        `${result.reason ?? "no comparable session set found"}\n`
      );
      process.exitCode = 2;
      return;
    }
    ({ refs } = result);
  }

  const sessions = await Promise.all(refs.map((ref) => loadDiffSession(ref)));

  if (sessions.length === 2) {
    const [sessionA, sessionB] = sessions as [Session, Session];
    const diff = diffSessions(sessionA, sessionB);
    const report = buildDiffReport(diff);

    if (options.json) {
      process.stdout.write(`${serializeJSON(report)}\n`);
      return;
    }
    printDiffReport(report);
    return;
  }

  const lastNReport = buildDiffLastNReport(sessions);
  if (options.json) {
    process.stdout.write(`${serializeJSON(lastNReport)}\n`);
    return;
  }
  printDiffLastNReport(lastNReport);
}

// ---------------------------------------------------------------------------
// Command registration — the orchestrator wires this into cli.ts.
// ---------------------------------------------------------------------------

function parseLastOption(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--last must be a positive integer (got: ${value})`);
  }
  return n;
}

export function registerDiffCommand(program: Command): void {
  program
    .command("diff [a] [b]")
    .description(
      "Compare two sessions: token/cost/composition/compaction deltas + config changes. " +
        "`--last 2` diffs the two most recent comparable sessions in scope (README headline); " +
        "`--last <n>` (n up to 5) renders a compact pairwise-vs-first table instead."
    )
    .option(
      "--last <n>",
      "diff the last n sessions in scope (2..5; n>2 renders a compact pairwise-vs-first table)",
      parseLastOption
    )
    .option(
      "--harness <harness>",
      "restrict to one harness: claude-code | codex | pi",
      parseHarnessOption
    )
    .option(
      "--cwd <path>",
      "restrict session resolution / --last <n>'s project scope to this working directory"
    )
    .option(
      "--all-projects",
      "widen --last <n>'s project scope across all projects (same harness still required)"
    )
    .option("--json", "emit the full computed structure as JSON")
    .action(
      async (
        a: string | undefined,
        b: string | undefined,
        opts: {
          last?: number;
          harness?: HarnessId;
          cwd?: string;
          allProjects?: boolean;
          json?: boolean;
        }
      ) => {
        try {
          const commandOpts: DiffCommandOptions = { json: Boolean(opts.json) };
          if (opts.last !== undefined) {
            commandOpts.last = opts.last;
          }
          if (opts.harness !== undefined) {
            commandOpts.harness = opts.harness;
          }
          if (opts.cwd !== undefined) {
            commandOpts.cwd = opts.cwd;
          }
          if (opts.allProjects !== undefined) {
            commandOpts.allProjects = Boolean(opts.allProjects);
          }
          await runDiffCommand(a, b, commandOpts);
        } catch (err) {
          process.stderr.write(
            `${err instanceof Error ? err.message : String(err)}\n`
          );
          process.exitCode = 1;
        }
      }
    );
}
