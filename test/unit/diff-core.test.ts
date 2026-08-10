// T5.1a gate — engine/diff.ts's pure core: diffSessions and
// selectLastComparable. Pipeline under test matches every other engine
// module's documented precondition (composition.test.ts,
// context-command.test.ts): parse -> dedupSession -> computeComposition ->
// finalizeCompactions -> priceSession.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "../../src/adapters/claude/discover.js";
import { parseClaudeSession } from "../../src/adapters/claude/parse.js";
import { discoverCodexSessions } from "../../src/adapters/codex/discover.js";
import { parseCodexSession } from "../../src/adapters/codex/parse.js";
import { priceSession } from "../../src/engine/accounting.js";
import { finalizeCompactions } from "../../src/engine/compaction.js";
import { computeComposition } from "../../src/engine/composition.js";
import { dedupSession } from "../../src/engine/dedup.js";
import { diffSessions, selectLastComparable } from "../../src/engine/diff.js";
import type { Session, SessionRef } from "../../src/model/types.js";

const TEST_PATTERN_1 = /fewer than 2/;
const TEST_PATTERN_2 = /fewer than 4/;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_FIXTURES_ROOT = join(__dirname, "../fixtures/claude-code");
const CODEX_FIXTURES_ROOT = join(__dirname, "../fixtures/codex");

function claudeRefs(): Promise<SessionRef[]> {
  return discoverClaudeSessions([CLAUDE_FIXTURES_ROOT]);
}

function codexRefs(): Promise<SessionRef[]> {
  return discoverCodexSessions([CODEX_FIXTURES_ROOT]);
}

function findRef(
  all: SessionRef[],
  predicate: (r: SessionRef) => boolean
): SessionRef {
  const ref = all.find(predicate);
  if (!ref) {
    throw new Error("fixture ref not found");
  }
  return ref;
}

/** parse -> dedupSession -> computeComposition -> finalizeCompactions ->
 * priceSession — diffSessions' documented precondition. */
async function processedClaudeSession(path: string): Promise<Session> {
  const ref = findRef(await claudeRefs(), (r) => r.path.endsWith(path));
  const { session } = await parseClaudeSession(ref);
  const deduped = dedupSession(session);
  const composed = computeComposition(deduped);
  const finalized = finalizeCompactions(composed);
  return priceSession(finalized, { mode: "auto" });
}

async function processedCodexSession(path: string): Promise<Session> {
  const ref = findRef(await codexRefs(), (r) => r.path.endsWith(path));
  const { session } = await parseCodexSession(ref);
  const deduped = dedupSession(session);
  const composed = computeComposition(deduped);
  const finalized = finalizeCompactions(composed);
  return priceSession(finalized, { mode: "auto" });
}

describe("diffSessions", () => {
  it("diffs two claude-code fixtures: exact token deltas, 0-vs-1 compactions", async () => {
    const a = await processedClaudeSession("cache-heavy.jsonl");
    const b = await processedClaudeSession("compaction.jsonl");
    const diff = diffSessions(a, b);

    expect(diff.meta.a.turns).toBe(2);
    expect(diff.meta.b.turns).toBe(3);

    // Exact token-class deltas — computed by summing each fixture's own
    // raw usage fields (verified against the fixture content directly).
    expect(diff.totals.inputUncached).toEqual({
      a: 350,
      b: 15_200,
      delta: 14_850,
      pct: 14_850 / 350,
    });
    expect(diff.totals.cacheRead).toEqual({
      a: 200,
      b: 5800,
      delta: 5600,
      pct: 5600 / 200,
    });
    expect(diff.totals.cacheWrite5m).toEqual({
      a: 1400,
      b: 2000,
      delta: 600,
      pct: 600 / 1400,
    });
    expect(diff.totals.cacheWrite1h).toEqual({
      a: 1000,
      b: 0,
      delta: -1000,
      pct: -1,
    });
    expect(diff.totals.output).toEqual({
      a: 200,
      b: 750,
      delta: 550,
      pct: 550 / 200,
    });

    // compaction.jsonl has exactly one CompactionEvent; cache-heavy.jsonl
    // has none.
    expect(diff.compactions.countA).toBe(0);
    expect(diff.compactions.countB).toBe(1);
    expect(diff.compactions.shrinkTotalA).toBe(0);
    expect(diff.compactions.shrinkTotalB).toBe(17_000);
    expect(diff.compactions.discardedEstA).toBe(0);
    expect(diff.compactions.discardedEstB).toBe(17_040);

    expect(diff.cost.bothPriced).toBe(true);
    expect(diff.cost.a).toBeCloseTo(0.0256, 6);
    expect(diff.cost.b).toBeCloseTo(0.044_06, 6);

    // Both fixtures share cwd/gitBranch and turn count/duration stay under
    // the divergence thresholds — no comparability warnings on this pair.
    expect(diff.comparability.warnings).toEqual([]);

    // Neither claude fixture logs configSnapshot.systemPrompt (codex-only
    // field) — "unknown", not a guessed same/differs.
    expect(diff.config.systemPromptChanged).toBe("unknown");
  });

  it("diffs a claude-code fixture against a codex fixture: harness-differs warning", async () => {
    const a = await processedClaudeSession("cache-heavy.jsonl");
    const b = await processedCodexSession("full-turn.jsonl");
    const diff = diffSessions(a, b);

    expect(diff.meta.a.harness).toBe("claude-code");
    expect(diff.meta.b.harness).toBe("codex");
    expect(diff.comparability.warnings).toContain(
      "harness differs: a=claude-code b=codex"
    );
  });

  it("systemPromptChanged: codex vs codex differs; claude vs claude is unknown", async () => {
    const fullTurn = await processedCodexSession("full-turn.jsonl");
    const realCapture = await processedCodexSession(
      "real-capture-redacted.jsonl"
    );
    const codexDiff = diffSessions(fullTurn, realCapture);
    expect(codexDiff.config.systemPromptChanged).toBe("differs");

    const cacheHeavy = await processedClaudeSession("cache-heavy.jsonl");
    const compaction = await processedClaudeSession("compaction.jsonl");
    const claudeDiff = diffSessions(cacheHeavy, compaction);
    expect(claudeDiff.config.systemPromptChanged).toBe("unknown");
  });
});

