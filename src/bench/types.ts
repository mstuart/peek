// Bench (v2 Lane A, docs/DESIGN.md § Bench design) shared types.
//
// Transcribed verbatim from DESIGN.md's "Canonical runner interface
// (implementation contract — workers build against this verbatim)" block,
// plus BenchTask (the `.peek/bench/*.json` task-suite schema documented in
// the same section, § "Task suite") and SessionTotalsLike (see its own doc
// below — NOT in the spec's verbatim block). This file did not exist when
// A4 started (src/bench/ was empty); created here per A4's brief ("code
// against src/bench/types.ts — if absent, create it verbatim from the
// spec's interface block").
//
// Ownership: A2 (claude runner) and A3 (codex runner) implement BenchRunner.
// A1 owns task-suite loading, config-dir overlay, and workspace lifecycle
// (createWorkspace/applyConfig — referenced by run.ts, not defined here).
// A4 (this lane) owns results.jsonl persistence (results.ts), cross-config
// aggregation (compare.ts), the orchestration loop (run.ts), the `peek
// bench` CLI (../commands/bench.ts), and HTML reporting (reportHtml.ts) —
// all built against these types.

import type { HarnessId } from "../model/types.js";

/** One `.peek/bench/*.json` task file (DESIGN.md § "Task suite"). `verify`
 * exit 0 = success — REQUIRED, no LLM-judge in v2.0. `timeoutS` is optional
 * (suite.ts's loadSuite validates it when present but doesn't require it) —
 * DEFAULT_TASK_TIMEOUT_S below is the fallback when neither a task nor a
 * `--timeout` CLI override supplies one (structurally identical to
 * suite.ts's own BenchTask so loadSuite's output and this type are freely
 * interchangeable — TS structural typing, not a re-export, to avoid a
 * cross-lane import at either end). */
export interface BenchTask {
  name: string;
  prompt: string;
  setup?: string[];
  verify: string;
  timeoutS?: number;
}

/** Fallback per-trial timeout (seconds) when neither the task nor `--timeout`
 * supplies one — matches the spec's own example task file's `timeoutS: 600`. */
export const DEFAULT_TASK_TIMEOUT_S = 600;

export interface BenchRunner {
  harness: HarnessId;
  run(trial: TrialSpec): Promise<TrialOutcome>; // spawns, waits, kills on timeout
}

export interface TrialSpec {
  task: BenchTask;
  configName: string;
  workspaceDir: string;
  model?: string;
  timeoutS: number;
  perTrialBudgetUsd?: number;
}

export interface TrialOutcome {
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  sessionPath?: string; // resolved transcript/rollout path
  stderrTail: string; // last 2KB verbatim (version-drift forensics)
  raw?: unknown; // harness result JSON (claude) when available
}

/**
 * SessionTotalsLike — the spec names this type (`totals?: SessionTotalsLike`)
 * without defining it. Mirrors engine/accounting.ts's SessionTotals shape
 * (tokens/cost/priced) plus `compactionCount`, which compare.ts's
 * aggregation needs per-trial and SessionTotals itself doesn't carry (it's a
 * session-level rollup with no compaction-event count). run.ts computes this
 * from the trial's parsed+deduped+priced session: sessionTotals() for the
 * tokens/cost/priced fields, plus a count of session.events with
 * kind:"compaction" for compactionCount.
 */
export interface SessionTotalsLike {
  tokens: {
    inputUncached: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
    contextTotal: number;
  };
  cost: number;
  priced: boolean;
  compactionCount: number;
}

export interface TrialResult extends TrialOutcome {
  // written to results.jsonl, one per trial
  taskName: string;
  configName: string;
  harness: HarnessId;
  trialIndex: number;
  verify: { exitCode: number | null; passed: boolean };
  totals?: SessionTotalsLike; // from parsing sessionPath with peek's adapters
  startedAt: string;
}
