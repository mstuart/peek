import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "../../src/adapters/claude/discover.js";
import { parseClaudeSession } from "../../src/adapters/claude/parse.js";
import { parsePiSession } from "../../src/adapters/pi/parse.js";
import { priceSession } from "../../src/engine/accounting.js";
import {
  byMcpServer,
  byModel,
  bySubagent,
  byTool,
  cacheAnalysis,
  UNATTRIBUTED_TOOL,
} from "../../src/engine/attribution.js";
import {
  computeCompactionDeltas,
  finalizeCompactionEvent,
  finalizeCompactions,
  findTokensAfter,
  findTokensBefore,
} from "../../src/engine/compaction.js";
import { dedupTurns } from "../../src/engine/dedup.js";
import type {
  CompactionEvent,
  Composition,
  CompositionCategory,
  CostBreakdown,
  Session,
  SessionRef,
  Turn,
} from "../../src/model/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_FIXTURES_ROOT = join(__dirname, "../fixtures/claude-code");
const PI_FIXTURES_ROOT = join(__dirname, "../fixtures/pi");

function claudeRefs(): Promise<SessionRef[]> {
  return discoverClaudeSessions([CLAUDE_FIXTURES_ROOT]);
}

function findClaudeRef(all: SessionRef[], fixtureName: string): SessionRef {
  const ref = all.find((r) => r.path.endsWith(`${fixtureName}.jsonl`));
  if (!ref) {
    throw new Error(`fixture ref not found: ${fixtureName}`);
  }
  return ref;
}

async function dedupedClaudeSession(fixtureName: string): Promise<Session> {
  const ref = findClaudeRef(await claudeRefs(), fixtureName);
  const { session } = await parseClaudeSession(ref);
  return { ...session, turns: dedupTurns(session.turns) };
}

function piRef(id: string, filename: string): SessionRef {
  return {
    harness: "pi",
    id,
    kind: "main",
    mtime: new Date(0),
    path: join(
      PI_FIXTURES_ROOT,
      "system-a-v3/--Users-fake-project--",
      filename
    ),
    sizeBytes: 0,
  };
}

// ---------------------------------------------------------------------------
// computeCompactionDeltas — DESIGN.md worked example (verbatim)
// ---------------------------------------------------------------------------

describe("computeCompactionDeltas — PLAN worked example", () => {
  it("matches docs/DESIGN.md § Compaction detection exactly", () => {
    const { shrinkExact, discardedEst } = computeCompactionDeltas(
      844_000,
      54_437,
      30_581
    );
    expect(shrinkExact).toBe(789_563);
    expect(discardedEst).toBe(820_144);
  });

  it("degenerate case: summary exactly replacing everything -> shrinkExact 0, discardedEst full original size", () => {
    // before === after (no net context reduction) but the summary itself is
    // as large as the original content it replaced.
    const { shrinkExact, discardedEst } = computeCompactionDeltas(
      1000,
      1000,
      1000
    );
    expect(shrinkExact).toBe(0);
    expect(discardedEst).toBe(1000); // full original size
  });

  it("null propagation: either side unknown -> both deltas null", () => {
    expect(computeCompactionDeltas(null, 100, 10)).toEqual({
      discardedEst: null,
      shrinkExact: null,
    });
    expect(computeCompactionDeltas(100, null, 10)).toEqual({
      discardedEst: null,
      shrinkExact: null,
    });
    expect(computeCompactionDeltas(null, null, 10)).toEqual({
      discardedEst: null,
      shrinkExact: null,
    });
  });
});

// ---------------------------------------------------------------------------
// findTokensBefore / findTokensAfter — anchoring, skipping zero-usage turns
// ---------------------------------------------------------------------------

