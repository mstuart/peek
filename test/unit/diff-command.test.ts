// `peek diff` (T5.1b) gate — commands/diff.ts's pure buildDiffReport +
// the --last 2 scope-resolution wiring + the CLI-layer I/O entry point
// (runDiffCommand). Pipeline under test mirrors diff-core.test.ts's own
// documented precondition: parse -> dedupSession -> computeComposition ->
// finalizeCompactions -> priceSession — reused here via loadDiffSession
// (commands/diff.ts), not re-derived.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "../../src/adapters/claude/discover.js";
import { discoverCodexSessions } from "../../src/adapters/codex/discover.js";
import {
  buildDiffLastNReport,
  buildDiffReport,
  buildSelectLastComparableOptions,
  loadDiffSession,
  runDiffCommand,
} from "../../src/commands/diff.js";
import { diffSessions, selectLastComparable } from "../../src/engine/diff.js";
import type { Session, SessionRef } from "../../src/model/types.js";
import { formatNumber } from "../../src/render/table.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_FIXTURES_ROOT = join(__dirname, "../fixtures/claude-code");
const CODEX_FIXTURES_ROOT = join(__dirname, "../fixtures/codex");

async function claudeRefs(): Promise<SessionRef[]> {
  return discoverClaudeSessions([CLAUDE_FIXTURES_ROOT]);
}

async function codexRefs(): Promise<SessionRef[]> {
  return discoverCodexSessions([CODEX_FIXTURES_ROOT]);
}

function findRef(
  all: SessionRef[],
  predicate: (r: SessionRef) => boolean,
): SessionRef {
  const ref = all.find(predicate);
  if (!ref) throw new Error("fixture ref not found");
  return ref;
}

async function processedClaudeSession(path: string): Promise<Session> {
  const ref = findRef(await claudeRefs(), (r) => r.path.endsWith(path));
  return loadDiffSession(ref);
}

async function processedCodexSession(path: string): Promise<Session> {
  const ref = findRef(await codexRefs(), (r) => r.path.endsWith(path));
  return loadDiffSession(ref);
}

// ---------------------------------------------------------------------------
// buildDiffReport — fixture pairs.
// ---------------------------------------------------------------------------

