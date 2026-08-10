// dedup.ts's dedupSession/dedupTurnsWithMap — turnIndex remap regression
// (orchestrator-triaged fix): CompactionEvent.turnIndex is computed by
// adapters against PRE-dedup turns[], but composition.ts (reset boundaries)
// and compaction.ts (finalizeCompactions fill-from-next-turn) consume it
// against POST-dedup turns[]. dedupSession is the correctness boundary that
// remaps turnIndex through the same indexMap used to dedup turns.

import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "../../src/adapters/claude/discover.js";
import { parseClaudeSession } from "../../src/adapters/claude/parse.js";
import {
  finalizeCompactions,
  findTokensAfter,
} from "../../src/engine/compaction.js";
import { computeComposition } from "../../src/engine/composition.js";
import {
  dedupSession,
  dedupTurns,
  dedupTurnsWithMap,
} from "../../src/engine/dedup.js";
import type {
  CompactionEvent,
  CompositionCategory,
  NormalizedUsage,
  Session,
  SessionEvent,
  SessionRef,
  Span,
  Turn,
} from "../../src/model/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, "../fixtures/claude-code");

function refs(): Promise<SessionRef[]> {
  return discoverClaudeSessions([FIXTURES_ROOT]);
}

function findRef(
  all: SessionRef[],
  versionDir: string,
  id: string
): SessionRef {
  const ref = all.find(
    (r) => r.id === id && r.path.includes(`${sep}${versionDir}${sep}`)
  );
  if (!ref) {
    throw new Error(`fixture ref not found: ${versionDir}/${id}`);
  }
  return ref;
}

// --- synthetic Turn/Session builders (self-contained; not shared with
// dedup.test.ts/composition.test.ts's local helpers) ---

function usage(
  partial: Partial<NormalizedUsage> & { raw: unknown }
): NormalizedUsage {
  return {
    cacheRead: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    inputUncached: 0,
    output: 0,
    ...partial,
  };
}

function zeroCategories(): Record<CompositionCategory, number> {
  return {
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
  };
}

function makeTurn(opts: {
  raw: unknown;
  spans?: Span[];
  usage?: Partial<Omit<NormalizedUsage, "raw">>;
  role?: Turn["role"];
}): Turn {
  const u = usage({ ...opts.usage, raw: opts.raw });
  return {
    composition: {
      categories: zeroCategories(),
      residual: 0,
      residualShare: 0,
      truncated: false,
    },
    contentSpans: opts.spans ?? [],
    contextTotal:
      u.inputUncached + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h,
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
    model: "claude-sonnet-5",
    role: opts.role ?? "assistant",
    timestamp: new Date(0),
    usage: u,
  };
}

function makeCompactionEvent(turnIndex: number): CompactionEvent {
  return {
    at: new Date(0),
    cost: null,
    discardedEst: null,
    kind: "compaction",
    shrinkExact: null,
    summaryTokensEst: 0,
    tokensAfterExact: null,
    tokensBeforeExact: null,
    turnIndex,
  };
}

