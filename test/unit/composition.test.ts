import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "../../src/adapters/claude/discover.js";
import { parseClaudeSession } from "../../src/adapters/claude/parse.js";
import { discoverCodexSessions } from "../../src/adapters/codex/discover.js";
import { parseCodexSession } from "../../src/adapters/codex/parse.js";
import { parsePiSession } from "../../src/adapters/pi/parse.js";
import {
  accumulateTurnComposition,
  computeComposition,
  initCompositionAccumulator,
} from "../../src/engine/composition.js";
import { dedupSession, dedupTurns } from "../../src/engine/dedup.js";
import type {
  CompactionEvent,
  CompositionCategory,
  NormalizedUsage,
  Session,
  SessionEvent,
  SessionRef,
  Turn,
} from "../../src/model/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_FIXTURES_ROOT = join(__dirname, "../fixtures/claude-code");
const PI_FIXTURES_ROOT = join(__dirname, "../fixtures/pi");
const CODEX_FIXTURES_ROOT = join(__dirname, "../fixtures/codex");

function claudeRefs(): Promise<SessionRef[]> {
  return discoverClaudeSessions([CLAUDE_FIXTURES_ROOT]);
}

function findRef(all: SessionRef[], id: string): SessionRef {
  const ref = all.find((r) => r.id === id);
  if (!ref) {
    throw new Error(`fixture ref not found: ${id}`);
  }
  return ref;
}

/** Σ categories + residual = contextTotal, per model/types.ts's frozen invariant. */
function sumCategories(
  categories: Record<CompositionCategory, number>
): number {
  return Object.values(categories).reduce((a, b) => a + b, 0);
}

function assertInvariant(session: Session): void {
  for (const turn of session.turns) {
    const sum = sumCategories(turn.composition.categories);
    expect(sum + turn.composition.residual).toBe(turn.contextTotal);
  }
}

async function composedClaudeSession(id: string): Promise<Session> {
  const ref = findRef(await claudeRefs(), id);
  const { session } = await parseClaudeSession(ref);
  const deduped = dedupTurns(session.turns);
  return computeComposition({ ...session, turns: deduped });
}

describe("computeComposition — streaming-split fixture (audit R3-F1 gate)", () => {
  it("holds the Σ categories + residual = contextTotal invariant on every deduped turn", async () => {
    const session = await composedClaudeSession("streaming-split");
    // 4 raw records -> 2 deduped turns (see dedup.test.ts); composition only
    // ever sees the deduped shape.
    expect(session.turns).toHaveLength(2);
    assertInvariant(session);
  });

  it("counts the merged turn's 3 fragments' spans exactly once (no double-count)", async () => {
    const ref = findRef(await claudeRefs(), "streaming-split");
    const { session } = await parseClaudeSession(ref);
    expect(session.turns).toHaveLength(4); // pre-dedup, NOT what composition consumes

    const deduped = dedupTurns(session.turns);
    const composed = computeComposition({ ...session, turns: deduped });
    const first = composed.turns.at(0);
    assert(first);

    // userText 40 (user span), thinking 48 (excluded), assistantText 24,
    // toolCallArgs 20 — from the merged fragments' spans, each counted once.
    expect(first.composition.categories.userText).toBe(10); // ceil(40/4)
    expect(first.composition.categories.thinking).toBe(0);
    expect(first.composition.categories.assistantText).toBe(6); // ceil(24/4)
    expect(first.composition.categories.toolCallArgs).toBe(5); // ceil(20/4)
    expect(first?.contextTotal).toBe(1500);
    expect(first.composition.residual).toBe(1500 - (10 + 6 + 5));
  });
});

describe("computeComposition — thinking exclusion (audit R2-C2 gate)", () => {
  it("categories.thinking is 0 on every claude-code turn even though thinking spans exist in contentSpans", async () => {
    const ref = findRef(await claudeRefs(), "streaming-split");
    const { session } = await parseClaudeSession(ref);

    const hasThinkingSpan = session.turns.some((t) =>
      t.contentSpans.some((s) => s.category === "thinking")
    );
    expect(hasThinkingSpan).toBe(true); // the gate: real thinking content is present pre-composition

    const composed = await composedClaudeSession("streaming-split");
    for (const turn of composed.turns) {
      expect(turn.composition.categories.thinking).toBe(0);
    }
    assertInvariant(composed);
  });
});

