// A4 gate (docs/DESIGN.md § Bench design, task A4) — covers:
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
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { buildCompareTable, groupCells } from "../../src/bench/compare.js";
import { renderBenchReportHtml } from "../../src/bench/reportHtml.js";
import type { ResultsWriter } from "../../src/bench/results.js";
import {
  createResultsWriter,
  parseResultsJsonl,
  readResults,
} from "../../src/bench/results.js";
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

const TEST_PATTERN_1 = /max-cost/;
const TEST_PATTERN_2 = /<script/i;
const TEST_PATTERN_3 = /https?:\/\//;

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function totals(overrides: Partial<SessionTotalsLike> = {}): SessionTotalsLike {
  return {
    compactionCount: 0,
    cost: 0.05,
    priced: true,
    tokens: {
      cacheRead: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      contextTotal: 150,
      inputUncached: 100,
      output: 50,
    },
    ...overrides,
  };
}

function trial(overrides: Partial<TrialResult> = {}): TrialResult {
  return {
    configName: "a",
    exitCode: 0,
    harness: "claude-code",
    startedAt: "2026-08-08T00:00:00.000Z",
    stderrTail: "",
    taskName: "fix-flaky-test",
    timedOut: false,
    totals: totals(),
    trialIndex: 0,
    verify: { exitCode: 0, passed: true },
    wallMs: 10_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// compare.ts — pure aggregation.
// ---------------------------------------------------------------------------

describe("groupCells", () => {
  it("groups by (taskName, configName), preserving first-seen order", () => {
    const results = [
      trial({ configName: "a", taskName: "t1", trialIndex: 0 }),
      trial({ configName: "b", taskName: "t1", trialIndex: 0 }),
      trial({ configName: "a", taskName: "t2", trialIndex: 0 }),
      trial({ configName: "a", taskName: "t1", trialIndex: 1 }),
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
    const cell = table.cells.at(0);
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
        totals: totals({
          tokens: {
            cacheRead: 0,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            contextTotal: 100,
            inputUncached: 0,
            output: 0,
          },
        }),
        trialIndex: 0,
      }),
      trial({
        totals: totals({
          tokens: {
            cacheRead: 0,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            contextTotal: 300,
            inputUncached: 0,
            output: 0,
          },
        }),
        trialIndex: 1,
      }),
      trial({
        totals: totals({
          tokens: {
            cacheRead: 0,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            contextTotal: 200,
            inputUncached: 0,
            output: 0,
          },
        }),
        trialIndex: 2,
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
            cacheRead: 0,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            contextTotal: 1000,
            inputUncached: 0,
            output: 0,
          },
        }),
        wallMs: 20_000,
      }),
      trial({
        configName: "b",
        totals: totals({
          cost: 0.05,
          tokens: {
            cacheRead: 0,
            cacheWrite1h: 0,
            cacheWrite5m: 0,
            contextTotal: 500,
            inputUncached: 0,
            output: 0,
          },
        }),
        wallMs: 10_000,
      }),
    ];
    const table = buildCompareTable(results, "a", "b");
    const delta = table.deltas.at(0);
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
      trial({ totals: totals({ cost: 0.1 }), trialIndex: 0 }),
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
    const cell = table.cells.at(0);
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
    const cell = table.cells.at(0);
    expect(cell?.totalsCount).toBe(0);
    expect(cell?.medianTokens).toBeNull();
    expect(cell?.medianTokensLabel).toBe("—");
    expect(cell?.medianCost).toBeNull();
    expect(cell?.medianCostLabel).toBe("—");
    expect(cell?.compactionTotal).toBeNull();
    expect(cell?.compactionTotalLabel).toBe("—");
  });

  it("honesty convention: totals present but unpriced (unknown model) -> medianCost '—' while tokens still render", () => {
    const results = [trial({ totals: totals({ cost: 0, priced: false }) })];
    const table = buildCompareTable(results, "a", "b");
    const cell = table.cells.at(0);
    expect(cell?.totalsCount).toBe(1);
    expect(cell?.pricedCount).toBe(0);
    expect(cell?.medianCostLabel).toBe("—");
    expect(cell?.medianTokensLabel).not.toBe("—");
  });

  it("reports tasks missing from one side rather than silently dropping them", () => {
    const results = [
      trial({ configName: "a", taskName: "only-in-a" }),
      trial({ configName: "a", taskName: "in-both" }),
      trial({ configName: "b", taskName: "in-both" }),
    ];
    const table = buildCompareTable(results, "a", "b");
    expect(table.deltas.map((d) => d.taskName)).toEqual(["in-both"]);
    expect(table.missing).toEqual([
      { missingConfig: "b", taskName: "only-in-a" },
    ]);
  });

  it("overall summary row aggregates across ALL tasks per config", () => {
    const results = [
      trial({
        configName: "a",
        taskName: "t1",
        verify: { exitCode: 0, passed: true },
        wallMs: 10_000,
      }),
      trial({
        configName: "a",
        taskName: "t2",
        verify: { exitCode: 1, passed: false },
        wallMs: 30_000,
      }),
      trial({
        configName: "b",
        taskName: "t1",
        verify: { exitCode: 0, passed: true },
        wallMs: 5000,
      }),
      trial({
        configName: "b",
        taskName: "t2",
        verify: { exitCode: 0, passed: true },
        wallMs: 15_000,
      }),
    ];
    const table = buildCompareTable(results, "a", "b");
    assert(table.overall);
    expect(table.overall.a.trialCount).toBe(2);
    expect(table.overall.a.successCount).toBe(1);
    expect(table.overall.b.successCount).toBe(2);
    expect(table.overall.delta.taskName).toBe("ALL TASKS");
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
    await writer.append(trial({ configName: "b", trialIndex: 1 }));

    const { results, warnings } = await readResults(writer.path);
    expect(warnings).toEqual([]);
    expect(results).toHaveLength(2);
    expect(results[0]?.trialIndex).toBe(0);
    expect(results[1]?.configName).toBe("b");
    // Round-tripped through JSON — verify a nested field survives intact.
    const firstResult = results.at(0);
    assert(firstResult);
    assert(firstResult.totals);
    expect(firstResult.totals.tokens.contextTotal).toBe(150);
  });

  it("writes under <baseDir>/<ISO-ts>/results.jsonl with colons/dots slugified", async () => {
    dir = mkdtempSync(join(tmpdir(), "peek-bench-results-"));
    const writer = await createResultsWriter({
      baseDir: dir,
      timestamp: new Date("2026-08-08T17:22:10.123Z"),
    });
    expect(writer.path).toBe(
      join(dir, "2026-08-08T17-22-10-123Z", "results.jsonl")
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
    const row = table.deltas.at(0);
    expect(row).toBeDefined();
    if (!row) {
      throw new Error("unreachable");
    }
    const cells = deltaRowToCells(row);
    expect(cells).toHaveLength(16);
    expect(cells[0]).toBe("fix-flaky-test");
  });

  it("renderTable renders the delta row cells into an aligned table containing the task name and configs", () => {
    const results = [trial({ configName: "a" }), trial({ configName: "b" })];
    const table = buildCompareTable(results, "a", "b");
    const row = table.deltas.at(0);
    if (!row) {
      throw new Error("unreachable");
    }
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
      [deltaRowToCells(row)]
    );
    expect(rendered).toContain("fix-flaky-test");
    expect(rendered).toContain("task");
  });

  it("printCompareTable writes the config names, a missing-task note, and every delta row to stdout", () => {
    const results = [
      trial({ configName: "a", taskName: "only-a" }),
      trial({ configName: "a", taskName: "both" }),
      trial({ configName: "b", taskName: "both" }),
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
      generatedAtISO: "2026-08-08T00:00:00.000Z",
      harness: "claude-code",
      peekVersion: "0.1.0",
    });
    expect(html).not.toMatch(TEST_PATTERN_2);
    expect(html).not.toMatch(TEST_PATTERN_3);
    expect(html).toContain("<!doctype html>");
  });

  it("escapes task/config names — no unescaped HTML from suite content", () => {
    const maliciousTask = '<img src=x onerror="alert(1)">';
    const maliciousConfig = 'a" onmouseover="steal()';
    const results: TrialResult[] = [
      trial({ configName: maliciousConfig, taskName: maliciousTask }),
      trial({ configName: "b", taskName: maliciousTask }),
    ];
    const table = buildCompareTable(results, maliciousConfig, "b");
    const html = renderBenchReportHtml(table, {
      generatedAtISO: "2026-08-08T00:00:00.000Z",
      harness: "claude-code",
      peekVersion: "0.1.0",
    });
    expect(html).not.toContain(maliciousTask);
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain("&lt;img");
  });

  it("carries a dark-theme block (prefers-color-scheme), not just a single hardcoded palette", () => {
    const table = buildCompareTable([trial()], "a", "b");
    const html = renderBenchReportHtml(table, {
      generatedAtISO: "2026-08-08T00:00:00.000Z",
      harness: "claude-code",
      peekVersion: "0.1.0",
    });
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("never leaks a BenchTask's prompt text — CompareTable carries none, so the HTML can't either", () => {
    const table = buildCompareTable(
      [trial({ taskName: "fix-flaky-test" })],
      "a",
      "b"
    );
    const html = renderBenchReportHtml(table, {
      generatedAtISO: "2026-08-08T00:00:00.000Z",
      harness: "claude-code",
      peekVersion: "0.1.0",
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
    timeoutS: 60,
    verify: "npm test",
    ...overrides,
  };
}

function makeFakeWriter(): ResultsWriter & { appended: TrialResult[] } {
  const appended: TrialResult[] = [];
  return {
    append(result: TrialResult): Promise<void> {
      appended.push(result);
      return Promise.resolve();
    },
    appended,
    dir: "/fake",
    path: "/fake/results.jsonl",
  };
}

function makeMockDeps(
  overrides: Partial<OrchestrateDeps> = {}
): OrchestrateDeps {
  return {
    applyConfig: vi.fn(async () => ({})),
    createWorkspace: vi.fn(async (_repoDir, _scratchRoot, id) => ({
      dir: `/fake/ws/${id}`,
      id,
      isWorktree: false,
      repoDir: "/fake/repo",
    })),
    destroyWorkspace: vi.fn(async () => undefined),
    now: () => new Date("2026-08-08T00:00:00.000Z"),
    parseSessionTotals: vi.fn(async () => totals()),
    runSetup: vi.fn(async () => ({ ok: true })),
    runVerify: vi.fn(async () => ({ exitCode: 0, timedOut: false })),
    ...overrides,
  };
}

function makeMockRunner(
  outcome: Partial<TrialOutcome> = {}
): BenchRunner & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(
    async (_trial: TrialSpec): Promise<TrialOutcome> => ({
      exitCode: 0,
      sessionPath: "/fake/session.jsonl",
      stderrTail: "",
      timedOut: false,
      wallMs: 1000,
      ...outcome,
    })
  );
  return { harness: "claude-code", run };
}

describe("orchestrate — mocked runner + mocked deps", () => {
  it("runs the full task x config x trial matrix, appending each TrialResult", async () => {
    const writer = makeFakeWriter();
    const runner = makeMockRunner();
    const deps = makeMockDeps();

    const opts: OrchestrateOptions = {
      configs: [
        { dir: "current", name: "a" },
        { dir: "/fake/configs/b", name: "b" },
      ],
      deps,
      harness: "claude-code",
      repoDir: "/fake/repo",
      resultsWriter: writer,
      runner,
      suite: [makeTask()],
      trials: 2,
    };
    const outcome = await orchestrate(opts);

    expect(outcome.aborted).toBe(false);
    expect(outcome.results).toHaveLength(4); // 1 task x 2 configs x 2 trials
    expect(writer.appended).toHaveLength(4);
    expect(runner.run).toHaveBeenCalledTimes(4);
    expect(deps.createWorkspace).toHaveBeenCalledTimes(4);
    expect(deps.destroyWorkspace).toHaveBeenCalledTimes(4);

    const first = outcome.results.at(0);
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
      run: vi.fn(() => Promise.reject(new Error("agent process crashed"))),
    };

    const opts: OrchestrateOptions = {
      configs: [{ dir: "current", name: "a" }],
      deps,
      harness: "claude-code",
      repoDir: "/fake/repo",
      resultsWriter: writer,
      runner,
      suite: [makeTask()],
      trials: 1,
    };
    await expect(orchestrate(opts)).rejects.toThrow("agent process crashed");
    expect(deps.destroyWorkspace).toHaveBeenCalledTimes(1);
  });

  it("a failing setup command aborts just that trial (recorded as failed, runner never invoked)", async () => {
    const writer = makeFakeWriter();
    const runner = makeMockRunner();
    const deps = makeMockDeps({
      runSetup: vi.fn(async () => ({
        exitCode: 1,
        failedCommand: "npm ci",
        ok: false,
        stderrTail: "network unreachable",
      })),
    });

    const opts: OrchestrateOptions = {
      configs: [{ dir: "current", name: "a" }],
      deps,
      harness: "claude-code",
      repoDir: "/fake/repo",
      resultsWriter: writer,
      runner,
      suite: [makeTask({ setup: ["npm ci"] })],
      trials: 1,
    };
    const outcome = await orchestrate(opts);

    expect(runner.run).not.toHaveBeenCalled();
    expect(outcome.results).toHaveLength(1);
    const result = outcome.results.at(0);
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
      configs: [{ dir: "current", name: "a" }],
      deps,
      harness: "claude-code",
      repoDir: "/fake/repo",
      resultsWriter: writer,
      runner,
      suite: [makeTask()],
      trials: 1,
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
          stderrTail: "", // no sessionPath key at all — exactOptionalPropertyTypes
          timedOut: false,
          wallMs: 1000,
        })
      ),
    };
    const deps = makeMockDeps();

    const outcome = await orchestrate({
      configs: [{ dir: "current", name: "a" }],
      deps,
      harness: "claude-code",
      repoDir: "/fake/repo",
      resultsWriter: writer,
      runner,
      suite: [makeTask()],
      trials: 1,
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
      configs: [{ dir: "current", name: "a" }],
      deps,
      harness: "claude-code",
      maxCostUsd: 5,
      repoDir: "/fake/repo",
      resultsWriter: writer,
      runner,
      suite: [makeTask()],
      trials: 3,
    });

    // First trial always runs (spend starts at 0); after it, spend ($6) >= ceiling ($5),
    // so the 2nd/3rd trials never start.
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(outcome.aborted).toBe(true);
    expect(outcome.abortReason).toMatch(TEST_PATTERN_1);
    expect(outcome.results).toHaveLength(1);
  });

  it("passes the config variant's resolved model through to TrialSpec", async () => {
    const writer = makeFakeWriter();
    const runner = makeMockRunner();
    const deps = makeMockDeps({
      applyConfig: vi.fn(async () => ({ model: "claude-opus-5" })),
    });

    await orchestrate({
      configs: [{ dir: "/fake/configs/b", name: "b" }],
      deps,
      harness: "claude-code",
      repoDir: "/fake/repo",
      resultsWriter: writer,
      runner,
      suite: [makeTask()],
      trials: 1,
    });

    const call = runner.run.mock.calls[0]?.[0] as TrialSpec;
    expect(call.model).toBe("claude-opus-5");
    expect(call.configName).toBe("b");
  });
});
