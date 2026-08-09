// Orchestration loop (A4 deliverable #3, DESIGN.md § "Lane A — `peek
// bench`" "Trial isolation"): for each task x config x trial (SERIALIZED,
// one at a time — v2.0 spec, removes all transcript races): createWorkspace
// -> applyConfig -> setup cmds -> runner.run -> verify cmd -> parse
// sessionPath with peek's adapters -> TrialResult -> append results.jsonl ->
// destroyWorkspace (finally).
//
// Wired against A1's workspace.ts/config.ts/proc.ts and A2/A3's runners
// (bench/runners/claude.ts, bench/runners/codex.ts) — all of which landed
// while this file was being written; every dependency below is a real
// import with a real default, not a placeholder. Each is still exposed
// through OrchestrateDeps with the real implementation as its default so
// tests can substitute a mock runner + mock proc/workspace (no real agents,
// no real git worktrees) per this task's own test requirement.

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseAndDedup } from "../commands/shared.js";
import { priceSession, sessionTotals } from "../engine/accounting.js";
import type { HarnessId, SessionRef } from "../model/types.js";
import { applyConfig as applyConfigReal } from "./config.js";
import { spawnDetached } from "./proc.js";
import type { ResultsWriter } from "./results.js";
import {
  type BenchRunner,
  type BenchTask,
  DEFAULT_TASK_TIMEOUT_S,
  type SessionTotalsLike,
  type TrialResult,
  type TrialSpec,
} from "./types.js";
import {
  type SetupResult,
  type Workspace,
  createWorkspace as createWorkspaceReal,
  destroyWorkspace as destroyWorkspaceReal,
  runSetup as runSetupReal,
} from "./workspace.js";

// ---------------------------------------------------------------------------
// Config selection — just a name + a variant dir ("current" = baseline, the
// repo's own config, untouched). config.ts's applyConfig resolves the
// variant's `model` file itself and hands it back; this module never reads
// config-dir files directly.
// ---------------------------------------------------------------------------

export interface ConfigVariant {
  name: string;
  dir: string | "current";
}

// ---------------------------------------------------------------------------
// Injected dependencies. Every field has a real default (see
// defaultOrchestrateDeps below) — OrchestrateOptions.deps is an optional
// PARTIAL override, so callers (commands/bench.ts) get the real pipeline for
// free and tests override only what they need to mock.
// ---------------------------------------------------------------------------

export interface OrchestrateDeps {
  createWorkspace(
    repoDir: string,
    scratchRoot: string,
    id: string,
  ): Promise<Workspace>;
  destroyWorkspace(ws: Workspace): Promise<void>;
  runSetup(
    ws: Workspace,
    setup: string[],
    timeoutMs: number,
  ): Promise<SetupResult>;
  /** Returns the resolved model (from the variant dir's one-line `model`
   * file), when set. */
  applyConfig(
    variantDir: string | "current",
    workspaceDir: string,
  ): Promise<{ model?: string }>;
  /** Runs the task's `verify` command (a shell command line, same as each
   * `setup[]` entry) via proc.ts's spawnDetached, through `/bin/sh -c`. */
  runVerify(
    verifyCmd: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number | null; timedOut: boolean }>;
  /** parseAndDedup + priceSession({mode:"auto"}) + sessionTotals() + a count
   * of session.events with kind:"compaction" -> SessionTotalsLike. Never
   * throws — an unparseable/missing transcript resolves to undefined (an
   * honestly-absent total, not a pipeline failure — compare.ts's documented
   * honesty convention). */
  parseSessionTotals(
    harness: HarnessId,
    sessionPath: string,
  ): Promise<SessionTotalsLike | undefined>;
  /** Test seam — defaults to `() => new Date()`. */
  now?: () => Date;
}

async function buildSessionRef(
  harness: HarnessId,
  sessionPath: string,
): Promise<SessionRef> {
  const st = await stat(sessionPath);
  const id = path.basename(sessionPath).replace(/\.jsonl$/, "");
  return {
    harness,
    id,
    path: sessionPath,
    sizeBytes: st.size,
    mtime: st.mtime,
    kind: "main",
  };
}

async function parseSessionTotalsReal(
  harness: HarnessId,
  sessionPath: string,
): Promise<SessionTotalsLike | undefined> {
  try {
    const ref = await buildSessionRef(harness, sessionPath);
    const { session } = await parseAndDedup(ref);
    const priced = priceSession(session, { mode: "auto" });
    const totals = sessionTotals(priced);
    const compactionCount = priced.events.filter(
      (e) => e.kind === "compaction",
    ).length;
    return {
      tokens: totals.tokens,
      cost: totals.cost,
      priced: totals.priced,
      compactionCount,
    };
  } catch {
    return undefined;
  }
}