describe("computeComposition — compaction fixture (RESET at CompactionEvent boundary)", () => {
  it("post-compaction turn's composition reflects the reset, not the full pre-compaction accumulation", async () => {
    const session = await composedClaudeSession("compaction");
    expect(session.turns).toHaveLength(3);

    const compactionEvents = session.events.filter(
      (e) => e.kind === "compaction"
    );
    expect(compactionEvents).toHaveLength(1);
    const event = compactionEvents.at(0);
    if (event?.kind !== "compaction") {
      throw new Error("unreachable");
    }
    expect(event.turnIndex).toBe(2);

    const [pre, apiError, post] = session.turns;
    assert(pre);
    assert(apiError);
    assert(post);

    // pre-compaction: userText 40 + assistantText 68, over contextTotal 20000.
    expect(pre?.contextTotal).toBe(20_000);
    expect(pre.composition.categories.userText).toBe(10);
    expect(pre.composition.categories.assistantText).toBe(17);

    // zero-contextTotal (api-error) turn: composition forced all-zero (rule 6),
    // even though it carries its own (empty) assistantText span.
    expect(apiError?.contextTotal).toBe(0);
    expect(apiError.composition.residual).toBe(0);
    expect(sumCategories(apiError.composition.categories)).toBe(0);

    // post-compaction (turnIndex 2, the reset boundary): categories.userText
    // and .toolCallArgs are back to 0 — NOT inherited from the pre-compaction
    // phase — while compactionSummaries (157 chars, the summary span landing
    // on this very turn) and this turn's own assistantText (60 chars) seed
    // the new phase.
    expect(post?.contextTotal).toBe(3000);
    expect(post.composition.categories.userText).toBe(0);
    expect(post.composition.categories.toolCallArgs).toBe(0);
    expect(post.composition.categories.compactionSummaries).toBe(40); // ceil(157/4)
    expect(post.composition.categories.assistantText).toBe(15); // ceil(60/4)
    expect(post.composition.residual).toBe(3000 - (40 + 15));
    // large residual is honest: this harness doesn't log the system prompt,
    // tool schemas, or framing that make up the rest of contextTotal.
    expect(post.composition.residualShare).toBeGreaterThan(0.9);

    assertInvariant(session);
  });
});

describe("computeComposition — property: invariant holds across every claude fixture", () => {
  it("Σ categories + residual = contextTotal on every turn of every claude-code fixture", async () => {
    const all = await claudeRefs();
    expect(all.length).toBeGreaterThan(0);

    for (const ref of all) {
      // biome-ignore lint/performance/noAwaitInLoops: Fixture parsing is intentionally serialized for deterministic coverage.
      const { session } = await parseClaudeSession(ref);
      const deduped = dedupTurns(session.turns);
      const composed = computeComposition({ ...session, turns: deduped });
      assertInvariant(composed);
    }
  });
});

describe("computeComposition — accumulation ordering", () => {
  it("userText from a user record counts toward the next assistant turn AND all later turns in the phase", async () => {
    const session = await composedClaudeSession("normal-turns");
    expect(session.turns).toHaveLength(2);
    const [first, second] = session.turns;
    assert(first);
    assert(second);

    // turn 1: "Please fix the login bug in auth.ts" (35 chars) is the ONLY
    // userText contribution in the whole fixture — no later user record adds
    // more userText content.
    expect(first.composition.categories.userText).toBe(9); // ceil(35/4)

    // turn 2 adds no new userText span (it only adds a toolResults span and
    // more assistantText), yet still carries the SAME userText total —
    // proving turn 1's user content accumulated forward rather than
    // resetting or being turn-1-only.
    expect(second.composition.categories.userText).toBe(9);
    expect(second.composition.categories.assistantText).toBeGreaterThan(
      first.composition.categories.assistantText ?? 0
    );
    expect(second.composition.categories.toolResults).toBeGreaterThan(0);

    assertInvariant(session);
  });
});

