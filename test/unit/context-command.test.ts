// T3.2 gate — fixture-driven snapshot tests for `peek context`'s pure core:
// buildContextReport / buildTurnDetail. Pipeline under test matches
// src/commands/context.ts's loadProcessedSession: parse -> dedupTurns ->
// computeComposition -> finalizeCompactions.
//
// Two findings surfaced during this task (stop-and-report per standing
// worker rule 1 — not fixed here, out of scope: "do NOT modify
// engine/adapters"):
//
//   1. [FIXED 2026-08-08] The codex full-turn fixture previously did NOT
//      produce "small residual" via non-zero systemPrompt/toolSchemas
//      categories: adapters/codex/meta.ts + parse.ts capture
//      base_instructions/dynamic_tools text into Session.configSnapshot
//      (293 / 847 chars on this fixture) but no Span ever carried that text,
//      so composition.ts's accumulator (which only ever folds
//      turn.contentSpans) saw 0 for both. Fixed in engine/composition.ts:
//      computeComposition now seeds the accumulator's systemPrompt/
//      toolSchemas running chars directly from configSnapshot at the start
//      of every compaction phase (configSnapshot's system prompt and tool
//      schemas are resent on every request, so the seed persists across
//      compactions same as any other harness-level constant) — see that
//      file's seeding comment for the full accounting. Residual on this
//      fixture drops from 18,264/18,420 (99.2%) to 17,978/18,420 (97.6%).
//      Tests below now assert the fixed (smaller-residual) behavior.
//   2. The pi fixture referenced by this task ("all-residual currently…
//      this is expected until pi spans land") actually already has
//      non-zero userText/assistantText/toolCallArgs spans wired (verified
//      against adapters/pi/parse.ts) — composition.test.ts's older comment
//      calling this "not yet wired" appears stale. Tests below assert the
//      real (partially non-zero) composition rather than an all-zero one.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "../../src/adapters/claude/discover.js";
import { parseClaudeSession } from "../../src/adapters/claude/parse.js";
import { discoverCodexSessions } from "../../src/adapters/codex/discover.js";
import { parseCodexSession } from "../../src/adapters/codex/parse.js";
import { parsePiSession } from "../../src/adapters/pi/parse.js";
import {
  RESIDUAL_LABEL,
  buildContextReport,
  buildTurnDetail,
  resolveSession,
} from "../../src/commands/context.js";
import { finalizeCompactions } from "../../src/engine/compaction.js";
import { computeComposition } from "../../src/engine/composition.js";
import { dedupTurns } from "../../src/engine/dedup.js";
import type { Session, SessionRef } from "../../src/model/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_FIXTURES_ROOT = join(__dirname, "../fixtures/claude-code");
const CODEX_FIXTURES_ROOT = join(__dirname, "../fixtures/codex");
const PI_FIXTURES_ROOT = join(__dirname, "../fixtures/pi");

async function processedClaudeSession(fixtureName: string): Promise<Session> {
  const refs = await discoverClaudeSessions([CLAUDE_FIXTURES_ROOT]);
  const ref = refs.find((r) => r.path.endsWith(`${fixtureName}.jsonl`));
  if (!ref) throw new Error(`fixture ref not found: ${fixtureName}`);
  const { session } = await parseClaudeSession(ref);
  const deduped: Session = { ...session, turns: dedupTurns(session.turns) };
  return finalizeCompactions(computeComposition(deduped));
}

async function processedCodexSession(fixtureId: string): Promise<Session> {
  const refs = await discoverCodexSessions([CODEX_FIXTURES_ROOT]);
  const ref = refs.find((r) => r.id === fixtureId);
  if (!ref) throw new Error(`fixture ref not found: ${fixtureId}`);
  const { session } = await parseCodexSession(ref);
  const deduped: Session = { ...session, turns: dedupTurns(session.turns) };
  return finalizeCompactions(computeComposition(deduped));
}