async function runVerifyReal(
  verifyCmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  const result = await spawnDetached("/bin/sh", ["-c", verifyCmd], {
    cwd,
    timeoutMs,
  });
  return { exitCode: result.exitCode, timedOut: result.timedOut };
}

async function applyConfigReal_(
  variantDir: string | "current",
  workspaceDir: string,
): Promise<{ model?: string }> {
  const applied = await applyConfigReal(variantDir, workspaceDir);
  return applied.model !== undefined ? { model: applied.model } : {};
}

export function defaultOrchestrateDeps(): OrchestrateDeps {
  return {
    createWorkspace: createWorkspaceReal,
    destroyWorkspace: destroyWorkspaceReal,
    runSetup: runSetupReal,
    applyConfig: applyConfigReal_,
    runVerify: runVerifyReal,
    parseSessionTotals: parseSessionTotalsReal,
  };
}

/** `${XDG_CACHE_HOME ?? ~/.cache}/peek/bench-scratch` — same convention as
 * cache/totals.ts's totals cache path. Trial workspaces live under here;
 * `peek bench clean` sweeps orphans from it via workspace.ts's
 * sweepOrphans. */
export function defaultScratchRoot(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(base, "peek", "bench-scratch");
}

// ---------------------------------------------------------------------------
// Progress / estimate.
// ---------------------------------------------------------------------------

export type ProgressEvent =
  | {
      kind: "trial-start";
      taskName: string;
      configName: string;
      trialIndex: number;
      trialsTotal: number;
    }
  | { kind: "trial-end"; result: TrialResult }
  | { kind: "aborted"; reason: string; spentUsd: number };

/** N tasks x M trials x K configs = total agent runs. */
export function estimateRuns(
  taskCount: number,
  trials: number,
  configCount: number,
): number {
  return taskCount * trials * configCount;
}

/** "N tasks × M trials × 2 configs = K agent runs" — the spec's own literal
 * phrasing (DESIGN.md § "Safety/cost rails"), printed by commands/bench.ts
 * before the confirm prompt. */