describe("computeComposition — pi fixture through the same pipeline", () => {
  it("thinking stays 0, categories are non-zero (T6.4: pi is no longer all-residual), and the invariant holds", async () => {
    const ref: SessionRef = {
      harness: "pi",
      id: "cb5b132f-2542-40b3-a7c9-49ffc431e30b",
      kind: "main",
      mtime: new Date(0),
      path: join(
        PI_FIXTURES_ROOT,
        "system-a-v3/--Users-fake-project--/2026-08-01T10-00-00-000Z_cb5b132f-2542-40b3-a7c9-49ffc431e30b.jsonl"
      ),
      sizeBytes: 0,
    };
    const { session } = await parsePiSession(ref);
    expect(session.turns.length).toBeGreaterThan(0);

    const deduped = dedupTurns(session.turns); // no-op for pi (no message.id/requestId) — still required by contract
    const composed = computeComposition({ ...session, turns: deduped });

    for (const turn of composed.turns) {
      expect(turn.composition.categories.thinking).toBe(0);
    }

    // The gate: the single assistant turn now carries real userText (the
    // preceding user record's span, attached per spans.ts's convention),
    // assistantText, and toolCallArgs — no longer all-residual.
    const assistantTurn = composed.turns.find((t) => t.role === "assistant");
    expect(assistantTurn?.composition.categories.userText).toBeGreaterThan(0);
    expect(assistantTurn?.composition.categories.assistantText).toBeGreaterThan(
      0
    );
    expect(assistantTurn?.composition.categories.toolCallArgs).toBeGreaterThan(
      0
    );

    assertInvariant(composed);
  });
});

