import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "../../src/adapters/claude/discover.js";
import { parseClaudeSession } from "../../src/adapters/claude/parse.js";
import {
  dedupTurns,
  extractDedupKey,
  mergeStreamingSplit,
  pickSidechainWinner,
} from "../../src/engine/dedup.js";
import type {
  NormalizedUsage,
  SessionRef,
  Span,
  Turn,
} from "../../src/model/types.js";

const FIXTURES_ROOT = path.join(__dirname, "../fixtures/claude-code");

async function refs(): Promise<SessionRef[]> {
  return discoverClaudeSessions([FIXTURES_ROOT]);
}

function findRef(
  all: SessionRef[],
  versionDir: string,
  id: string,
): SessionRef {
  const ref = all.find(
    (r) =>
      r.id === id && r.path.includes(`${path.sep}${versionDir}${path.sep}`),
  );
  if (!ref) throw new Error(`fixture ref not found: ${versionDir}/${id}`);
  return ref;
}

// --- synthetic Turn builder, for testing the merge/pick helpers and
// passthrough/ordering behavior directly without going through a parser. ---

function usage(
  partial: Partial<NormalizedUsage> & { raw: unknown },
): NormalizedUsage {
  return {
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    ...partial,
  };
}

function makeTurn(opts: {
  raw: unknown;
  spans?: Span[];
  usage?: Partial<Omit<NormalizedUsage, "raw">>;
  role?: Turn["role"];
  model?: string;
  timestamp?: Date;
}): Turn {
  const u = usage({ ...opts.usage, raw: opts.raw });
  return {
    role: opts.role ?? "assistant",
    model: opts.model ?? "claude-sonnet-5",
    timestamp: opts.timestamp ?? new Date(0),
    contentSpans: opts.spans ?? [],
    usage: u,
    contextTotal:
      u.inputUncached + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h,
    composition: {
      categories: {
        userText: 0,
        assistantText: 0,
        thinking: 0,
        toolResults: 0,
        toolCallArgs: 0,
        instructionInjection: 0,
        systemPrompt: 0,
        toolSchemas: 0,
        compactionSummaries: 0,
        coordination: 0,
      },
      residual: 0,
      residualShare: 0,
      truncated: false,
    },
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      total: 0,
      mode: "auto",
      priced: false,
    },
  };
}

function assistantSpan(text: string): Span {
  return {
    category: "assistantText",
    charCount: text.length,
    text,
    truncated: false,
    turnRole: "assistant",
  };
}

describe("dedupTurns — streaming-split fixture (real parse)", () => {
  it("merges the 3-fragment message.id family into 1 turn (4 raw -> 2 deduped)", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "streaming-split");
    const { session } = await parseClaudeSession(ref);
    expect(session.turns).toHaveLength(4);

    const deduped = dedupTurns(session.turns);
    expect(deduped).toHaveLength(2);

    const merged = deduped.find(
      (t) =>
        (t.usage.raw as { message: { id: string } }).message.id ===
        "msg-stream-0001",
    );
    expect(merged).toBeDefined();

    // usage counted once, not summed across the 3 fragments
    expect(merged?.usage.inputUncached).toBe(1000);
    expect(merged?.usage.cacheRead).toBe(500);
    expect(merged?.usage.output).toBe(300);
    expect(merged?.contextTotal).toBe(1500);

    // contentSpans = concatenation of the 3 records' spans, in record order
    const originalFragments = session.turns.filter(
      (t) =>
        (t.usage.raw as { message: { id: string } }).message.id ===
        "msg-stream-0001",
    );
    expect(originalFragments).toHaveLength(3);
    expect(merged?.contentSpans).toEqual(
      originalFragments.flatMap((t) => t.contentSpans),
    );

    const other = deduped.find(
      (t) =>
        (t.usage.raw as { message: { id: string } }).message.id === "msg-0002",
    );
    expect(other).toBeDefined();
  });
});

describe("dedupTurns — sidechain-replay fixture (real parse, #913)", () => {
  it("keeps the non-sidechain original; cache_read is counted once", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "sidechain-replay");
    const { session } = await parseClaudeSession(ref);
    expect(session.turns).toHaveLength(2);

    const deduped = dedupTurns(session.turns);
    expect(deduped).toHaveLength(1);

    const survivor = deduped[0];
    expect(survivor).toBeDefined();
    expect((survivor?.usage.raw as { isSidechain: boolean }).isSidechain).toBe(
      false,
    );
    expect((survivor?.usage.raw as { requestId: string }).requestId).toBe(
      "req-orig-0001",
    );

    // the #913 regression: cache_read counted once, not doubled by the replay
    expect(survivor?.usage.cacheRead).toBe(1800);
    expect(survivor?.contextTotal).toBe(2000 + 1800);
  });
});