describe("selectLastComparable", () => {
  const T = (iso: string) => new Date(iso);

  function ref(over: Partial<SessionRef>): SessionRef {
    return {
      harness: "claude-code",
      id: "id",
      kind: "main",
      mtime: T("2026-08-08T00:00:00.000Z"),
      path: "/path",
      sizeBytes: 100,
      ...over,
    };
  }

  // A multi-cwd, multi-harness ref set. A codex ref (cwd unknowable at
  // discovery, per every adapter's real discover.ts) is deliberately the
  // MOST RECENT ref overall, so a naive "newest two by mtime" or a naive
  // "cwd matches OR unknowable" single-pass filter would wrongly pick it
  // into a claude-code, project-A-scoped query (audit R3-F3 gate case).
  const refs: SessionRef[] = [
    ref({
      cwd: "project-a",
      harness: "claude-code",
      id: "a-old",
      mtime: T("2026-08-01T10:00:00.000Z"),
    }),
    ref({
      cwd: "project-a",
      harness: "claude-code",
      id: "a-new",
      mtime: T("2026-08-05T10:00:00.000Z"),
    }),
    ref({
      cwd: "project-b",
      harness: "claude-code",
      id: "b-project",
      mtime: T("2026-08-06T10:00:00.000Z"),
    }),
    ref({
      cwd: "project-a",
      harness: "claude-code",
      id: "a-subagent",
      kind: "subagent",
      mtime: T("2026-08-07T10:00:00.000Z"),
    }),
    ref({
      harness: "codex",
      id: "codex-newest",
      // no cwd — matches every real adapter's discover.ts: codex refs never
      // carry cwd until parse time.
      mtime: T("2026-08-09T10:00:00.000Z"), // newest of ALL refs
    }),
    ref({
      cwd: "project-a",
      harness: "claude-code",
      id: "a-oldest",
      mtime: T("2026-07-25T10:00:00.000Z"),
    }),
  ];

  it("scopes to project-a + claude-code, not the newer codex/project-b refs (R3-F3 gate)", () => {
    const result = selectLastComparable(refs, { scopeCwd: "project-a" });
    expect(result.reason).toBeUndefined();
    const ids = result.refs?.map((r) => r.id);
    expect(ids).toEqual(["a-new", "a-old"]);
  });

  it("excludes kind:subagent even when it's the most recent in-scope ref", () => {
    const result = selectLastComparable(refs, { scopeCwd: "project-a" });
    expect(result.refs?.some((r) => r.id === "a-subagent")).toBe(false);
  });

  it("reports a reason when fewer than 2 candidates are in scope", () => {
    const result = selectLastComparable(refs, { scopeCwd: "project-b" });
    expect(result.refs).toBeUndefined();
    expect(result.reason).toMatch(TEST_PATTERN_1);
  });

  it("reports a reason for a scope with no candidates at all", () => {
    const result = selectLastComparable(refs, { scopeCwd: "no-such-project" });
    expect(result.refs).toBeUndefined();
    expect(result.reason).toBeDefined();
  });

  it("--all-projects widens across cwd, still same-harness (picks codex + nothing else, so <2)", () => {
    // Only one codex ref exists in this set, so widening to all projects
    // still can't produce a same-harness pair once codex wins the
    // most-recent-overall tiebreak.
    const result = selectLastComparable(refs, { allProjects: true });
    expect(result.reason).toMatch(TEST_PATTERN_1);
  });

  it("an explicit harness widens to unknowable-cwd refs of that harness", () => {
    const withSecondCodexRef = [
      ...refs,
      ref({
        harness: "codex",
        id: "codex-older",
        mtime: T("2026-08-02T10:00:00.000Z"),
      }),
    ];
    const result = selectLastComparable(withSecondCodexRef, {
      harness: "codex",
      scopeCwd: "project-a",
    });
    expect(result.refs?.map((r) => r.id)).toEqual([
      "codex-newest",
      "codex-older",
    ]);
  });

  // v2, Lane F5 — `--last N` generalization.
  it("take:3 selects the 3 most recent in-scope refs, most-recent-first", () => {
    const result = selectLastComparable(refs, {
      scopeCwd: "project-a",
      take: 3,
    });
    expect(result.reason).toBeUndefined();
    expect(result.refs?.map((r) => r.id)).toEqual([
      "a-new",
      "a-old",
      "a-oldest",
    ]);
  });

  it("take:4 reports a reason when only 3 candidates are in scope", () => {
    const result = selectLastComparable(refs, {
      scopeCwd: "project-a",
      take: 4,
    });
    expect(result.refs).toBeUndefined();
    expect(result.reason).toMatch(TEST_PATTERN_2);
  });
});