describe("computeComposition — configSnapshot seeding (systemPrompt/toolSchemas, fix 2026-08-08)", () => {
  async function dedupedCodexSession(id: string): Promise<Session> {
    const all = await discoverCodexSessions([CODEX_FIXTURES_ROOT]);
    const ref = all.find((r) => r.id === id);
    if (!ref) {
      throw new Error(`fixture ref not found: ${id}`);
    }
    const { session } = await parseCodexSession(ref);
    return dedupSession(session); // precondition per composition.ts's RESET_AT note
  }

  /**
   * Mirrors computeComposition but always starts each phase from a bare
   * (unseeded) accumulator — i.e. the pre-fix behavior — used only to prove
   * the fix moves exactly the seeded chars out of residual and nothing else.
   */
  function unseededCompose(session: Session): Session {
    const resetAt = new Set(
      session.events
        .filter((event) => event.kind === "compaction")
        .map((event) => event.turnIndex)
    );
    let state = initCompositionAccumulator();
    const turns = session.turns.map((turn, index) => {
      if (resetAt.has(index)) {
        state = initCompositionAccumulator();
      }
      const composition = accumulateTurnComposition(
        state,
        turn,
        session.harness
      );
      return { ...turn, composition };
    });
    return { ...session, turns };
  }

  it("codex full-turn fixture: seeds systemPrompt/toolSchemas from configSnapshot on the usage-carrying turn, shrinking residual by exactly the seeded amount", async () => {
    const deduped = await dedupedCodexSession("full-turn");
    expect(deduped.configSnapshot.systemPrompt).toBeDefined();
    expect(deduped.configSnapshot.toolSchemas).toBeDefined();

    const composed = computeComposition(deduped);
    const finalTurn = composed.turns.find((t) => t.contextTotal > 0);
    expect(finalTurn).toBeDefined();
    if (!finalTurn) {
      throw new Error("unreachable");
    }

    const expectedSystemPrompt = Math.ceil(
      (deduped.configSnapshot.systemPrompt as string).length / 4
    );
    const expectedToolSchemas = Math.ceil(
      (deduped.configSnapshot.toolSchemas as string).length / 4
    );
    expect(finalTurn.composition.categories.systemPrompt).toBeGreaterThan(0);
    expect(finalTurn.composition.categories.toolSchemas).toBeGreaterThan(0);
    expect(finalTurn.composition.categories.systemPrompt).toBe(
      expectedSystemPrompt
    );
    expect(finalTurn.composition.categories.toolSchemas).toBe(
      expectedToolSchemas
    );

    const sum = sumCategories(finalTurn.composition.categories);
    expect(sum + finalTurn.composition.residual).toBe(finalTurn.contextTotal);
    assertInvariant(composed);

    // Residual shrinks by exactly the seeded amount vs. pre-fix (unseeded)
    // behavior — every other category is untouched by the seed.
    const unseeded = unseededCompose(deduped);
    const unseededFinal = unseeded.turns.find((t) => t.contextTotal > 0);
    expect(unseededFinal).toBeDefined();
    if (!unseededFinal) {
      throw new Error("unreachable");
    }
    expect(unseededFinal.composition.categories.systemPrompt).toBe(0);
    expect(unseededFinal.composition.categories.toolSchemas).toBe(0);
    expect(
      unseededFinal.composition.residual - finalTurn.composition.residual
    ).toBe(expectedSystemPrompt + expectedToolSchemas);
  });

  it("claude fixtures: systemPrompt/toolSchemas stay 0 (configSnapshot never populates them for claude-code — behavior unchanged)", async () => {
    const session = await composedClaudeSession("normal-turns");
    for (const turn of session.turns) {
      expect(turn.composition.categories.systemPrompt).toBe(0);
      expect(turn.composition.categories.toolSchemas).toBe(0);
    }
    assertInvariant(session);
  });

  it("pi fixtures: systemPrompt/toolSchemas stay 0 (configSnapshot never populates them for pi — behavior unchanged)", async () => {
    const ref: SessionRef = {
      harness: "pi",
      id: "cb5b132f-2542-40b3-a7c9-49ffc431e30b",
      kind: "main",
      mtime: new Date(0),
      path: join(
        PI_FIXTURES_ROOT,
        "system-a-v3/--Users-fake-project--/2026-08-01T10-00-00-000Z_cb5b132f-2542-40b3-a7c9-49ffc431e30b.jsonl"
      ),
      sizeBytes: 0,
    };
    const { session } = await parsePiSession(ref);
    const deduped = dedupTurns(session.turns);
    const composed = computeComposition({ ...session, turns: deduped });
    for (const turn of composed.turns) {
      expect(turn.composition.categories.systemPrompt).toBe(0);
      expect(turn.composition.categories.toolSchemas).toBe(0);
    }
    assertInvariant(composed);
  });

  it("compaction persistence: the systemPrompt/toolSchemas seed is re-applied at the reset boundary, not wiped by it", () => {
    const usage = (partial: Partial<NormalizedUsage>): NormalizedUsage => ({
      cacheRead: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      inputUncached: 0,
      output: 0,
      raw: undefined,
      ...partial,
    });
    const zeroComposition = () => ({
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
      } as Record<CompositionCategory, number>,
      residual: 0,
      residualShare: 0,
      truncated: false,
    });
    const zeroCost = () =>
      ({
        cacheRead: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        input: 0,
        mode: "auto" as const,
        output: 0,
        priced: false,
        total: 0,
      }) as Turn["cost"];

    const preTurn: Turn = {
      composition: zeroComposition(),
      contentSpans: [],
      contextTotal: 1000,
      cost: zeroCost(),
      model: "gpt-5.5",
      role: "assistant",
      timestamp: new Date(0),
      usage: usage({ inputUncached: 1000 }),
    };
    const postTurn: Turn = {
      composition: zeroComposition(),
      contentSpans: [],
      contextTotal: 500,
      cost: zeroCost(),
      model: "gpt-5.5",
      role: "assistant",
      timestamp: new Date(1),
      usage: usage({ inputUncached: 500 }),
    };
    const compactionEvent: CompactionEvent = {
      at: new Date(1),
      discardedEst: 500,
      kind: "compaction",
      shrinkExact: 500,
      summaryTokensEst: 0,
      tokensAfterExact: 500,
      tokensBeforeExact: 1000,
      turnIndex: 1,
    };

    const session: Session = {
      children: [],
      configSnapshot: {
        model: "gpt-5.5",
        modelChanges: [],
        systemPrompt: "x".repeat(400), // ceil(400/4) = 100
        toolSchemas: "y".repeat(80), // ceil(80/4) = 20
      },
      cwd: "/tmp",
      endedAt: new Date(1),
      events: [compactionEvent as SessionEvent],
      harness: "codex",
      harnessVersion: "0.134.0",
      id: "synthetic-compaction-seed",
      startedAt: new Date(0),
      turns: [preTurn, postTurn],
      warnings: [],
    };

    const composed = computeComposition(session);
    const [composedPre, composedPost] = composed.turns;
    assert(composedPre);
    assert(composedPost);
    expect(composedPre.composition.categories.systemPrompt).toBe(100);
    expect(composedPre.composition.categories.toolSchemas).toBe(20);
    // The reset boundary (turnIndex 1) re-seeds from configSnapshot rather
    // than wiping to 0 — the system prompt and tool schemas are resent on
    // every request, so they persist across the compaction.
    expect(composedPost.composition.categories.systemPrompt).toBe(100);
    expect(composedPost.composition.categories.toolSchemas).toBe(20);
    assertInvariant(composed);
  });

  it("initCompositionAccumulator: omitting configSnapshot seeds all-zero (backward-compatible default, used by direct-accumulator tests below)", () => {
    const seeded = initCompositionAccumulator();
    expect(seeded.runningChars.systemPrompt).toBe(0);
    expect(seeded.runningChars.toolSchemas).toBe(0);
  });
});

