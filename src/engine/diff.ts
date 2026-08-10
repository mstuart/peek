// Session diff engine (T5.1a) — docs/DESIGN.md § "CLI surface" `peek diff`
// entries + § "Unified Session Model" (Composition/CostBreakdown/CompactionEvent).
//
// Pure module: no CLI, no file I/O. The CLI wrapper (a separate later task,
// per T5.1's split) owns argument parsing, session resolution/loading, and
// printing; this module owns the comparison math and the `--last 2`
// selection algorithm only.
//
// Precondition on diffSessions(a, b): both `a` and `b` MUST already have gone
// through the full pipeline — dedupSession -> computeComposition ->
// finalizeCompactions -> priceSession — the same precondition every other
// engine module in this pipeline documents on its own entry point
// (composition.ts, compaction.ts, accounting.ts). diffSessions does not
// dedup, compose, finalize, or price for you, and has no way to detect a
// session that skipped a stage.

import { createHash } from "node:crypto";
import type {
  CompositionCategory,
  HarnessId,
  Session,
  SessionRef,
  Turn,
} from "../model/types.js";
import { type SessionTotals, sessionTotals } from "./accounting.js";

// ---------------------------------------------------------------------------
// diffSessions
// ---------------------------------------------------------------------------

export interface SessionDiffMeta {
  /** endedAt - startedAt, in milliseconds. */
  durationMs: number;
  harness: HarnessId;
  harnessVersion: string;
  id: string;
  /** Distinct models actually seen across session.turns, in first-appearance
   * order (not just configSnapshot.model — configSnapshot.modelChanges
   * documents that a single session can span more than one model, and
   * turn.model is the per-turn source of truth for what was actually used).
   * Falls back to [configSnapshot.model] for a turn-less session. */
  models: string[];
  startedAt: Date;
  turns: number;
}

export interface TokenClassDelta {
  a: number;
  b: number;
  delta: number;
  /** delta / a, or null when a is 0 (a percentage-of-zero has no honest
   * value — left null rather than reported as Infinity/NaN). */
  pct: number | null;
}

export interface SessionDiffTotals {
  cacheRead: TokenClassDelta;
  cacheWrite1h: TokenClassDelta;
  cacheWrite5m: TokenClassDelta;
  inputUncached: TokenClassDelta;
  output: TokenClassDelta;
}

export interface SessionDiffCost {
  a: number;
  b: number;
  /** true only when BOTH sessions' totals are fully priced (accounting.ts's
   * SessionTotals.priced, itself all-or-nothing over every turn) — a partial
   * dollar comparison reads as complete when it isn't, same rationale as
   * SessionTotals.priced's own doc comment. */
  bothPriced: boolean;
  delta: number;
  pct: number | null; // same zero-guard as TokenClassDelta.pct
}

export interface CategoryComparison {
  a: number;
  b: number;
  delta: number;
}

export interface SessionDiffComposition {
  /** Per-category comparison at each session's LAST usage-carrying turn
   * (last turn with contextTotal !== 0 — mirrors compaction.ts's
   * findTokensBefore/findTokensAfter anchoring rule, applied here to "the
   * final composition state" rather than "the state around a compaction
   * marker"). A session with no usage-carrying turn at all (e.g. every turn
   * errored) compares as all-zero on that side — there is nothing to
   * measure, not an error. */
  categories: Record<CompositionCategory, CategoryComparison>;
  residual: CategoryComparison;
}

export interface SessionDiffCompactions {
  countA: number;
  countB: number;
  /** Same rule as shrinkTotal*, applied to discardedEst. */
  discardedEstA: number | null;
  discardedEstB: number | null;
  /** Sum of shrinkExact across a session's CompactionEvents. 0 when the
   * session has no compactions (exact, unambiguous). null when the session
   * HAS compactions but at least one has shrinkExact === null (before/after
   * usage not both recorded) — an honest total cannot be produced by
   * silently dropping the unknown event's contribution. */
  shrinkTotalA: number | null;
  shrinkTotalB: number | null;
}

