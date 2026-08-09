// A4 gate (docs/DESIGN.md § Lane A "peek bench: config A/B regression
// runner", task A4) — covers:
//   - compare.ts: median/success-rate/delta arithmetic, including the
//     missing-totals honesty convention.
//   - results.ts: writer/reader round-trip, torn-last-line tolerance.
//   - commands/bench.ts: report table structure (deltaRowToCells / renderTable
//     integration).
//   - reportHtml.ts: no external URLs, zero JS, esc()'d content.
//   - run.ts's orchestrate(): the per-trial pipeline against a MOCK runner +
//     mock deps (no real agents, no real git worktrees — the real run is the
//     orchestrator's [fable] gate).

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCompareTable, groupCells } from "../../src/bench/compare.js";
import { renderBenchReportHtml } from "../../src/bench/reportHtml.js";
import {
  createResultsWriter,
  parseResultsJsonl,
  readResults,
} from "../../src/bench/results.js";
import type { ResultsWriter } from "../../src/bench/results.js";
import {
  type OrchestrateDeps,
  type OrchestrateOptions,
  orchestrate,
} from "../../src/bench/run.js";
import type {
  BenchRunner,
  BenchTask,
  SessionTotalsLike,
  TrialOutcome,
  TrialResult,
  TrialSpec,
} from "../../src/bench/types.js";
import {
  deltaRowToCells,
  printCompareTable,
} from "../../src/commands/bench.js";
import { renderTable } from "../../src/render/table.js";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function totals(overrides: Partial<SessionTotalsLike> = {}): SessionTotalsLike {
  return {
    tokens: {
      inputUncached: 100,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 50,
      contextTotal: 150,
    },
    cost: 0.05,
    priced: true,
    compactionCount: 0,
    ...overrides,
  };
}