describe("accumulateTurnComposition — direct accumulator tests", () => {
  it("excludes thinking spans from the running total for claude-code", () => {
    const state = initCompositionAccumulator();
    const composition = accumulateTurnComposition(
      state,
      {
        contentSpans: [
          {
            category: "thinking",
            charCount: 400,
            truncated: false,
            turnRole: "assistant",
          },
          {
            category: "assistantText",
            charCount: 40,
            truncated: false,
            turnRole: "assistant",
          },
        ],
        contextTotal: 100,
      },
      "claude-code"
    );
    expect(composition.categories.thinking).toBe(0);
    expect(composition.categories.assistantText).toBe(10);
    expect(state.runningChars.thinking).toBe(0);
  });

  it("includes thinking spans in the running total for codex", () => {
    const state = initCompositionAccumulator();
    const composition = accumulateTurnComposition(
      state,
      {
        contentSpans: [
          {
            category: "thinking",
            charCount: 400,
            truncated: false,
            turnRole: "assistant",
          },
        ],
        contextTotal: 100,
      },
      "codex"
    );
    expect(composition.categories.thinking).toBe(100); // ceil(400/4)
    expect(state.runningChars.thinking).toBe(400);
  });

  it("forces an all-zero composition for a zero-contextTotal turn but still accumulates its spans", () => {
    const state = initCompositionAccumulator();
    const errorTurnComposition = accumulateTurnComposition(
      state,
      {
        contentSpans: [
          {
            category: "userText",
            charCount: 40,
            truncated: false,
            turnRole: "user",
          },
        ],
        contextTotal: 0,
      },
      "claude-code"
    );
    expect(errorTurnComposition.categories.userText).toBe(0);
    expect(errorTurnComposition.residual).toBe(0);
    expect(errorTurnComposition.residualShare).toBe(0);
    expect(state.runningChars.userText).toBe(40); // still folded in for later turns

    const nextComposition = accumulateTurnComposition(
      state,
      { contentSpans: [], contextTotal: 100 },
      "claude-code"
    );
    expect(nextComposition.categories.userText).toBe(10); // ceil(40/4) — inherited
  });

  it("propagates truncated:true forward within a phase once any accumulated span was truncated", () => {
    const state = initCompositionAccumulator();
    accumulateTurnComposition(
      state,
      {
        contentSpans: [
          {
            category: "toolResults",
            charCount: 10,
            truncated: true,
            turnRole: "user",
          },
        ],
        contextTotal: 50,
      },
      "claude-code"
    );
    const later = accumulateTurnComposition(
      state,
      { contentSpans: [], contextTotal: 60 },
      "claude-code"
    );
    expect(later.truncated).toBe(true);
  });

  it("never clamps a negative residual (over-estimation is measured, not hidden)", () => {
    const state = initCompositionAccumulator();
    const composition = accumulateTurnComposition(
      state,
      {
        contentSpans: [
          {
            category: "userText",
            charCount: 4000,
            truncated: false,
            turnRole: "user",
          },
        ],
        contextTotal: 10, // absurdly small vs. the char/4 estimate, on purpose
      },
      "claude-code"
    );
    expect(composition.categories.userText).toBe(1000);
    expect(composition.residual).toBe(10 - 1000);
    expect(composition.residual).toBeLessThan(0);
  });
});