describe("dedupTurns — idempotence", () => {
  it("dedup(dedup(x)) equals dedup(x) on the streaming-split + sidechain fixtures combined", async () => {
    const all = await refs();
    const streamRef = findRef(all, "v2.1.104", "streaming-split");
    const sidechainRef = findRef(all, "v2.1.104", "sidechain-replay");
    const [stream, sidechain] = await Promise.all([
      parseClaudeSession(streamRef),
      parseClaudeSession(sidechainRef),
    ]);

    const combined = [...stream.session.turns, ...sidechain.session.turns];
    const once = dedupTurns(combined);
    const twice = dedupTurns(once);
    expect(twice).toEqual(once);
  });

  it("holds on synthetic turns via the exported helpers too", () => {
    const a = makeTurn({
      raw: { message: { id: "m1" }, requestId: "r1", isSidechain: false },
      usage: { inputUncached: 10, output: 2 },
      spans: [assistantSpan("a")],
    });
    const b = makeTurn({
      raw: { message: { id: "m1" }, requestId: "r1", isSidechain: false },
      usage: { inputUncached: 10, output: 2 },
      spans: [assistantSpan("b")],
    });
    const replay = makeTurn({
      raw: { message: { id: "m1" }, requestId: "r2", isSidechain: true },
      usage: { inputUncached: 10, output: 2 },
    });
    const unrelated = makeTurn({
      raw: { message: { id: "m2" }, requestId: "r3", isSidechain: false },
      usage: { inputUncached: 5, output: 1 },
    });

    const once = dedupTurns([a, b, replay, unrelated]);
    const twice = dedupTurns(once);
    expect(twice).toEqual(once);
  });
});

describe("dedupTurns — keys-absent passthrough (pi-shaped turns)", () => {
  it("is a no-op when message.id/requestId are absent from raw", () => {
    // pi entries don't carry message.id/requestId at all — the pi adapter's
    // usage.raw is shaped like a plain pi log entry.
    const piTurn = makeTurn({
      raw: { entryType: "message", role: "assistant", cacheWrite: 100 },
      usage: { inputUncached: 42, output: 7 },
    });
    const anotherPiTurn = makeTurn({
      raw: { entryType: "message", role: "assistant", cacheWrite: 50 },
      usage: { inputUncached: 5, output: 1 },
    });

    const result = dedupTurns([piTurn, anotherPiTurn]);
    expect(result).toEqual([piTurn, anotherPiTurn]);
    expect(result).toHaveLength(2);
  });

  it("extractDedupKey returns undefined when either field is missing", () => {
    expect(
      extractDedupKey(makeTurn({ raw: { message: { id: "m1" } } })), // no requestId
    ).toBeUndefined();
    expect(
      extractDedupKey(makeTurn({ raw: { requestId: "r1" } })), // no message.id
    ).toBeUndefined();
    expect(extractDedupKey(makeTurn({ raw: undefined }))).toBeUndefined();
  });

  it("non-assistant turns pass through untouched even with matching keys", () => {
    const userTurn = makeTurn({
      raw: { message: { id: "m1" }, requestId: "r1" },
      role: "user",
    });
    const assistantTurn = makeTurn({
      raw: { message: { id: "m1" }, requestId: "r1" },
      role: "assistant",
    });

    const result = dedupTurns([userTurn, assistantTurn]);
    // the assistant turn is a singleton group of 1 (merges to itself); the
    // user turn is never eligible and passes through as a separate turn
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(userTurn);
  });
});