export function formatEstimateLine(
  taskCount: number,
  trials: number,
  configCount: number,
): string {
  const total = estimateRuns(taskCount, trials, configCount);
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(taskCount, "task")} × ${plural(trials, "trial")} × ${plural(configCount, "config")} = ${plural(total, "agent run")}`;
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

export interface OrchestrateOptions {
  suite: readonly BenchTask[];
  configs: readonly ConfigVariant[]; // typically [configA, configB]
  harness: HarnessId;
  runner: BenchRunner;
  repoDir: string; // target repo root (peek bench run's cwd, typically)
  scratchRoot?: string; // default: defaultScratchRoot()
  trials: number; // per task per config
  /** CLI `--timeout` override — applied to every task when set; otherwise
   * each BenchTask's own `timeoutS` is used, falling back to
   * DEFAULT_TASK_TIMEOUT_S if neither is set. */
  timeoutS?: number;
  perTrialBudgetUsd?: number;
  /** Cross-trial ceiling (spec: "best-effort, from completed trials'
   * logs") — checked BEFORE starting each trial against the running sum of
   * completed trials' totals.cost (priced trials only, this run only). */
  maxCostUsd?: number;
  resultsWriter: ResultsWriter;
  /** Partial override of the real pipeline (defaultOrchestrateDeps()) —
   * tests substitute a mock runner + mock proc/workspace here; production
   * callers normally omit this entirely. */
  deps?: Partial<OrchestrateDeps>;
  onProgress?: (event: ProgressEvent) => void;
}

export interface OrchestrateResult {
  results: TrialResult[];
  aborted: boolean;
  abortReason?: string;
}

function effectiveTimeoutS(task: BenchTask, override?: number): number {
  return override ?? task.timeoutS ?? DEFAULT_TASK_TIMEOUT_S;
}

let workspaceIdCounter = 0;

/** Filesystem-safe, human-legible, collision-resistant workspace id for one
 * trial: `<task>-<config>-t<trialIndex>-<pid>-<monotonic counter>`. */
function workspaceId(
  taskName: string,
  configName: string,
  trialIndex: number,
): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  workspaceIdCounter += 1;
  return `${slug(taskName)}-${slug(configName)}-t${trialIndex}-${process.pid}-${workspaceIdCounter}`;
}

/**
 * Runs one trial end-to-end: createWorkspace -> applyConfig -> setup[] ->
 * runner.run -> verify -> parse totals -> TrialResult. destroyWorkspace
 * always runs (finally), even when a setup command fails or the runner
 * throws.
 *
 * A setup[] failure (workspace.ts's runSetup: first nonzero exit) aborts
 * just THIS trial — not the whole comparison — recorded as a failed trial
 * (exitCode/stderrTail from the failing setup command, wallMs 0 since the
 * agent never ran, verify not-passed since it never ran either) rather than
 * silently dropped from results.jsonl, so compare.ts's success-rate math
 * still sees a broken task fixture as a real signal.
 */
async function runOneTrial(
  task: BenchTask,
  config: ConfigVariant,
  trialIndex: number,
  harness: HarnessId,
  runner: BenchRunner,
  repoDir: string,
  scratchRoot: string,
  timeoutOverride: number | undefined,
  perTrialBudgetUsd: number | undefined,
  deps: OrchestrateDeps,
): Promise<TrialResult> {
  const startedAt = (deps.now ?? (() => new Date()))();
  const timeoutS = effectiveTimeoutS(task, timeoutOverride);
  const timeoutMs = timeoutS * 1000;
  const id = workspaceId(task.name, config.name, trialIndex);

  let ws: Workspace | undefined;
  try {
    ws = await deps.createWorkspace(repoDir, scratchRoot, id);
    const { model } = await deps.applyConfig(config.dir, ws.dir);

    const setupResult = await deps.runSetup(ws, task.setup ?? [], timeoutMs);
    if (!setupResult.ok) {
      return {
        taskName: task.name,
        configName: config.name,
        harness,
        trialIndex,
        exitCode: setupResult.exitCode ?? null,
        timedOut: false,
        wallMs: 0,
        stderrTail: setupResult.stderrTail ?? "",
        verify: { exitCode: null, passed: false },
        startedAt: startedAt.toISOString(),
      };
    }

    const trialSpec: TrialSpec = {
      task,
      configName: config.name,
      workspaceDir: ws.dir,
      timeoutS,
      ...(model !== undefined ? { model } : {}),
      ...(perTrialBudgetUsd !== undefined ? { perTrialBudgetUsd } : {}),
    };
    const outcome = await runner.run(trialSpec);

    const verifyResult = await deps.runVerify(task.verify, ws.dir, timeoutMs);
    const verifyPassed = verifyResult.exitCode === 0 && !verifyResult.timedOut;

    const totals =
      outcome.sessionPath !== undefined
        ? await deps.parseSessionTotals(harness, outcome.sessionPath)
        : undefined;

    const result: TrialResult = {
      ...outcome,
      taskName: task.name,
      configName: config.name,
      harness,
      trialIndex,
      verify: { exitCode: verifyResult.exitCode, passed: verifyPassed },
      startedAt: startedAt.toISOString(),
    };
    if (totals !== undefined) result.totals = totals;
    return result;
  } finally {
    if (ws !== undefined) {
      await deps.destroyWorkspace(ws);
    }
  }
}

/**
 * Runs the full task x config x trial matrix, serialized. Writes each
 * TrialResult to `resultsWriter` as soon as it completes (crash safety —
 * see results.ts's file header) and returns the full accumulated list.
 * Aborts BETWEEN trials (never mid-trial) when `maxCostUsd` is set and the
 * running priced spend from this run's own completed trials reaches it.
 */
export async function orchestrate(
  options: OrchestrateOptions,
): Promise<OrchestrateResult> {
  const {
    suite,
    configs,
    harness,
    runner,
    repoDir,
    trials,
    timeoutS,
    perTrialBudgetUsd,
    maxCostUsd,
    resultsWriter,
    onProgress,
  } = options;
  const scratchRoot = options.scratchRoot ?? defaultScratchRoot();
  const deps: OrchestrateDeps = {
    ...defaultOrchestrateDeps(),
    ...options.deps,
  };

  const results: TrialResult[] = [];
  const trialsTotal = estimateRuns(suite.length, trials, configs.length);
  let spentUsd = 0;

  for (const task of suite) {
    for (const config of configs) {
      for (let trialIndex = 0; trialIndex < trials; trialIndex++) {
        if (maxCostUsd !== undefined && spentUsd >= maxCostUsd) {
          const reason = `--max-cost ${maxCostUsd} reached (spent so far: $${spentUsd.toFixed(2)})`;
          onProgress?.({ kind: "aborted", reason, spentUsd });
          return { results, aborted: true, abortReason: reason };
        }

        onProgress?.({
          kind: "trial-start",
          taskName: task.name,
          configName: config.name,
          trialIndex,
          trialsTotal,
        });

        const result = await runOneTrial(
          task,
          config,
          trialIndex,
          harness,
          runner,
          repoDir,
          scratchRoot,
          timeoutS,
          perTrialBudgetUsd,
          deps,
        );
        await resultsWriter.append(result);
        results.push(result);
        if (result.totals?.priced) spentUsd += result.totals.cost;

        onProgress?.({ kind: "trial-end", result });
      }
    }
  }

  return { results, aborted: false };
}