describe("buildDiffReport", () => {
  it("claude cache-heavy vs claude compaction: exact delta arithmetic, no comparability warnings", async () => {
    const a = await processedClaudeSession("cache-heavy.jsonl");
    const b = await processedClaudeSession("compaction.jsonl");
    const report = buildDiffReport(diffSessions(a, b));

    expect(report.comparabilityWarnings).toEqual([]);

    // Same raw figures diff-core.test.ts verifies against the fixture
    // content directly (docs/DESIGN.md pipeline precondition, reused via
    // loadDiffSession rather than re-derived here).
    const byClass = Object.fromEntries(
      report.totals.map((r) => [r.tokenClass, r]),
    );
    expect(byClass.inputUncached).toMatchObject({
      a: 350,
      b: 15200,
      delta: 14850,
    });
    expect(byClass.inputUncached?.deltaLabel).toBe("+14,850");
    expect(byClass.cacheRead).toMatchObject({ a: 200, b: 5800, delta: 5600 });
    expect(byClass.cacheWrite5m).toMatchObject({
      a: 1400,
      b: 2000,
      delta: 600,
    });
    expect(byClass.cacheWrite1h).toMatchObject({
      a: 1000,
      b: 0,
      delta: -1000,
    });
    expect(byClass.cacheWrite1h?.deltaLabel).toBe("-1,000");
    expect(byClass.cacheWrite1h?.pctLabel).toBe("-100.0%");
    expect(byClass.output).toMatchObject({ a: 200, b: 750, delta: 550 });

    // compaction.jsonl has exactly one CompactionEvent; cache-heavy.jsonl none.
    expect(report.compactions).toMatchObject({
      countA: 0,
      countB: 1,
      shrinkTotalA: 0,
      shrinkTotalB: 17000,
      discardedEstA: 0,
      discardedEstB: 17040,
    });
    expect(report.compactions.shrinkTotalLabelA).toBe("0");
    expect(report.compactions.shrinkTotalLabelB).toBe("17,000");
    expect(report.compactions.discardedEstLabelA).toBe("~0");
    expect(report.compactions.discardedEstLabelB).toBe("~17,040");

    expect(report.cost.bothPriced).toBe(true);
    expect(report.cost.a).toBeCloseTo(0.0256, 6);
    expect(report.cost.b).toBeCloseTo(0.04406, 6);
    expect(report.cost.aLabel).not.toBe("—");
    expect(report.cost.deltaLabel.startsWith("+")).toBe(true);

    // Neither claude fixture logs configSnapshot.systemPrompt (codex-only
    // field per the USM) — "unknown", never a guessed same/differs.
    expect(report.config).toContain("system prompt: unknown");

    expect(report.residual.label).toBe(
      "system prompt + tool schemas + framing (not logged by this harness)",
    );
  });

  it("codex real-capture vs codex full-turn: systemPrompt differs", async () => {
    const a = await processedCodexSession("full-turn.jsonl");
    const b = await processedCodexSession("real-capture-redacted.jsonl");
    const report = buildDiffReport(diffSessions(a, b));

    expect(report.config).toContain("system prompt: differs");
  });

  it("claude cache-heavy vs codex full-turn: harness-differs comparability warning", async () => {
    const a = await processedClaudeSession("cache-heavy.jsonl");
    const b = await processedCodexSession("full-turn.jsonl");
    const report = buildDiffReport(diffSessions(a, b));

    expect(report.comparabilityWarnings).toContain(
      "harness differs: a=claude-code b=codex",
    );
    expect(report.meta.a.harness).toBe("claude-code");
    expect(report.meta.b.harness).toBe("codex");
  });

  it("composition rows: only non-zero categories, residual always present with its label", async () => {
    const a = await processedClaudeSession("cache-heavy.jsonl");
    const b = await processedClaudeSession("compaction.jsonl");
    const report = buildDiffReport(diffSessions(a, b));

    for (const row of report.composition) {
      expect(row.a !== 0 || row.b !== 0).toBe(true);
      expect(row.aLabel.startsWith("~")).toBe(true);
    }
    expect(report.residual.aLabel.startsWith("~")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildDiffLastNReport (v2, Lane F5) — `peek diff --last N` for N>2: a
// compact pairwise-vs-first table over already-processed fixture sessions.
// ---------------------------------------------------------------------------

describe("buildDiffLastNReport", () => {
  it("3 sessions: base is sessions[0], one delta column per older session, row set covers meta/totals/cost/compactions", async () => {
    const base = await processedClaudeSession("compaction.jsonl");
    const older1 = await processedClaudeSession("cache-heavy.jsonl");
    const older2 = await processedClaudeSession("normal-turns.jsonl");
    const report = buildDiffLastNReport([base, older1, older2]);

    expect(report.base.id).toBe("compaction");
    expect(report.others.map((o) => o.id)).toEqual([
      "cache-heavy",
      "normal-turns",
    ]);
    expect(report.comparabilityWarnings).toHaveLength(2);
    for (const row of report.rows) {
      expect(row.deltaLabels).toHaveLength(2);
    }

    const byLabel = Object.fromEntries(report.rows.map((r) => [r.label, r]));
    expect(byLabel.turns?.baseLabel).toBe(formatNumber(base.turns.length));
    // compaction.jsonl (base) has 1 compaction; cache-heavy.jsonl has 0 ->
    // delta -1.
    expect(byLabel["compactions (count)"]?.baseLabel).toBe("1");
    expect(byLabel["compactions (count)"]?.deltaLabels[0]).toBe("-1");

    // Same exact cost figures diff-core.test.ts verifies directly for this
    // pair (base=compaction ~0.04406, older1=cache-heavy ~0.0256).
    expect(byLabel.cost?.baseLabel).not.toBe("—");
  });

  it("throws when given fewer than 2 sessions", async () => {
    const base = await processedClaudeSession("compaction.jsonl");
    expect(() => buildDiffLastNReport([base])).toThrow(/at least 2/);
  });
});

// ---------------------------------------------------------------------------
// --last 2 scope resolution — pure wiring (buildSelectLastComparableOptions
// -> selectLastComparable), tested the same way diff-core.test.ts proves the
// engine's own selection algorithm: synthetic SessionRef sets, no I/O.
// ---------------------------------------------------------------------------

describe("buildSelectLastComparableOptions + selectLastComparable (--last 2 wiring)", () => {
  const T = (iso: string) => new Date(iso);

  function ref(over: Partial<SessionRef>): SessionRef {
    return {
      harness: "claude-code",
      id: "id",
      path: "/path",
      sizeBytes: 100,
      mtime: T("2026-08-08T00:00:00.000Z"),
      kind: "main",
      ...over,
    };
  }

  // Mirrors diff-core.test.ts's multi-cwd, multi-harness fixture-ref set
  // (audit R3-F3 gate case): a codex ref with unknowable cwd is the MOST
  // RECENT ref overall, so naive scoping would wrongly hijack harness
  // inference for a claude-code, project-a-scoped query.
  const refs: SessionRef[] = [
    ref({
      id: "a-old",
      harness: "claude-code",
      cwd: "project-a",
      mtime: T("2026-08-01T10:00:00.000Z"),
    }),
    ref({
      id: "a-new",
      harness: "claude-code",
      cwd: "project-a",
      mtime: T("2026-08-05T10:00:00.000Z"),
    }),
    ref({
      id: "b-project",
      harness: "claude-code",
      cwd: "project-b",
      mtime: T("2026-08-06T10:00:00.000Z"),
    }),
    ref({
      id: "codex-newest",
      harness: "codex",
      mtime: T("2026-08-09T10:00:00.000Z"),
    }),
  ];

  it("--cwd maps straight through as scopeCwd, discriminating project-a from project-b/codex", () => {
    const opts = buildSelectLastComparableOptions(
      { cwd: "project-a" },
      "unused-default-scope",
    );
    const result = selectLastComparable(refs, opts);
    expect(result.reason).toBeUndefined();
    expect(result.refs?.map((r) => r.id)).toEqual(["a-new", "a-old"]);
  });

  it("no --cwd falls back to the already-resolved `scope` argument", () => {
    const opts = buildSelectLastComparableOptions({}, "project-a");
    const result = selectLastComparable(refs, opts);
    expect(result.refs?.map((r) => r.id)).toEqual(["a-new", "a-old"]);
  });

  it("--all-projects ignores scope entirely, even when --cwd is also set", () => {
    const opts = buildSelectLastComparableOptions(
      { cwd: "project-a", allProjects: true },
      "project-a",
    );
    expect(opts.scopeCwd).toBeUndefined();
    expect(opts.allProjects).toBe(true);
    // Only one codex ref exists, so widening still can't produce a
    // same-harness pair once codex wins the most-recent-overall tiebreak.
    const result = selectLastComparable(refs, opts);
    expect(result.reason).toMatch(/fewer than 2/);
  });

  it("--harness widens to unknowable-cwd refs of that harness", () => {
    const withSecondCodexRef = [
      ...refs,
      ref({
        id: "codex-older",
        harness: "codex" as const,
        mtime: T("2026-08-02T10:00:00.000Z"),
      }),
    ];
    const opts = buildSelectLastComparableOptions(
      { cwd: "project-a", harness: "codex" },
      "project-a",
    );
    const result = selectLastComparable(withSecondCodexRef, opts);
    expect(result.refs?.map((r) => r.id)).toEqual([
      "codex-newest",
      "codex-older",
    ]);
  });
});

// ---------------------------------------------------------------------------
// runDiffCommand — I/O smoke coverage: the <2-candidates exit path reports
// via stdout + process.exitCode (the runner layer), never throws.
// ---------------------------------------------------------------------------

describe("runDiffCommand", () => {
  let emptyDir: string;

  beforeEach(() => {
    emptyDir = mkdtempSync(join(tmpdir(), "peek-diff-test-"));
  });

  afterEach(() => {
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("--last 2 with fewer than 2 in-scope candidates: reports the reason, sets exit code 2, does not throw", async () => {
    const originalExitCode = process.exitCode;
    const originalWrite = process.stdout.write.bind(process.stdout);
    let written = "";
    process.stdout.write = ((chunk: string) => {
      written += chunk;
      return true;
    }) as typeof process.stdout.write;

    try {
      await expect(
        runDiffCommand(undefined, undefined, {
          last: 2,
          harness: "codex",
          cwd: "project-a",
          roots: {
            "claude-code": [emptyDir],
            codex: [join(CODEX_FIXTURES_ROOT, "v0.88")], // exactly 1 fixture
            pi: [emptyDir],
          },
        }),
      ).resolves.toBeUndefined();
      expect(process.exitCode).toBe(2);
      expect(written).toMatch(/fewer than 2|no candidate/);
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = originalExitCode;
    }
  });

  it("rejects --last outside 2..5 (v2, Lane F5 generalization)", async () => {
    await expect(
      runDiffCommand(undefined, undefined, { last: 1 }),
    ).rejects.toThrow(/between 2 and 5/);
    await expect(
      runDiffCommand(undefined, undefined, { last: 6 }),
    ).rejects.toThrow(/between 2 and 5/);
  });

  it("--last 3 with fewer than 3 in-scope candidates: reports the reason, sets exit code 2", async () => {
    const originalExitCode = process.exitCode;
    const originalWrite = process.stdout.write.bind(process.stdout);
    let written = "";
    process.stdout.write = ((chunk: string) => {
      written += chunk;
      return true;
    }) as typeof process.stdout.write;

    try {
      await expect(
        runDiffCommand(undefined, undefined, {
          last: 3,
          harness: "codex",
          cwd: "project-a",
          roots: {
            "claude-code": [emptyDir],
            codex: [join(CODEX_FIXTURES_ROOT, "v0.88")], // exactly 1 fixture
            pi: [emptyDir],
          },
        }),
      ).resolves.toBeUndefined();
      expect(process.exitCode).toBe(2);
      expect(written).toMatch(/fewer than 3|no candidate/);
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = originalExitCode;
    }
  });

  it("rejects <a> <b> combined with --last", async () => {
    await expect(runDiffCommand("a", "b", { last: 2 })).rejects.toThrow(
      /not both/,
    );
  });

  it("rejects a bare `peek diff` with neither <a>/<b> nor --last", async () => {
    await expect(runDiffCommand(undefined, undefined, {})).rejects.toThrow(
      /requires <a> <b>, or --last <n>/,
    );
  });

  it("--last 3: prints the compact DiffLastNReport as JSON, exit 0", async () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    let written = "";
    process.stdout.write = ((chunk: string) => {
      written += chunk;
      return true;
    }) as typeof process.stdout.write;

    try {
      await runDiffCommand(undefined, undefined, {
        last: 3,
        harness: "claude-code",
        allProjects: true,
        roots: { "claude-code": [CLAUDE_FIXTURES_ROOT] },
        json: true,
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    const parsed = JSON.parse(written);
    expect(parsed.others).toHaveLength(2);
    expect(parsed.rows.length).toBeGreaterThan(0);
  });

  it("--json <a> <b>: prints the DiffReport as JSON, exit 0", async () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    let written = "";
    process.stdout.write = ((chunk: string) => {
      written += chunk;
      return true;
    }) as typeof process.stdout.write;

    try {
      await runDiffCommand("cache-heavy", "compaction", {
        harness: "claude-code",
        roots: { "claude-code": [CLAUDE_FIXTURES_ROOT] },
        json: true,
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    const parsed = JSON.parse(written);
    expect(parsed.meta.a.id).toBe("cache-heavy");
    expect(parsed.meta.b.id).toBe("compaction");
    expect(parsed.comparabilityWarnings).toEqual([]);
  });
});