function piRef(): SessionRef {
  return {
    harness: "pi",
    id: "cb5b132f-2542-40b3-a7c9-49ffc431e30b",
    path: join(
      PI_FIXTURES_ROOT,
      "system-a-v3/--Users-fake-project--/2026-08-01T10-00-00-000Z_cb5b132f-2542-40b3-a7c9-49ffc431e30b.jsonl",
    ),
    sizeBytes: 0,
    mtime: new Date(0),
    kind: "main",
  };
}

async function processedPiSession(): Promise<Session> {
  const { session } = await parsePiSession(piRef());
  const deduped: Session = { ...session, turns: dedupTurns(session.turns) };
  return finalizeCompactions(computeComposition(deduped));
}

// ---------------------------------------------------------------------------
// claude cache-heavy — exact totals + categories + residual arithmetic
// ---------------------------------------------------------------------------

describe("buildContextReport — claude cache-heavy fixture", () => {
  it("matches the snapshot", async () => {
    const session = await processedClaudeSession("cache-heavy");
    expect(buildContextReport(session)).toMatchSnapshot();
  });

  it("carries exact contextTotal and char/4-estimated, ~-prefixed category tokens", async () => {
    const session = await processedClaudeSession("cache-heavy");
    const report = buildContextReport(session);
    expect(report.turns).toHaveLength(2);

    const [first, second] = report.turns;
    expect(first?.contextTotal).toBe(1750); // exact, from usage — not char/4
    expect(first?.categories).toEqual([
      { category: "userText", tokens: 10, tokensLabel: "~10", pct: 10 / 1750 },
      {
        category: "assistantText",
        tokens: 11,
        tokensLabel: "~11",
        pct: 11 / 1750,
      },
    ]);
    expect(first?.residual).toEqual({
      tokens: 1729,
      tokensLabel: "1,729", // unprefixed — residual is not itself a char/4 read
      pct: 1729 / 1750,
      label: RESIDUAL_LABEL,
    });
    // Σ categories + residual = contextTotal invariant, visible in the report shape.
    const firstSum = (first?.categories ?? []).reduce(
      (s, c) => s + c.tokens,
      0,
    );
    expect(firstSum + (first?.residual.tokens ?? 0)).toBe(first?.contextTotal);

    // second turn: categories accumulate forward within the (compaction-free) phase.
    expect(second?.contextTotal).toBe(1200);
    expect(second?.categories.map((c) => c.tokens)).toEqual([19, 24]);
    expect(second?.residual.tokens).toBe(1157);
  });
});

// ---------------------------------------------------------------------------
// claude compaction — separator row with the exact shrink number
// ---------------------------------------------------------------------------

describe("buildContextReport — claude compaction fixture", () => {
  it("matches the snapshot", async () => {
    const session = await processedClaudeSession("compaction");
    expect(buildContextReport(session)).toMatchSnapshot();
  });

  it("draws a compaction separator, immediately before the post-compaction turn, with the exact shrink number", async () => {
    const session = await processedClaudeSession("compaction");
    const report = buildContextReport(session);
    expect(report.turns).toHaveLength(3);

    expect(report.separators).toEqual([
      {
        beforeTurnNumber: 3, // event.turnIndex (2) + 1
        shrinkExact: 17000,
        label: "compaction: shrunk 17,000 tokens (exact)",
      },
    ]);

    // zero-usage (isApiErrorMessage) turn: no categories, zero residual —
    // never a fabricated composition for a turn with no real contextTotal.
    expect(report.turns[1]?.contextTotal).toBe(0);
    expect(report.turns[1]?.categories).toEqual([]);
    expect(report.turns[1]?.residual.tokens).toBe(0);

    // post-compaction turn: reset phase, compactionSummaries category present.
    const post = report.turns[2];
    expect(post?.contextTotal).toBe(3000);
    expect(post?.categories).toEqual([
      {
        category: "assistantText",
        tokens: 15,
        tokensLabel: "~15",
        pct: 15 / 3000,
      },
      {
        category: "compactionSummaries",
        tokens: 40,
        tokensLabel: "~40",
        pct: 40 / 3000,
      },
    ]);
    expect(post?.residual.tokens).toBe(2945);
  });
});