function turnWithContext(contextTotal: number): Turn {
  return {
    composition: {
      categories: {} as Record<CompositionCategory, number>,
      residual: 0,
      residualShare: 0,
      truncated: false,
    },
    contentSpans: [],
    contextTotal,
    cost: {
      cacheRead: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      input: 0,
      mode: "auto",
      output: 0,
      priced: false,
      total: 0,
    },
    model: "m",
    role: "assistant",
    timestamp: new Date(0),
    usage: {
      cacheRead: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      inputUncached: 0,
      output: 0,
      raw: undefined,
    },
  };
}

describe("findTokensBefore / findTokensAfter", () => {
  it("findTokensBefore skips a zero-usage turn and returns the nearest non-zero turn strictly before the index", () => {
    const turns = [turnWithContext(20_000), turnWithContext(0)];
    expect(findTokensBefore(turns, 2)).toBe(20_000);
  });

  it("findTokensAfter is inclusive of fromIndex and skips zero-usage turns", () => {
    const turns = [
      turnWithContext(0),
      turnWithContext(0),
      turnWithContext(1000),
    ];
    expect(findTokensAfter(turns, 0)).toBe(1000);
  });

  it("both return null when no real-usage turn exists in range", () => {
    const turns = [turnWithContext(0), turnWithContext(0)];
    expect(findTokensBefore(turns, 2)).toBeNull();
    expect(findTokensAfter(turns, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// finalizeCompactions — claude-code fixture (already complete: idempotence +
// the F2-trap — tokensBeforeExact must anchor past the isApiErrorMessage
// all-zero record to the true 20000, not read it as 0)
// ---------------------------------------------------------------------------

describe("finalizeCompactions — claude-code compaction fixture", () => {
  it("leaves the adapter's already-complete event untouched (idempotent)", async () => {
    const session = await dedupedClaudeSession("compaction");
    const finalized = finalizeCompactions(session);
    const event = finalized.events.find(
      (e): e is CompactionEvent => e.kind === "compaction"
    );
    expect(event).toBeDefined();

    // F2-trap: the adjacent isApiErrorMessage record is all-zero usage; the
    // real prior turn (20000) must be what tokensBeforeExact anchors to.
    expect(event?.tokensBeforeExact).toBe(20_000);
    expect(event?.tokensAfterExact).toBe(3000);
    expect(event?.shrinkExact).toBe(17_000);
    expect(event?.discardedEst).toBe(17_040); // 17000 + summaryTokensEst(40)
    expect(event?.summaryTokensEst).toBe(40);

    // Idempotence: a second pass changes nothing.
    const twice = finalizeCompactions(finalized);
    expect(twice.events).toEqual(finalized.events);
  });
});

// ---------------------------------------------------------------------------
// finalizeCompactions — pi fixture (engine fills tokensAfterExact/shrink/
// discarded; tokensBeforeExact was already set by the pi adapter from the
// CompactionEntry's own tokensBefore field)
// ---------------------------------------------------------------------------

describe("finalizeCompactions — pi compaction fixture", () => {
  it("fills tokensAfterExact from the first post-compaction turn with non-zero contextTotal, and computes shrink/discarded", async () => {
    const ref = piRef(
      "6d816cb4-9915-4741-9571-a436e36f68c5",
      "2026-08-01T12-45-00-000Z_6d816cb4-9915-4741-9571-a436e36f68c5.jsonl"
    );
    const { session } = await parsePiSession(ref);
    const deduped = { ...session, turns: dedupTurns(session.turns) };

    // Fixture arithmetic (verified by reading the fixture directly):
    // turn 4 (user, post-compaction) has no usage -> contextTotal 0, skipped;
    // turn 5 (assistant) has input 800 + cacheRead 200 -> contextTotal 1000.
    expect(deduped.turns[4]?.contextTotal).toBe(0);
    expect(deduped.turns[5]?.contextTotal).toBe(1000);

    const finalized = finalizeCompactions(deduped);
    const event = finalized.events.find(
      (e): e is CompactionEvent => e.kind === "compaction"
    );
    expect(event).toBeDefined();

    expect(event?.tokensBeforeExact).toBe(8500); // set by the pi adapter's own tokensBefore field
    expect(event?.tokensAfterExact).toBe(1000); // filled by finalizeCompactions
    expect(event?.shrinkExact).toBe(7500);
    // discardedEst = 8500 - 1000 + summaryTokensEst. summaryTokensEst is
    // ceil(summary.length / 4) over the CompactionEntry's own summary text
    // (verified against the fixture's literal string, not hardcoded).
    const summary =
      "User asked to run the full test suite and check integration tests. Result: integration tests pass; 3 unit tests fail in the billing module.";
    const summaryTokensEst = Math.ceil(summary.length / 4);
    expect(event?.summaryTokensEst).toBe(summaryTokensEst);
    expect(event?.discardedEst).toBe(8500 - 1000 + summaryTokensEst);

    // Idempotence, same as the claude-code case.
    const twice = finalizeCompactions(finalized);
    expect(twice.events).toEqual(finalized.events);
  });
});

describe("finalizeCompactionEvent — never overwrites non-null adapter-computed values", () => {
  it("does not recompute shrinkExact/discardedEst once set, even if the anchor search would find different numbers", () => {
    const event: CompactionEvent = {
      at: new Date(0),
      cost: null,
      discardedEst: 95,
      kind: "compaction",
      shrinkExact: 90,
      summaryTokensEst: 5,
      tokensAfterExact: 10,
      tokensBeforeExact: 100,
      turnIndex: 1,
    };
    // A turns[] whose anchoring would produce completely different numbers
    // if this function recomputed instead of trusting the adapter.
    const turns = [turnWithContext(999_999), turnWithContext(1)];
    const result = finalizeCompactionEvent(event, turns);
    expect(result).toEqual(event);
  });
});

// ---------------------------------------------------------------------------
// byModel
// ---------------------------------------------------------------------------

describe("byModel", () => {
  it("rolls up tokens and cost per model on a deduped, priced session", async () => {
    const session = await dedupedClaudeSession("cache-heavy");
    const priced = priceSession(session, { mode: "calculate" });
    const rollup = byModel(priced);

    expect(rollup).toHaveLength(1);
    const entry = rollup.at(0);
    expect(entry?.model).toBe("claude-opus-5");
    expect(entry?.turnCount).toBe(2);
    // Sums over both assistant turns' usage (verified against the fixture's
    // raw usage fields): turn1 input 50 + cacheRead 200 + cacheWrite5m 500 +
    // cacheWrite1h 1000; turn2 input 300 + cacheWrite5m 900.
    expect(entry?.tokens).toEqual({
      cacheRead: 200,
      cacheWrite1h: 1000,
      cacheWrite5m: 1400,
      contextTotal: 2950,
      inputUncached: 350,
      output: 200,
    });
    expect(entry?.priced).toBe(true);
    expect(entry?.cost).toBeGreaterThan(0);
  });

  it("splits turns by model id, sorted ascending", async () => {
    const session = await dedupedClaudeSession("cache-heavy");
    // Force a second model onto one turn to exercise the grouping/sort.
    const mixed: Session = {
      ...session,
      turns: session.turns.map((t, i) =>
        i === 0 ? { ...t, model: "z-model" } : t
      ),
    };
    const priced = priceSession(mixed, { mode: "auto" });
    const rollup = byModel(priced);
    expect(rollup.map((r) => r.model)).toEqual(["claude-opus-5", "z-model"]);
  });
});

// ---------------------------------------------------------------------------
// byTool / byMcpServer — tool-use-names fixture
// ---------------------------------------------------------------------------

describe("byTool / byMcpServer — tool-use-names fixture", () => {
  it("groups mcp__github__get_issue under toolName get_issue / server github, exact call+result counts, char/4 estimate labeled", async () => {
    const session = await dedupedClaudeSession("tool-use-names");
    const tools = byTool(session);

    const getIssue = tools.find((t) => t.toolName === "get_issue");
    expect(getIssue).toBeDefined();
    expect(getIssue?.mcpServer).toBe("github");
    // toolCallArgs: JSON.stringify({owner:"acme",repo:"widget",issue_number:42}) = 50 chars, 1 call.
    expect(getIssue?.toolCallArgs).toEqual({ chars: 50, spanCount: 1 });

    const runLint = tools.find((t) => t.toolName === "run_lint");
    expect(runLint).toBeDefined();
    expect(runLint?.mcpServer).toBe("plugin_acme-tools_linter");
    expect(runLint?.toolCallArgs).toEqual({ chars: 15, spanCount: 1 });

    // claude-code's spans.ts links each tool_result back to its originating
    // tool_use via a session-scoped tool_use_id index (adapters/claude/spans.ts's
    // buildToolUseIndex), so both results land under their own tool's
    // bucket, not UNATTRIBUTED_TOOL.
    // toolu-0001 result: JSON.stringify({content:[{type:"text",text:"{...}"}]}) = 104 chars.
    expect(getIssue?.toolResults).toEqual({ chars: 104, spanCount: 1 });
    // toolu-0002 result: JSON.stringify({content:[{type:"text",text:"No lint errors found."}]}) = 60 chars.
    expect(runLint?.toolResults).toEqual({ chars: 60, spanCount: 1 });
    // tokenShareEst is over totalChars (toolCallArgs + toolResults): ceil((50+104)/4) = 39.
    expect(getIssue?.tokenShareEst).toBe(Math.ceil((50 + 104) / 4));

    const unattributed = tools.find((t) => t.toolName === UNATTRIBUTED_TOOL);
    expect(unattributed).toBeUndefined();

    // No per-tool cost is ever reported.
    for (const tool of tools) {
      expect(tool).not.toHaveProperty("cost");
    }
  });

  it("byMcpServer groups the same spans by server, excluding untagged (non-MCP) spans entirely", async () => {
    const session = await dedupedClaudeSession("tool-use-names");
    const servers = byMcpServer(session);

    expect(
      servers
        .map((s) => s.mcpServer)
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(["github", "plugin_acme-tools_linter"]);
    const github = servers.find((s) => s.mcpServer === "github");
    expect(github?.tools).toEqual(["get_issue"]);
    // 1 toolCallArgs + 1 toolResults, now that toolResults spans are linked
    // back to their originating tool_use (see byTool test above).
    expect(github?.totalSpanCount).toBe(2);

    const totalServerSpans = servers.reduce(
      (sum, s) => sum + s.totalSpanCount,
      0
    );
    expect(totalServerSpans).toBe(4); // 1 call + 1 result each for github + the linter server
  });
});

// ---------------------------------------------------------------------------
// cacheAnalysis — cache-heavy + cache-miss-reason fixtures
// ---------------------------------------------------------------------------

describe("cacheAnalysis", () => {
  it("cache-heavy: totals + hit-rate arithmetic, no miss reasons", async () => {
    const session = await dedupedClaudeSession("cache-heavy");
    const analysis = cacheAnalysis(session);

    // turn1: cacheRead 200, cacheWrite5m 500, cacheWrite1h 1000, inputUncached 50
    // turn2: cacheWrite5m 900, inputUncached 300
    expect(analysis.totals).toEqual({
      cacheRead: 200,
      cacheWrite1h: 1000,
      cacheWrite5m: 1400,
      inputUncached: 350,
    });
    const denominator = 200 + 350 + 1400 + 1000;
    expect(analysis.hitRate).toBeCloseTo(200 / denominator, 10);
    expect(analysis.missReasons).toHaveLength(0);
  });

  it("cache-miss-reason: the system_changed miss-reason entry surfaces with its exact token figure", async () => {
    const session = await dedupedClaudeSession("cache-miss-reason");
    const analysis = cacheAnalysis(session);

    expect(analysis.missReasons).toHaveLength(1);
    const entry = analysis.missReasons.at(0);
    expect(entry?.type).toBe("system_changed");
    // The fixture's diagnostics.cache_miss_reason.cache_missed_input_tokens value.
    expect(entry?.cacheMissedInputTokens).toBe(4500);
    expect(entry?.turnIndex).toBe(0);
  });

  it("hitRate is 0 (not NaN) when the denominator is 0", () => {
    const emptySession: Session = {
      children: [],
      configSnapshot: { model: "m", modelChanges: [] },
      cwd: "/",
      endedAt: new Date(0),
      events: [],
      harness: "claude-code",
      harnessVersion: "test",
      id: "empty",
      startedAt: new Date(0),
      turns: [],
      warnings: [],
    };
    const analysis = cacheAnalysis(emptySession);
    expect(analysis.hitRate).toBe(0);
    expect(Number.isNaN(analysis.hitRate)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bySubagent
// ---------------------------------------------------------------------------

function zeroComposition(): Composition {
  return {
    categories: {
      assistantText: 0,
      compactionSummaries: 0,
      coordination: 0,
      instructionInjection: 0,
      systemPrompt: 0,
      thinking: 0,
      toolCallArgs: 0,
      toolResults: 0,
      toolSchemas: 0,
      userText: 0,
    },
    residual: 0,
    residualShare: 0,
    truncated: false,
  };
}

function pricedCost(total: number): CostBreakdown {
  return {
    cacheRead: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    input: total,
    mode: "calculate",
    output: 0,
    priced: true,
    total,
  };
}

function simpleSession(
  id: string,
  contextTotal: number,
  cost: number
): Session {
  const turn: Turn = {
    composition: zeroComposition(),
    contentSpans: [],
    contextTotal,
    cost: pricedCost(cost),
    model: "m",
    role: "assistant",
    timestamp: new Date(0),
    usage: {
      cacheRead: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      inputUncached: contextTotal,
      output: 0,
      raw: undefined,
    },
  };
  return {
    children: [],
    configSnapshot: { model: "m", modelChanges: [] },
    cwd: "/",
    endedAt: new Date(0),
    events: [],
    harness: "claude-code",
    harnessVersion: "test",
    id,
    startedAt: new Date(0),
    turns: [turn],
    warnings: [],
  };
}

describe("bySubagent", () => {
  it("rolls up children against the parent (sessions[0])", () => {
    const parent = simpleSession("parent", 1000, 1.0);
    const child1 = simpleSession("child1", 200, 0.1);
    const child2 = simpleSession("child2", 300, 0.2);

    const rollup = bySubagent([parent, child1, child2]);

    expect(rollup.parent.tokens.contextTotal).toBe(1000);
    expect(rollup.parent.cost).toBe(1.0);
    expect(rollup.children).toHaveLength(2);
    expect(rollup.children.map((c) => c.id)).toEqual(["child1", "child2"]);
    expect(rollup.childrenCombined.tokens.contextTotal).toBe(500);
    expect(rollup.childrenCombined.cost).toBeCloseTo(0.3, 10);
    expect(rollup.combined.tokens.contextTotal).toBe(1500);
    expect(rollup.combined.cost).toBeCloseTo(1.3, 10);
    expect(rollup.childCostShare).toBeCloseTo(0.3 / 1.3, 10);
  });

  it("handles zero children (no subagent spend)", () => {
    const parent = simpleSession("parent", 1000, 1.0);
    const rollup = bySubagent([parent]);
    expect(rollup.children).toHaveLength(0);
    expect(rollup.childrenCombined.cost).toBe(0);
    expect(rollup.combined).toEqual(rollup.parent);
    expect(rollup.childCostShare).toBe(0);
  });

  it("throws on an empty sessions array", () => {
    expect(() => bySubagent([])).toThrow();
  });
});