describe("dedupTurns — ordering stability", () => {
  it("places merged/kept turns at the family's earliest position; preserves passthrough order", () => {
    const p1 = makeTurn({ raw: { tag: "passthrough-1" } });
    const s1 = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });
    const p2 = makeTurn({ raw: { tag: "passthrough-2" } });
    const s2 = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });
    const p3 = makeTurn({ raw: { tag: "passthrough-3" } });

    const result = dedupTurns([p1, s1, p2, s2, p3]);
    // p1, merged(s1,s2) at s1's position, p2, p3
    expect(result).toHaveLength(4);
    expect(result[0]).toBe(p1);
    expect(
      (result[1]?.usage.raw as { message: { id: string } }).message.id,
    ).toBe("m1");
    expect(result[1]?.contentSpans).toHaveLength(0);
    expect(result[2]).toBe(p2);
    expect(result[3]).toBe(p3);
  });

  it("keeps the sidechain family anchored at its earliest record even when the winner is the second record", () => {
    const before = makeTurn({ raw: { tag: "before" } });
    const sidechainFirst = makeTurn({
      raw: { message: { id: "m1" }, requestId: "r1", isSidechain: true },
      usage: { inputUncached: 1, output: 1 },
    });
    const nonSidechainSecond = makeTurn({
      raw: { message: { id: "m1" }, requestId: "r2", isSidechain: false },
      usage: { inputUncached: 99, output: 99 },
    });
    const after = makeTurn({ raw: { tag: "after" } });

    const result = dedupTurns([
      before,
      sidechainFirst,
      nonSidechainSecond,
      after,
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(before);
    expect((result[1]?.usage.raw as { isSidechain: boolean }).isSidechain).toBe(
      false,
    );
    expect(result[1]?.usage.inputUncached).toBe(99);
    expect(result[2]).toBe(after);
  });
});

describe("mergeStreamingSplit — direct helper tests", () => {
  it("returns the single turn unchanged for a group of 1", () => {
    const t = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });
    expect(mergeStreamingSplit([t])).toBe(t);
  });

  it("concatenates contentSpans across fragments in order", () => {
    const t1 = makeTurn({
      raw: { message: { id: "m1" }, requestId: "r1" },
      spans: [assistantSpan("think")],
    });
    const t2 = makeTurn({
      raw: { message: { id: "m1" }, requestId: "r1" },
      spans: [assistantSpan("text")],
    });
    const t3 = makeTurn({
      raw: { message: { id: "m1" }, requestId: "r1" },
      spans: [assistantSpan("tool")],
    });

    const merged = mergeStreamingSplit([t1, t2, t3]);
    expect(merged.contentSpans.map((s) => s.text)).toEqual([
      "think",
      "text",
      "tool",
    ]);
  });

  it("falls back to the max-total fragment when usage unexpectedly differs", () => {
    const low = makeTurn({
      raw: { message: { id: "m1" }, requestId: "r1" },
      usage: { inputUncached: 10, output: 1 },
    });
    const high = makeTurn({
      raw: { message: { id: "m1" }, requestId: "r1" },
      usage: { inputUncached: 500, output: 50 },
    });

    const merged = mergeStreamingSplit([low, high]);
    expect(merged.usage.inputUncached).toBe(500);
    expect(merged.usage.output).toBe(50);
  });
});

describe("pickSidechainWinner — direct helper tests", () => {
  it("prefers non-sidechain over sidechain regardless of token totals", () => {
    const sidechainBigger = makeTurn({
      raw: { isSidechain: true },
      usage: { inputUncached: 1000, output: 1000 },
    });
    const nonSidechainSmaller = makeTurn({
      raw: { isSidechain: false },
      usage: { inputUncached: 1, output: 1 },
    });

    expect(pickSidechainWinner([sidechainBigger, nonSidechainSmaller])).toBe(
      nonSidechainSmaller,
    );
    expect(pickSidechainWinner([nonSidechainSmaller, sidechainBigger])).toBe(
      nonSidechainSmaller,
    );
  });

  it("breaks a sidechain-ness tie by higher total token count", () => {
    const smaller = makeTurn({
      raw: { isSidechain: false },
      usage: { inputUncached: 10, output: 5 },
    });
    const bigger = makeTurn({
      raw: { isSidechain: false },
      usage: { inputUncached: 100, output: 50 },
    });

    expect(pickSidechainWinner([smaller, bigger])).toBe(bigger);
  });

  it("treats a missing isSidechain field as non-sidechain", () => {
    const noFlag = makeTurn({ raw: { requestId: "r1" } });
    const explicitSidechain = makeTurn({
      raw: { requestId: "r2", isSidechain: true },
      usage: { inputUncached: 1000, output: 1000 },
    });

    expect(pickSidechainWinner([explicitSidechain, noFlag])).toBe(noFlag);
  });
});