// ---------------------------------------------------------------------------
// codex full-turn — systemPrompt/toolSchemas categories (finding 1 above:
// FIXED — asserting the smaller residual the configSnapshot seed produces)
// ---------------------------------------------------------------------------

describe("buildContextReport — codex full-turn fixture", () => {
  it("matches the snapshot", async () => {
    const session = await processedCodexSession("full-turn");
    expect(buildContextReport(session)).toMatchSnapshot();
  });

  it("systemPrompt/toolSchemas are present in the category rows, seeded from configSnapshot (fix 2026-08-08, see file header)", async () => {
    const session = await processedCodexSession("full-turn");
    expect(session.configSnapshot.systemPrompt?.length).toBe(293);
    expect(session.configSnapshot.toolSchemas?.length).toBe(847);

    const report = buildContextReport(session);
    const withUsage = report.turns.find((t) => t.contextTotal > 0);
    expect(withUsage).toBeDefined();
    expect(withUsage?.contextTotal).toBe(18420);

    const categoryNames = withUsage?.categories.map((c) => c.category);
    expect(categoryNames).toEqual([
      "userText",
      "assistantText",
      "thinking", // codex: reasoning-summary spans DO count (unlike claude/pi)
      "toolResults",
      "toolCallArgs",
      "systemPrompt", // ceil(293/4) = 74, seeded from configSnapshot
      "toolSchemas", // ceil(847/4) = 212, seeded from configSnapshot
    ]);

    // Residual shrinks by exactly the seeded amount (74 + 212 = 286):
    // 18,264 -> 17,978, 99.2% -> 97.6%.
    expect(withUsage?.residual.tokens).toBe(17978);
    expect(withUsage?.residual.pct).toBeCloseTo(17978 / 18420, 10);
    expect(withUsage?.residual.label).toBe(RESIDUAL_LABEL);
  });
});

// ---------------------------------------------------------------------------
// pi — finding 2 above: partially non-zero, not all-residual
// ---------------------------------------------------------------------------