export type ConfigFieldChange = "same" | "differs" | "unknown";

export interface SessionDiffConfig {
  harnessVersionChanged: boolean;
  modelChanged: boolean;
  projectInstructionsChanged: ConfigFieldChange;
  systemPromptChanged: ConfigFieldChange;
}

export interface SessionDiffComparability {
  warnings: string[];
}

export interface SessionDiff {
  compactions: SessionDiffCompactions;
  comparability: SessionDiffComparability;
  composition: SessionDiffComposition;
  config: SessionDiffConfig;
  cost: SessionDiffCost;
  meta: { a: SessionDiffMeta; b: SessionDiffMeta };
  totals: SessionDiffTotals;
}

function pct(a: number, delta: number): number | null {
  return a === 0 ? null : delta / a;
}

function tokenClassDelta(a: number, b: number): TokenClassDelta {
  const delta = b - a;
  return { a, b, delta, pct: pct(a, delta) };
}

function buildMeta(session: Session): SessionDiffMeta {
  const models: string[] = [];
  for (const turn of session.turns) {
    if (!models.includes(turn.model)) {
      models.push(turn.model);
    }
  }
  if (models.length === 0) {
    models.push(session.configSnapshot.model);
  }

  return {
    durationMs: session.endedAt.getTime() - session.startedAt.getTime(),
    harness: session.harness,
    harnessVersion: session.harnessVersion,
    id: session.id,
    models,
    startedAt: session.startedAt,
    turns: session.turns.length,
  };
}

function buildTotals(a: SessionTotals, b: SessionTotals): SessionDiffTotals {
  return {
    cacheRead: tokenClassDelta(a.tokens.cacheRead, b.tokens.cacheRead),
    cacheWrite1h: tokenClassDelta(a.tokens.cacheWrite1h, b.tokens.cacheWrite1h),
    cacheWrite5m: tokenClassDelta(a.tokens.cacheWrite5m, b.tokens.cacheWrite5m),
    inputUncached: tokenClassDelta(
      a.tokens.inputUncached,
      b.tokens.inputUncached
    ),
    output: tokenClassDelta(a.tokens.output, b.tokens.output),
  };
}

function buildCost(a: SessionTotals, b: SessionTotals): SessionDiffCost {
  const delta = b.cost - a.cost;
  return {
    a: a.cost,
    b: b.cost,
    bothPriced: a.priced && b.priced,
    delta,
    pct: pct(a.cost, delta),
  };
}

/** Last turn with real (non-zero) usage — the anchoring rule shared with
 * compaction.ts's findTokensBefore/findTokensAfter, applied over the whole
 * session rather than relative to a compaction marker. Not imported from
 * compaction.ts: that module's isRealUsageTurn is private, and this is a
 * different query (last in session, not last-before/first-after an index). */
function lastUsageCarryingTurn(session: Session): Turn | undefined {
  for (let i = session.turns.length - 1; i >= 0; i -= 1) {
    const turn = session.turns[i];
    if (turn && turn.contextTotal !== 0) {
      return turn;
    }
  }
}