function makeSession(turns: Turn[], events: SessionEvent[]): Session {
  return {
    children: [],
    configSnapshot: { model: "m", modelChanges: [] },
    cwd: "/",
    endedAt: new Date(0),
    events,
    harness: "claude-code",
    harnessVersion: "test",
    id: "synthetic",
    startedAt: new Date(0),
    turns,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// dedupTurnsWithMap — indexMap semantics
// ---------------------------------------------------------------------------

describe("dedupTurnsWithMap — indexMap semantics", () => {
  it("identity mapping when there are no duplicates", () => {
    const a = makeTurn({ raw: { tag: "a" } });
    const b = makeTurn({ raw: { tag: "b" } });
    const c = makeTurn({ raw: { tag: "c" } });

    const { turns, indexMap } = dedupTurnsWithMap([a, b, c]);
    expect(turns).toEqual([a, b, c]);
    expect(indexMap).toEqual([0, 1, 2]);
  });

  it("absorption mapping: every fragment of a merged streaming-split group maps to the merged turn's final index", () => {
    const before = makeTurn({ raw: { tag: "before" } });
    const frag1 = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });
    const frag2 = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });
    const frag3 = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });
    const after = makeTurn({ raw: { tag: "after" } });

    const { turns, indexMap } = dedupTurnsWithMap([
      before,
      frag1,
      frag2,
      frag3,
      after,
    ]);
    // before(0), merged(1), after(2) — 5 raw -> 3 deduped.
    expect(turns).toHaveLength(3);
    expect(indexMap[0]).toBe(0); // before -> itself
    expect(indexMap[1]).toBe(1); // frag1 (anchor) -> the merged turn
    expect(indexMap[2]).toBe(1); // frag2 -> the merged turn
    expect(indexMap[3]).toBe(1); // frag3 -> the merged turn
    expect(indexMap[4]).toBe(2); // after -> itself, shifted down by the 2 collapsed slots
  });

  it("sidechain-loser mapping: both the winner and the loser in a replay family map to the winner's final index", () => {
    const before = makeTurn({ raw: { tag: "before" } });
    const sidechainLoser = makeTurn({
      raw: { isSidechain: true, message: { id: "m1" }, requestId: "r1" },
      usage: { inputUncached: 1, output: 1 },
    });
    const nonSidechainWinner = makeTurn({
      raw: { isSidechain: false, message: { id: "m1" }, requestId: "r2" },
      usage: { inputUncached: 99, output: 99 },
    });
    const after = makeTurn({ raw: { tag: "after" } });

    const { turns, indexMap } = dedupTurnsWithMap([
      before,
      sidechainLoser,
      nonSidechainWinner,
      after,
    ]);
    expect(turns).toHaveLength(3);
    // Winner is anchored at the family's earliest record (index 1, the loser's
    // original position) per dedup.ts's ordering rule.
    expect(turns[1]).toBe(nonSidechainWinner);
    expect(indexMap[0]).toBe(0);
    expect(indexMap[1]).toBe(1); // the loser's original index also maps here
    expect(indexMap[2]).toBe(1); // the winner's original index maps here too
    expect(indexMap[3]).toBe(2);
  });

  it("non-assistant/keyless turns map through identity positions", () => {
    const userTurn = makeTurn({
      raw: { message: { id: "m1" }, requestId: "r1" },
      role: "user",
    });
    const assistantTurn = makeTurn({
      raw: { message: { id: "m1" }, requestId: "r1" },
      role: "assistant",
    });

    const { turns, indexMap } = dedupTurnsWithMap([userTurn, assistantTurn]);
    expect(turns).toHaveLength(2);
    expect(indexMap).toEqual([0, 1]);
  });

  it("dedupTurns (the thin wrapper) matches dedupTurnsWithMap(...).turns exactly", () => {
    const frag1 = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });
    const frag2 = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });
    const solo = makeTurn({ raw: { tag: "solo" } });

    expect(dedupTurns([frag1, frag2, solo])).toEqual(
      dedupTurnsWithMap([frag1, frag2, solo]).turns
    );
  });
});

// ---------------------------------------------------------------------------
// dedupSession — event remap + idempotence
// ---------------------------------------------------------------------------

describe("dedupSession — CompactionEvent.turnIndex remap", () => {
  it("remaps turnIndex through the indexMap when a merge shifts positions before it", () => {
    const frag1 = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });
    const frag2 = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });
    const postCompaction = makeTurn({ raw: { tag: "post" } });

    // Adapter-style pre-dedup turnIndex: 2 (the post-compaction turn's
    // position in the raw, pre-dedup turns[]).
    const session = makeSession(
      [frag1, frag2, postCompaction],
      [makeCompactionEvent(2)]
    );
    const deduped = dedupSession(session);
    expect(deduped.turns).toHaveLength(2);

    const event = deduped.events.at(0);
    if (event?.kind !== "compaction") {
      throw new Error("unreachable");
    }
    expect(event.turnIndex).toBe(1); // shifted down by 1 (2 fragments -> 1 turn)
  });

  it("maps the one-past-the-end sentinel to the POST-dedup turns.length", () => {
    const frag1 = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });
    const frag2 = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });
    const frag3 = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });

    // Marker is the last thing in the file: turnIndex === pre-dedup turns.length (3).
    const session = makeSession(
      [frag1, frag2, frag3],
      [makeCompactionEvent(3)]
    );
    const deduped = dedupSession(session);
    expect(deduped.turns).toHaveLength(1);

    const event = deduped.events.at(0);
    if (event?.kind !== "compaction") {
      throw new Error("unreachable");
    }
    expect(event.turnIndex).toBe(1); // post-dedup turns.length, not the stale pre-dedup 3
  });

  it("leaves non-compaction events untouched", () => {
    const frag1 = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });
    const frag2 = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });
    const errorEvent: SessionEvent = {
      at: new Date(0),
      kind: "error",
      message: "boom",
    };

    const session = makeSession([frag1, frag2], [errorEvent]);
    const deduped = dedupSession(session);
    expect(deduped.events[0]).toEqual(errorEvent);
  });

  it("is idempotent: dedupSession(dedupSession(x)) equals dedupSession(x)", () => {
    const frag1 = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });
    const frag2 = makeTurn({ raw: { message: { id: "m1" }, requestId: "r1" } });
    const postCompaction = makeTurn({ raw: { tag: "post" } });
    const session = makeSession(
      [frag1, frag2, postCompaction],
      [makeCompactionEvent(2)]
    );

    const once = dedupSession(session);
    const twice = dedupSession(once);
    expect(twice.turns).toEqual(once.turns);
    expect(twice.events).toEqual(once.events);
  });
});