describe("buildContextReport — pi fixture", () => {
  it("matches the snapshot", async () => {
    const session = await processedPiSession();
    expect(buildContextReport(session)).toMatchSnapshot();
  });

  it("reports real userText/assistantText/toolCallArgs spans, not an all-zero composition", async () => {
    const session = await processedPiSession();
    const report = buildContextReport(session);

    const withUsage = report.turns.find((t) => t.contextTotal > 0);
    expect(withUsage).toBeDefined();
    expect(withUsage?.contextTotal).toBe(1600);
    expect(withUsage?.categories).toEqual([
      { category: "userText", tokens: 7, tokensLabel: "~7", pct: 7 / 1600 },
      {
        category: "assistantText",
        tokens: 7,
        tokensLabel: "~7",
        pct: 7 / 1600,
      },
      {
        category: "toolCallArgs",
        tokens: 5,
        tokensLabel: "~5",
        pct: 5 / 1600,
      },
    ]);
    expect(withUsage?.residual.tokens).toBe(1581);
    expect(withUsage?.residual.label).toBe(RESIDUAL_LABEL);

    // thinking stays 0 on pi (PLAN's CompositionCategory rule) even though
    // the accumulator never gets a "thinking" span to fold in here.
    for (const turn of report.turns) {
      expect(
        turn.categories.find((c) => c.category === "thinking"),
      ).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// ~ estimate-prefix convention + residual label — direct assertion, across
// every fixture above, so this convention has one place it can't silently
// regress.
// ---------------------------------------------------------------------------

describe("honesty convention — ~ prefix on char/4 estimates, residual unprefixed, exact label string", () => {
  it("holds across cache-heavy, compaction, codex full-turn, and pi reports", async () => {
    const sessions = await Promise.all([
      processedClaudeSession("cache-heavy"),
      processedClaudeSession("compaction"),
      processedCodexSession("full-turn"),
      processedPiSession(),
    ]);

    expect(RESIDUAL_LABEL).toBe(
      "system prompt + tool schemas + framing (not logged by this harness)",
    );

    for (const session of sessions) {
      const report = buildContextReport(session);
      for (const turn of report.turns) {
        for (const category of turn.categories) {
          expect(category.tokensLabel.startsWith("~")).toBe(true);
          expect(category.tokensLabel).toBe(
            `~${category.tokens.toLocaleString("en-US")}`,
          );
        }
        expect(turn.residual.tokensLabel.startsWith("~")).toBe(false);
        expect(turn.residual.label).toBe(RESIDUAL_LABEL);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// buildTurnDetail — `--turn n` expanded span view (1-indexed)
// ---------------------------------------------------------------------------

describe("buildTurnDetail", () => {
  it("returns undefined for an out-of-range turn number", async () => {
    const session = await processedClaudeSession("cache-heavy");
    expect(buildTurnDetail(session, 0)).toBeUndefined();
    expect(buildTurnDetail(session, 99)).toBeUndefined();
  });

  it("codex full-turn: turn 3's tool-call span carries toolName/mcpServer and a ~-prefixed estimate", async () => {
    const session = await processedCodexSession("full-turn");
    const spans = buildTurnDetail(session, 3);
    expect(spans).toEqual([
      {
        category: "toolCallArgs",
        toolName: "search_code",
        mcpServer: "github",
        tokensEst: 13, // ceil(49 / 4)
        tokensLabel: "~13",
        truncated: false,
        turnRole: "assistant",
      },
    ]);
  });

  it("codex full-turn: turn 7 (the usage-bearing turn) shows only its OWN span, not the accumulated composition", async () => {
    const session = await processedCodexSession("full-turn");
    const spans = buildTurnDetail(session, 7);
    expect(spans).toHaveLength(1);
    expect(spans?.[0]?.category).toBe("assistantText");
    expect(spans?.[0]?.tokensEst).toBe(47); // ceil(185 / 4)
    expect(spans?.[0]?.tokensLabel).toBe("~47");
  });
});

// ---------------------------------------------------------------------------
// resolveSession — light smoke coverage (the I/O half; buildContextReport
// above is the primary gate per this task's brief).
// ---------------------------------------------------------------------------

describe("resolveSession", () => {
  it("resolves a claude-code session by id, scoped via --harness/roots", async () => {
    const ref = await resolveSession("cache-heavy", {
      harness: "claude-code",
      roots: { "claude-code": [CLAUDE_FIXTURES_ROOT] },
    });
    expect(ref.harness).toBe("claude-code");
    expect(ref.id).toBe("cache-heavy");
  });

  it("resolves a direct file path regardless of --harness", async () => {
    const refs = await discoverClaudeSessions([CLAUDE_FIXTURES_ROOT]);
    const target = refs.find((r) => r.path.endsWith("cache-heavy.jsonl"));
    if (!target) throw new Error("fixture missing");
    const ref = await resolveSession(target.path, {});
    expect(ref.id).toBe("cache-heavy");
  });

  it("picks the most-recently-modified session when no argument is given", async () => {
    const ref = await resolveSession(undefined, {
      harness: "codex",
      roots: { codex: [CODEX_FIXTURES_ROOT] },
    });
    expect(ref.harness).toBe("codex");
  });

  it("throws a clear error when no session matches the given id", async () => {
    await expect(
      resolveSession("does-not-exist", {
        harness: "claude-code",
        roots: { "claude-code": [CLAUDE_FIXTURES_ROOT] },
      }),
    ).rejects.toThrow(/no session found/);
  });
});