function trial(overrides: Partial<TrialResult> = {}): TrialResult {
  return {
    taskName: "fix-flaky-test",
    configName: "a",
    harness: "claude-code",
    trialIndex: 0,
    exitCode: 0,
    timedOut: false,
    wallMs: 10_000,
    stderrTail: "",
    verify: { exitCode: 0, passed: true },
    startedAt: "2026-08-08T00:00:00.000Z",
    totals: totals(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// compare.ts — pure aggregation.
// ---------------------------------------------------------------------------

describe("groupCells", () => {
  it("groups by (taskName, configName), preserving first-seen order", () => {
    const results = [
      trial({ taskName: "t1", configName: "a", trialIndex: 0 }),
      trial({ taskName: "t1", configName: "b", trialIndex: 0 }),
      trial({ taskName: "t2", configName: "a", trialIndex: 0 }),
      trial({ taskName: "t1", configName: "a", trialIndex: 1 }),
    ];
    const cells = groupCells(results);
    expect(cells.map((c) => `${c.taskName}/${c.configName}`)).toEqual([
      "t1/a",
      "t1/b",
      "t2/a",
    ]);
    const t1a = cells.find((c) => c.taskName === "t1" && c.configName === "a");
    expect(t1a?.trialCount).toBe(2);
  });
});

describe("buildCompareTable — success rate / median / delta arithmetic", () => {
  it("computes success rate and an even-count median (average of two middles)", () => {
    const results = [
      trial({
        configName: "a",
        trialIndex: 0,
        verify: { exitCode: 0, passed: true },
        wallMs: 10_000,
      }),
      trial({
        configName: "a",
        trialIndex: 1,
        verify: { exitCode: 1, passed: false },
        wallMs: 20_000,
      }),
      trial({
        configName: "a",
        trialIndex: 2,
        verify: { exitCode: 0, passed: true },
        wallMs: 30_000,
      }),
      trial({
        configName: "a",
        trialIndex: 3,
        verify: { exitCode: 0, passed: true },
        wallMs: 40_000,
      }),
    ];
    const table = buildCompareTable(results, "a", "b");
    const cell = table.cells[0];
    expect(cell).toBeDefined();
    expect(cell?.successCount).toBe(3);
    expect(cell?.trialCount).toBe(4);
    expect(cell?.successRateLabel).toBe("3/4 (75%)");
    // wallMs sorted: 10k,20k,30k,40k -> median of two middles (20k+30k)/2 = 25k
    expect(cell?.medianWallMs).toBe(25_000);
    expect(cell?.medianWallLabel).toBe("25.0s");
  });

  it("computes an odd-count median as the exact middle value", () => {
    const results = [
      trial({
        trialIndex: 0,
        totals: totals({
          tokens: {
            inputUncached: 0,
            cacheRead: 0,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            output: 0,
            contextTotal: 100,
          },
        }),
      }),
      trial({
        trialIndex: 1,
        totals: totals({
          tokens: {
            inputUncached: 0,
            cacheRead: 0,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            output: 0,
            contextTotal: 300,
          },
        }),
      }),
      trial({
        trialIndex: 2,
        totals: totals({
          tokens: {
            inputUncached: 0,
            cacheRead: 0,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            output: 0,
            contextTotal: 200,
          },
        }),
      }),
    ];
    const table = buildCompareTable(results, "a", "b");
    expect(table.cells[0]?.medianTokens).toBe(200);
  });

  it("A-vs-B deltas: positive tokens/cost/wall improvement (b cheaper/faster) reads negative", () => {
    const results = [
      trial({
        configName: "a",
        totals: totals({
          cost: 0.1,
          tokens: {
            inputUncached: 0,
            cacheRead: 0,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            output: 0,
            contextTotal: 1000,
          },
        }),
        wallMs: 20_000,
      }),
      trial({
        configName: "b",
        totals: totals({
          cost: 0.05,
          tokens: {
            inputUncached: 0,
            cacheRead: 0,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            output: 0,
            contextTotal: 500,
          },
        }),
        wallMs: 10_000,
      }),
    ];
    const table = buildCompareTable(results, "a", "b");
    const delta = table.deltas[0];
    expect(delta?.taskName).toBe("fix-flaky-test");
    expect(delta?.costDeltaLabel).toContain("-$0.05");
    expect(delta?.costDeltaLabel).toContain("-50.0%");
    expect(delta?.tokensDeltaLabel).toContain("-500");
    expect(delta?.wallDeltaLabel).toContain("-10.0s");
  });

  it("success rate delta is in percentage points", () => {
    const results = [
      trial({
        configName: "a",
        trialIndex: 0,
        verify: { exitCode: 1, passed: false },
      }),
      trial({
        configName: "a",
        trialIndex: 1,
        verify: { exitCode: 1, passed: false },
      }),
      trial({
        configName: "b",
        trialIndex: 0,
        verify: { exitCode: 0, passed: true },
      }),
      trial({
        configName: "b",
        trialIndex: 1,
        verify: { exitCode: 0, passed: true },
      }),
    ];
    const table = buildCompareTable(results, "a", "b");
    expect(table.deltas[0]?.successDeltaLabel).toBe("+100.0pp");
  });

  it("honesty convention: missing totals (unparsed session) excluded from token/cost/compaction medians but still count toward trialCount/successCount", () => {
    const results = [
      trial({ trialIndex: 0, totals: totals({ cost: 0.1 }) }),
      // Unparsed session — totals key omitted entirely (exactOptionalPropertyTypes).
      (() => {
        const t = trial({
          trialIndex: 1,
          verify: { exitCode: 0, passed: true },
        });
        const { totals: _drop, ...rest } = t;
        return rest as TrialResult;
      })(),
    ];
    const table = buildCompareTable(results, "a", "b");
    const cell = table.cells[0];
    expect(cell?.trialCount).toBe(2);
    expect(cell?.successCount).toBe(2);
    expect(cell?.totalsCount).toBe(1);
    expect(cell?.medianTokens).toBe(150); // from the one trial that DID parse
    expect(cell?.medianTokensLabel).not.toBe("—");
  });

  it("honesty convention: zero parsed sessions -> tokens/cost/compactions all render '—', never 0", () => {
    const noTotals = (() => {
      const t = trial();
      const { totals: _drop, ...rest } = t;
      return rest as TrialResult;
    })();
    const table = buildCompareTable([noTotals], "a", "b");
    const cell = table.cells[0];
    expect(cell?.totalsCount).toBe(0);
    expect(cell?.medianTokens).toBeNull();
    expect(cell?.medianTokensLabel).toBe("—");
    expect(cell?.medianCost).toBeNull();
    expect(cell?.medianCostLabel).toBe("—");
    expect(cell?.compactionTotal).toBeNull();
    expect(cell?.compactionTotalLabel).toBe("—");
  });

  it("honesty convention: totals present but unpriced (unknown model) -> medianCost '—' while tokens still render", () => {
    const results = [trial({ totals: totals({ priced: false, cost: 0 }) })];
    const table = buildCompareTable(results, "a", "b");
    const cell = table.cells[0];
    expect(cell?.totalsCount).toBe(1);
    expect(cell?.pricedCount).toBe(0);
    expect(cell?.medianCostLabel).toBe("—");
    expect(cell?.medianTokensLabel).not.toBe("—");
  });

  it("reports tasks missing from one side rather than silently dropping them", () => {
    const results = [
      trial({ taskName: "only-in-a", configName: "a" }),
      trial({ taskName: "in-both", configName: "a" }),
      trial({ taskName: "in-both", configName: "b" }),
    ];
    const table = buildCompareTable(results, "a", "b");
    expect(table.deltas.map((d) => d.taskName)).toEqual(["in-both"]);
    expect(table.missing).toEqual([
      { taskName: "only-in-a", missingConfig: "b" },
    ]);
  });

  it("overall summary row aggregates across ALL tasks per config", () => {
    const results = [
      trial({
        taskName: "t1",
        configName: "a",
        wallMs: 10_000,
        verify: { exitCode: 0, passed: true },
      }),
      trial({
        taskName: "t2",
        configName: "a",
        wallMs: 30_000,
        verify: { exitCode: 1, passed: false },
      }),
      trial({
        taskName: "t1",
        configName: "b",
        wallMs: 5_000,
        verify: { exitCode: 0, passed: true },
      }),
      trial({
        taskName: "t2",
        configName: "b",
        wallMs: 15_000,
        verify: { exitCode: 0, passed: true },
      }),
    ];
    const table = buildCompareTable(results, "a", "b");
    expect(table.overall).not.toBeNull();
    expect(table.overall?.a.trialCount).toBe(2);
    expect(table.overall?.a.successCount).toBe(1);
    expect(table.overall?.b.successCount).toBe(2);
    expect(table.overall?.delta.taskName).toBe("ALL TASKS");
  });

  it("overall is null when one config has zero trials", () => {
    const table = buildCompareTable([trial({ configName: "a" })], "a", "b");
    expect(table.overall).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// results.ts — writer/reader round-trip + torn-line tolerance.
// ---------------------------------------------------------------------------

describe("results.ts round-trip", () => {
  let dir: string;

  afterEach(() => {
    // Individual tmp dirs — no shared state to reset between tests, nothing
    // to tear down beyond what the OS reclaims for a tmpdir-rooted path.
  });

  it("append -> readResults returns every TrialResult, one per line", async () => {
    dir = mkdtempSync(join(tmpdir(), "peek-bench-results-"));
    const writer: ResultsWriter = await createResultsWriter({ baseDir: dir });
    await writer.append(trial({ trialIndex: 0 }));
    await writer.append(trial({ trialIndex: 1, configName: "b" }));

    const { results, warnings } = await readResults(writer.path);
    expect(warnings).toEqual([]);
    expect(results).toHaveLength(2);
    expect(results[0]?.trialIndex).toBe(0);
    expect(results[1]?.configName).toBe("b");
    // Round-tripped through JSON — verify a nested field survives intact.
    expect(results[0]?.totals?.tokens.contextTotal).toBe(150);
  });

  it("writes under <baseDir>/<ISO-ts>/results.jsonl with colons/dots slugified", async () => {
    dir = mkdtempSync(join(tmpdir(), "peek-bench-results-"));
    const writer = await createResultsWriter({
      baseDir: dir,
      timestamp: new Date("2026-08-08T17:22:10.123Z"),
    });
    expect(writer.path).toBe(
      join(dir, "2026-08-08T17-22-10-123Z", "results.jsonl"),
    );
    await writer.append(trial());
    expect(readFileSync(writer.path, "utf8")).toContain("fix-flaky-test");
  });

  it("tolerates a torn last line from a crashed run without discarding the rest", () => {
    const good1 = JSON.stringify(trial({ trialIndex: 0 }));
    const good2 = JSON.stringify(trial({ trialIndex: 1 }));
    const torn = '{"taskName":"x","configName":"a","trialIndex":2,"exitC';
    const raw = `${good1}\n${good2}\n${torn}`;

    const { results, warnings } = parseResultsJsonl(raw);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.trialIndex)).toEqual([0, 1]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.line).toBe(3);
  });

  it("blank lines (trailing newline) are not reported as warnings", () => {
    const raw = `${JSON.stringify(trial())}\n\n`;
    const { results, warnings } = parseResultsJsonl(raw);
    expect(results).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// commands/bench.ts — report table structure.
// ---------------------------------------------------------------------------

describe("bench report table structure", () => {
  it("deltaRowToCells produces one cell per table column (16: task + 5 metrics x [a,b,Δ])", () => {
    const results = [trial({ configName: "a" }), trial({ configName: "b" })];
    const table = buildCompareTable(results, "a", "b");
    const row = table.deltas[0];
    expect(row).toBeDefined();
    if (!row) throw new Error("unreachable");
    const cells = deltaRowToCells(row);
    expect(cells).toHaveLength(16);
    expect(cells[0]).toBe("fix-flaky-test");
  });

  it("renderTable renders the delta row cells into an aligned table containing the task name and configs", () => {
    const results = [trial({ configName: "a" }), trial({ configName: "b" })];
    const table = buildCompareTable(results, "a", "b");
    const row = table.deltas[0];
    if (!row) throw new Error("unreachable");
    const rendered = renderTable(
      [
        { header: "task" },
        { header: "success a" },
        { header: "success b" },
        { header: "Δ" },
        { header: "wall a" },
        { header: "wall b" },
        { header: "Δ" },
        { header: "tokens a" },
        { header: "tokens b" },
        { header: "Δ" },
        { header: "cost a" },
        { header: "cost b" },
        { header: "Δ" },
        { header: "compactions a" },
        { header: "compactions b" },
        { header: "Δ" },
      ],
      [deltaRowToCells(row)],
    );
    expect(rendered).toContain("fix-flaky-test");
    expect(rendered).toContain("task");
  });

  it("printCompareTable writes the config names, a missing-task note, and every delta row to stdout", () => {
    const results = [
      trial({ taskName: "only-a", configName: "a" }),
      trial({ taskName: "both", configName: "a" }),
      trial({ taskName: "both", configName: "b" }),
    ];
    const table = buildCompareTable(results, "config-a", "config-b");
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      printCompareTable(table);
    } finally {
      spy.mockRestore();
    }
    const out = writes.join("");
    expect(out).toContain("config-a");
    expect(out).toContain("config-b");
    expect(out).toContain("only-a");
    expect(out).toContain("both");
  });
});

// ---------------------------------------------------------------------------
// reportHtml.ts — self-contained, zero JS, no external URLs, esc()'d.
// ---------------------------------------------------------------------------

describe("renderBenchReportHtml", () => {
  it("emits no <script> tags and no external URLs", () => {
    const results = [trial({ configName: "a" }), trial({ configName: "b" })];
    const table = buildCompareTable(results, "a", "b");
    const html = renderBenchReportHtml(table, {
      harness: "claude-code",
      peekVersion: "0.1.0",
      generatedAtISO: "2026-08-08T00:00:00.000Z",
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("<!doctype html>");
  });

  it("escapes task/config names — no unescaped HTML from suite content", () => {
    const maliciousTask = '<img src=x onerror="alert(1)">';
    const maliciousConfig = 'a" onmouseover="steal()';
    const results: TrialResult[] = [
      trial({ taskName: maliciousTask, configName: maliciousConfig }),
      trial({ taskName: maliciousTask, configName: "b" }),
    ];
    const table = buildCompareTable(results, maliciousConfig, "b");
    const html = renderBenchReportHtml(table, {
      harness: "claude-code",
      peekVersion: "0.1.0",
      generatedAtISO: "2026-08-08T00:00:00.000Z",
    });
    expect(html).not.toContain(maliciousTask);
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain("&lt;img");
  });

  it("carries a dark-theme block (prefers-color-scheme), not just a single hardcoded palette", () => {
    const table = buildCompareTable([trial()], "a", "b");
    const html = renderBenchReportHtml(table, {
      harness: "claude-code",
      peekVersion: "0.1.0",
      generatedAtISO: "2026-08-08T00:00:00.000Z",
    });
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("never leaks a BenchTask's prompt text — CompareTable carries none, so the HTML can't either", () => {
    const table = buildCompareTable(
      [trial({ taskName: "fix-flaky-test" })],
      "a",
      "b",
    );
    const html = renderBenchReportHtml(table, {
      harness: "claude-code",
      peekVersion: "0.1.0",
      generatedAtISO: "2026-08-08T00:00:00.000Z",
    });
    expect(html).not.toContain("Fix the failing test");
  });
});

// ---------------------------------------------------------------------------
// run.ts — orchestrate() against a MOCK runner + mock deps. No real agents,
// no real git worktrees.
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<BenchTask> = {}): BenchTask {
  return {
    name: "fix-flaky-test",
    prompt: "Fix the failing test in tests/date.test.ts",
    verify: "npm test",
    timeoutS: 60,
    ...overrides,
  };
}

function makeFakeWriter(): ResultsWriter & { appended: TrialResult[] } {
  const appended: TrialResult[] = [];
  return {
    dir: "/fake",
    path: "/fake/results.jsonl",
    appended,
    async append(result: TrialResult): Promise<void> {
      appended.push(result);
    },
  };
}

function makeMockDeps(
  overrides: Partial<OrchestrateDeps> = {},
): OrchestrateDeps {
  return {
    createWorkspace: vi.fn(async (_repoDir, _scratchRoot, id) => ({
      dir: `/fake/ws/${id}`,
      id,
      isWorktree: false,
      repoDir: "/fake/repo",
    })),
    destroyWorkspace: vi.fn(async () => {}),
    runSetup: vi.fn(async () => ({ ok: true })),
    applyConfig: vi.fn(async () => ({})),
    runVerify: vi.fn(async () => ({ exitCode: 0, timedOut: false })),
    parseSessionTotals: vi.fn(async () => totals()),
    now: () => new Date("2026-08-08T00:00:00.000Z"),
    ...overrides,
  };
}

function makeMockRunner(
  outcome: Partial<TrialOutcome> = {},
): BenchRunner & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(
    async (_trial: TrialSpec): Promise<TrialOutcome> => ({
      exitCode: 0,
      timedOut: false,
      wallMs: 1_000,
      sessionPath: "/fake/session.jsonl",
      stderrTail: "",
      ...outcome,
    }),
  );
  return { harness: "claude-code", run };
}

describe("orchestrate — mocked runner + mocked deps", () => {
  it("runs the full task x config x trial matrix, appending each TrialResult", async () => {
    const writer = makeFakeWriter();
    const runner = makeMockRunner();
    const deps = makeMockDeps();

    const opts: OrchestrateOptions = {
      suite: [makeTask()],
      configs: [
        { name: "a", dir: "current" },
        { name: "b", dir: "/fake/configs/b" },
      ],
      harness: "claude-code",
      runner,
      repoDir: "/fake/repo",
      trials: 2,
      resultsWriter: writer,
      deps,
    };
    const outcome = await orchestrate(opts);

    expect(outcome.aborted).toBe(false);
    expect(outcome.results).toHaveLength(4); // 1 task x 2 configs x 2 trials
    expect(writer.appended).toHaveLength(4);
    expect(runner.run).toHaveBeenCalledTimes(4);
    expect(deps.createWorkspace).toHaveBeenCalledTimes(4);
    expect(deps.destroyWorkspace).toHaveBeenCalledTimes(4);

    const first = outcome.results[0];
    expect(first?.taskName).toBe("fix-flaky-test");
    expect(first?.configName).toBe("a");
    expect(first?.verify).toEqual({ exitCode: 0, passed: true });
    expect(first?.totals).toEqual(totals());
    expect(first?.startedAt).toBe("2026-08-08T00:00:00.000Z");
  });

  it("destroys the workspace even when the runner throws", async () => {
    const writer = makeFakeWriter();
    const deps = makeMockDeps();
    const runner: BenchRunner = {
      harness: "claude-code",
      run: vi.fn(async () => {
        throw new Error("agent process crashed");
      }),
    };

    const opts: OrchestrateOptions = {
      suite: [makeTask()],
      configs: [{ name: "a", dir: "current" }],
      harness: "claude-code",
      runner,
      repoDir: "/fake/repo",
      trials: 1,
      resultsWriter: writer,
      deps,
    };
    await expect(orchestrate(opts)).rejects.toThrow("agent process crashed");
    expect(deps.destroyWorkspace).toHaveBeenCalledTimes(1);
  });

  it("a failing setup command aborts just that trial (recorded as failed, runner never invoked)", async () => {
    const writer = makeFakeWriter();
    const runner = makeMockRunner();
    const deps = makeMockDeps({
      runSetup: vi.fn(async () => ({
        ok: false,
        failedCommand: "npm ci",
        exitCode: 1,
        stderrTail: "network unreachable",
      })),
    });

    const opts: OrchestrateOptions = {
      suite: [makeTask({ setup: ["npm ci"] })],
      configs: [{ name: "a", dir: "current" }],
      harness: "claude-code",
      runner,
      repoDir: "/fake/repo",
      trials: 1,
      resultsWriter: writer,
      deps,
    };
    const outcome = await orchestrate(opts);

    expect(runner.run).not.toHaveBeenCalled();
    expect(outcome.results).toHaveLength(1);
    const result = outcome.results[0];
    expect(result?.exitCode).toBe(1);
    expect(result?.stderrTail).toBe("network unreachable");
    expect(result?.verify).toEqual({ exitCode: null, passed: false });
    expect(result?.totals).toBeUndefined();
    expect(deps.destroyWorkspace).toHaveBeenCalledTimes(1);
  });

  it("a failing verify command records verify.passed:false without failing the trial", async () => {
    const writer = makeFakeWriter();
    const runner = makeMockRunner();
    const deps = makeMockDeps({
      runVerify: vi.fn(async () => ({ exitCode: 1, timedOut: false })),
    });

    const outcome = await orchestrate({
      suite: [makeTask()],
      configs: [{ name: "a", dir: "current" }],
      harness: "claude-code",
      runner,
      repoDir: "/fake/repo",
      trials: 1,
      resultsWriter: writer,
      deps,
    });

    expect(outcome.results[0]?.verify).toEqual({ exitCode: 1, passed: false });
  });

  it("a trial with no sessionPath never calls parseSessionTotals and records totals:undefined", async () => {
    const writer = makeFakeWriter();
    const runner: BenchRunner = {
      harness: "claude-code",
      run: vi.fn(
        async (): Promise<TrialOutcome> => ({
          exitCode: 0,
          timedOut: false,
          wallMs: 1_000,
          stderrTail: "", // no sessionPath key at all — exactOptionalPropertyTypes
        }),
      ),
    };
    const deps = makeMockDeps();

    const outcome = await orchestrate({
      suite: [makeTask()],
      configs: [{ name: "a", dir: "current" }],
      harness: "claude-code",
      runner,
      repoDir: "/fake/repo",
      trials: 1,
      resultsWriter: writer,
      deps,
    });

    expect(deps.parseSessionTotals).not.toHaveBeenCalled();
    expect(outcome.results[0]?.totals).toBeUndefined();
  });

  it("aborts BETWEEN trials once --max-cost is reached (never mid-trial)", async () => {
    const writer = makeFakeWriter();
    const runner = makeMockRunner();
    const deps = makeMockDeps({
      parseSessionTotals: vi.fn(async () => totals({ cost: 6, priced: true })),
    });

    const outcome = await orchestrate({
      suite: [makeTask()],
      configs: [{ name: "a", dir: "current" }],
      harness: "claude-code",
      runner,
      repoDir: "/fake/repo",
      trials: 3,
      maxCostUsd: 5,
      resultsWriter: writer,
      deps,
    });

    // First trial always runs (spend starts at 0); after it, spend ($6) >= ceiling ($5),
    // so the 2nd/3rd trials never start.
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(outcome.aborted).toBe(true);
    expect(outcome.abortReason).toMatch(/max-cost/);
    expect(outcome.results).toHaveLength(1);
  });

  it("passes the config variant's resolved model through to TrialSpec", async () => {
    const writer = makeFakeWriter();
    const runner = makeMockRunner();
    const deps = makeMockDeps({
      applyConfig: vi.fn(async () => ({ model: "claude-opus-5" })),
    });

    await orchestrate({
      suite: [makeTask()],
      configs: [{ name: "b", dir: "/fake/configs/b" }],
      harness: "claude-code",
      runner,
      repoDir: "/fake/repo",
      trials: 1,
      resultsWriter: writer,
      deps,
    });

    const call = runner.run.mock.calls[0]?.[0] as TrialSpec;
    expect(call.model).toBe("claude-opus-5");
    expect(call.configName).toBe("b");
  });
});