// ---------------------------------------------------------------------------
// Fixture-based end-to-end: streaming-split-compaction.jsonl
// ---------------------------------------------------------------------------

describe("dedupSession — streaming-split-compaction fixture (real parse)", () => {
  it("adapter's pre-dedup turnIndex (3) and dedupSession's remapped turnIndex (1) differ, as designed", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.225", "streaming-split-compaction");
    const { session } = await parseClaudeSession(ref);

    expect(session.turns).toHaveLength(4); // 3 streaming fragments + 1 post-compaction turn
    const rawEvent = session.events.find(
      (e): e is CompactionEvent => e.kind === "compaction"
    );
    expect(rawEvent).toBeDefined();
    expect(rawEvent?.turnIndex).toBe(3); // adapter's pre-dedup convention

    const deduped = dedupSession(session);
    expect(deduped.turns).toHaveLength(2); // 3 fragments merged into 1 + the post-compaction turn

    const remappedEvent = deduped.events.find(
      (e): e is CompactionEvent => e.kind === "compaction"
    );
    expect(remappedEvent).toBeDefined();
    expect(remappedEvent?.turnIndex).toBe(1); // points at the post-compaction turn's real position
  });

  it("computeComposition resets at the correct (remapped) boundary — pre-compaction accumulation does not leak past it", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.225", "streaming-split-compaction");
    const { session } = await parseClaudeSession(ref);

    const deduped = dedupSession(session);
    const composed = computeComposition(deduped);
    const [merged, post] = composed.turns;
    assert(merged);
    assert(post);

    // Merged streaming-split turn (contextTotal 5000): userText 52 chars,
    // thinking excluded (claude-code), assistantText 31 chars, toolCallArgs
    // 28 chars (JSON.stringify({"command":"echo streaming"})).
    expect(merged?.contextTotal).toBe(5000);
    expect(merged.composition.categories.userText).toBe(13); // ceil(52/4)
    expect(merged.composition.categories.thinking).toBe(0);
    expect(merged.composition.categories.assistantText).toBe(8); // ceil(31/4)
    expect(merged.composition.categories.toolCallArgs).toBe(7); // ceil(28/4)

    // Post-compaction turn (contextTotal 3000): reset boundary — userText and
    // toolCallArgs are back to 0, NOT inherited from the merged turn's phase.
    // compactionSummaries (144 chars) + this turn's own assistantText (49
    // chars) reseed the new phase.
    expect(post?.contextTotal).toBe(3000);
    expect(post.composition.categories.userText).toBe(0);
    expect(post.composition.categories.toolCallArgs).toBe(0);
    expect(post.composition.categories.compactionSummaries).toBe(36); // ceil(144/4)
    expect(post.composition.categories.assistantText).toBe(13); // ceil(49/4)

    // Σ categories + residual = contextTotal invariant on both turns.
    for (const turn of composed.turns) {
      const sum = Object.values(turn.composition.categories).reduce(
        (a, b) => a + b,
        0
      );
      expect(sum + turn.composition.residual).toBe(turn.contextTotal);
    }
  });

  it("finalizeCompactions reports before/after anchored to the correct (deduped) turns", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.225", "streaming-split-compaction");
    const { session } = await parseClaudeSession(ref);

    const deduped = dedupSession(session);
    const finalized = finalizeCompactions(deduped);
    const event = finalized.events.find(
      (e): e is CompactionEvent => e.kind === "compaction"
    );
    expect(event).toBeDefined();
    expect(event?.tokensBeforeExact).toBe(5000); // merged streaming-split turn
    expect(event?.tokensAfterExact).toBe(3000); // the post-compaction turn
    expect(event?.shrinkExact).toBe(2000);
    expect(event?.discardedEst).toBe(2036); // 2000 + summaryTokensEst(36)

    // Regression demonstration: findTokensAfter against the DEDUPED turns[]
    // using the stale, unremapped pre-dedup turnIndex (3) is out of range
    // for the 2-element deduped array and finds nothing — this is exactly
    // the bug dedupSession's remap prevents.
    expect(findTokensAfter(deduped.turns, 3)).toBeNull();
    expect(findTokensAfter(deduped.turns, 1)).toBe(3000); // the remapped, correct index
  });
});