function buildComposition(a: Session, b: Session): SessionDiffComposition {
  const turnA = lastUsageCarryingTurn(a);
  const turnB = lastUsageCarryingTurn(b);

  // Both sides of a Composition.categories record are always fully
  // populated over every CompositionCategory (composition.ts's
  // zeroCategories) whenever a composition exists at all; when a session has
  // no usage-carrying turn there is nothing to key off, so the category list
  // is taken from whichever side does have one, or the frozen union restated
  // here as a last resort when NEITHER side has usage-carrying turns.
  const CATEGORY_ORDER: readonly CompositionCategory[] = [
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
  const categoryKeys: readonly CompositionCategory[] = CATEGORY_ORDER;

  const categories = {} as Record<CompositionCategory, CategoryComparison>;
  for (const category of categoryKeys) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: A missing usage-carrying turn contributes zero.
    const av = turnA?.composition.categories[category] ?? 0;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: A missing usage-carrying turn contributes zero.
    const bv = turnB?.composition.categories[category] ?? 0;
    categories[category] = { a: av, b: bv, delta: bv - av };
  }

  // biome-ignore lint/suspicious/noUnnecessaryConditions: A missing usage-carrying turn contributes zero.
  const residualA = turnA?.composition.residual ?? 0;
  // biome-ignore lint/suspicious/noUnnecessaryConditions: A missing usage-carrying turn contributes zero.
  const residualB = turnB?.composition.residual ?? 0;

  return {
    categories,
    residual: { a: residualA, b: residualB, delta: residualB - residualA },
  };
}

function compactionTotals(session: Session): {
  count: number;
  shrinkTotal: number | null;
  discardedEst: number | null;
} {
  const events = session.events.filter((e) => e.kind === "compaction");
  if (events.length === 0) {
    return { count: 0, discardedEst: 0, shrinkTotal: 0 };
  }

  let shrinkTotal = 0;
  let shrinkKnown = true;
  let discardedEst = 0;
  let discardedKnown = true;
  for (const event of events) {
    if (event.shrinkExact === null) {
      shrinkKnown = false;
    } else {
      shrinkTotal += event.shrinkExact;
    }
    if (event.discardedEst === null) {
      discardedKnown = false;
    } else {
      discardedEst += event.discardedEst;
    }
  }

  return {
    count: events.length,
    discardedEst: discardedKnown ? discardedEst : null,
    shrinkTotal: shrinkKnown ? shrinkTotal : null,
  };
}

function buildCompactions(a: Session, b: Session): SessionDiffCompactions {
  const ca = compactionTotals(a);
  const cb = compactionTotals(b);
  return {
    countA: ca.count,
    countB: cb.count,
    discardedEstA: ca.discardedEst,
    discardedEstB: cb.discardedEst,
    shrinkTotalA: ca.shrinkTotal,
    shrinkTotalB: cb.shrinkTotal,
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** "same"/"differs" via sha256 of the field when BOTH sessions logged it
 * (present === typeof value === "string"); "unknown" otherwise — mirrors the
 * honesty convention elsewhere in this codebase of never inferring a
 * same/differs verdict from a harness that doesn't log the field at all
 * (PLAN's systemPrompt "codex only; empty elsewhere" note). */
function compareLoggedField(a?: string, b?: string): ConfigFieldChange {
  if (typeof a !== "string" || typeof b !== "string") {
    return "unknown";
  }
  return sha256(a) === sha256(b) ? "same" : "differs";
}

function buildConfig(a: Session, b: Session): SessionDiffConfig {
  return {
    harnessVersionChanged: a.harnessVersion !== b.harnessVersion,
    modelChanged: a.configSnapshot.model !== b.configSnapshot.model,
    projectInstructionsChanged: compareLoggedField(
      a.configSnapshot.projectInstructions,
      b.configSnapshot.projectInstructions
    ),
    systemPromptChanged: compareLoggedField(
      a.configSnapshot.systemPrompt,
      b.configSnapshot.systemPrompt
    ),
  };
}

const TURN_COUNT_DIVERGENCE_THRESHOLD = 3;
const DURATION_DIVERGENCE_THRESHOLD = 5;

/** max/min of two non-negative numbers; Infinity when exactly one is 0
 * (an unbounded divergence — the zero side "used none" while the other did),
 * 1 (no divergence) when both are 0. */
function divergenceRatio(x: number, y: number): number {
  if (x === 0 && y === 0) {
    return 1;
  }
  if (x === 0 || y === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(x, y) / Math.min(x, y);
}

function buildComparability(
  a: Session,
  metaA: SessionDiffMeta,
  b: Session,
  metaB: SessionDiffMeta
): SessionDiffComparability {
  const warnings: string[] = [];

  if (
    divergenceRatio(metaA.turns, metaB.turns) > TURN_COUNT_DIVERGENCE_THRESHOLD
  ) {
    warnings.push(
      `turn count diverges strongly: a=${metaA.turns} b=${metaB.turns} (>${TURN_COUNT_DIVERGENCE_THRESHOLD}x)`
    );
  }
  if (
    divergenceRatio(metaA.durationMs, metaB.durationMs) >
    DURATION_DIVERGENCE_THRESHOLD
  ) {
    warnings.push(
      `duration diverges strongly: a=${metaA.durationMs}ms b=${metaB.durationMs}ms (>${DURATION_DIVERGENCE_THRESHOLD}x)`
    );
  }
  if (a.gitBranch !== b.gitBranch) {
    warnings.push(
      `git branch differs: a=${a.gitBranch ?? "(none)"} b=${b.gitBranch ?? "(none)"}`
    );
  }
  if (a.harness !== b.harness) {
    warnings.push(`harness differs: a=${a.harness} b=${b.harness}`);
  }
  if (a.cwd !== b.cwd) {
    warnings.push(`cwd differs: a=${a.cwd} b=${b.cwd}`);
  }

  return { warnings };
}

/**
 * Compares two already-processed sessions (see file header for the
 * dedupSession -> computeComposition -> finalizeCompactions -> priceSession
 * precondition). Pure; does not mutate its inputs.
 */
export function diffSessions(a: Session, b: Session): SessionDiff {
  const metaA = buildMeta(a);
  const metaB = buildMeta(b);
  const totalsA = sessionTotals(a);
  const totalsB = sessionTotals(b);

  return {
    compactions: buildCompactions(a, b),
    comparability: buildComparability(a, metaA, b, metaB),
    composition: buildComposition(a, b),
    config: buildConfig(a, b),
    cost: buildCost(totalsA, totalsB),
    meta: { a: metaA, b: metaB },
    totals: buildTotals(totalsA, totalsB),
  };
}

// ---------------------------------------------------------------------------
// selectLastComparable — `peek diff --last N` selection algorithm (v2, Lane
// F5 — generalized from v1's fixed `--last 2`), per docs/DESIGN.md § "CLI
// surface":
//
//   candidates = sessions with same project scope (current cwd's slug / git
//   repo root; --cwd <path> overrides; --all-projects widens) AND same
//   harness, excluding kind:"subagent", ordered startedAt desc; take N.
//
// SessionRef carries mtime, not startedAt (that's only known once a session
// is parsed) — mtime desc is used here as the documented proxy for
// "most recently active session" ordering.
// ---------------------------------------------------------------------------

export interface SelectLastComparableOptions {
  allProjects?: boolean;
  /** Restrict to this harness. If omitted, the harness is INFERRED — see
   * the two-pass scope note below for how, and why naively inferring it
   * from "most recent ref regardless of cwd" is wrong. */
  harness?: HarnessId;
  /** The already-resolved project scope to match SessionRef.cwd against
   * (current cwd's slug / git repo root, or an explicit --cwd override —
   * resolving "current project scope" from the real filesystem is the CLI
   * wrapper's job, not this pure function's; this is the resolved value).
   * Ignored when allProjects is true. If omitted and allProjects is false,
   * no cwd filtering is applied at all (the caller didn't resolve a scope —
   * this function does not guess one). */
  scopeCwd?: string;
  /** How many candidate sessions to select, most-recent-first. Default 2
   * (v1's only supported value). commands/diff.ts's `--last <n>` clamps n to
   * 2..5 before this is called. */
  take?: number;
}

export interface SelectLastComparableResult {
  reason?: string;
  /** Selected refs, most-recent-first, length === the requested `take`
   * (default 2). Undefined when fewer than `take` candidates exist. */
  refs?: SessionRef[];
}

function byMtimeDesc(a: SessionRef, b: SessionRef): number {
  return b.mtime.getTime() - a.mtime.getTime();
}

/**
 * `ref` counts as in-scope when no scope was requested (scopeCwd
 * undefined), when its cwd matches exactly, or — only when
 * `allowUnknownCwd` — when its cwd is unknowable at discovery time (codex
 * refs never carry cwd until parse time; see commands/context.ts's
 * applyFilters for the identical per-ref convention). The two call sites
 * below pass allowUnknownCwd differently on purpose (see the two-pass note
 * on selectLastComparable).
 */
function isInScope(
  ref: SessionRef,
  scopeCwd: string | undefined,
  allowUnknownCwd: boolean
): boolean {
  if (scopeCwd === undefined) {
    return true;
  }
  if (ref.cwd === scopeCwd) {
    return true;
  }
  return allowUnknownCwd && ref.cwd === undefined;
}

/**
 * Two-pass scope filtering (audit R3-F3 gate case — a naive single pass
 * over "cwd matches OR cwd unknowable" lets an unrelated-project codex ref
 * (always cwd:undefined pre-parse) look in-scope for a claude-code-scoped
 * query, and if it happens to be the most-recently-modified ref overall it
 * HIJACKS harness inference below — the algorithm silently degrades to
 * "just the newest two refs regardless of project," which is precisely
 * what PLAN's "same project scope AND same harness" is supposed to
 * prevent):
 *
 *   1. STRICT scope (exact cwd match only, no unknown-cwd allowance) is
 *      what harness inference is computed from — an unrelated harness
 *      whose refs can never prove they're in-scope must never be able to
 *      out-vote the harness that actually IS.
 *   2. WIDENED scope (exact cwd match OR unknowable cwd) is what the final
 *      candidate pool is drawn from, AFTER the harness is locked in — this
 *      is what lets a harness whose refs never carry cwd at discovery
 *      (codex) still produce candidates once it's already the determined
 *      harness (either because the caller passed `harness` explicitly, or
 *      because strict-scope inference found only that harness present).
 *
 * Known, documented limitation inherited from that same adapter gap: a
 * project whose MOST RECENT activity is genuinely a codex session can
 * never have that inferred purely from cwd scoping (codex refs can't prove
 * membership in `strict`), so `selectLastComparable` reports "no
 * candidates" there unless the caller passes `harness: "codex"` explicitly
 * — same shape of limitation commands/context.ts already documents for
 * `--cwd`-scoped single-session resolution.
 */
export function selectLastComparable(
  refs: readonly SessionRef[],
  opts: SelectLastComparableOptions = {}
): SelectLastComparableResult {
  const take = opts.take ?? 2;
  const mainRefs = refs.filter((r) => r.kind !== "subagent");

  const strictScope = opts.allProjects
    ? mainRefs
    : mainRefs.filter((r) => isInScope(r, opts.scopeCwd, false));
  const widenedScope = opts.allProjects
    ? mainRefs
    : mainRefs.filter((r) => isInScope(r, opts.scopeCwd, true));

  const harness =
    opts.harness ?? [...strictScope].sort(byMtimeDesc)[0]?.harness;
  if (harness === undefined) {
    return { reason: "no candidate sessions in scope" };
  }

  const ordered = widenedScope
    .filter((r) => r.harness === harness)
    .sort(byMtimeDesc);
  if (ordered.length < take) {
    return {
      reason: `fewer than ${take} candidate sessions in scope (found ${ordered.length})`,
    };
  }

  const selected = ordered.slice(0, take);
  if (selected.length < take || selected.some((r) => r === undefined)) {
    return {
      reason: `fewer than ${take} candidate sessions in scope (found ${ordered.length})`,
    };
  }

  return { refs: selected };
}
