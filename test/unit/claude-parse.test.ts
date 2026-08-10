import path from "node:path";
import { assert, describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "../../src/adapters/claude/discover.js";
import { parseClaudeSession } from "../../src/adapters/claude/parse.js";
import { readClaudeRecords } from "../../src/adapters/claude/records.js";
import type { SessionRef } from "../../src/model/types.js";

const FIXTURES_ROOT = path.join(import.meta.dirname, "../fixtures/claude-code");

function refs(): Promise<SessionRef[]> {
  return discoverClaudeSessions([FIXTURES_ROOT]);
}

function findRef(
  all: SessionRef[],
  versionDir: string,
  id: string
): SessionRef {
  const ref = all.find(
    (r) => r.id === id && r.path.includes(`${path.sep}${versionDir}${path.sep}`)
  );
  if (!ref) {
    throw new Error(`fixture ref not found: ${versionDir}/${id}`);
  }
  return ref;
}

describe("parseClaudeSession — warnings", () => {
  const cleanFixtures = [
    "normal-turns",
    "cache-heavy",
    "streaming-split",
    "sidechain-replay",
    "iterations-multi",
    "compaction",
    "tool-use-names",
    "cache-miss-reason",
  ];

  it.each(cleanFixtures)("%s parses with 0 warnings", async (id) => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", id);
    const { warnings } = await parseClaudeSession(ref);
    expect(warnings).toHaveLength(0);
  });

  it("unknown-type-and-model.jsonl produces exactly 1 unknown-record-type warning", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "unknown-type-and-model");
    const { warnings } = await parseClaudeSession(ref);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("unknown-record-type");
    expect(warnings[0]?.line).toBe(3);
  });

  it("v2.1.225 main sessions parse with 0 warnings", async () => {
    const all = await refs();
    for (const id of [
      "20000000-2000-4200-8200-200000000001",
      "20000000-2000-4200-8200-200000000003",
    ]) {
      const ref = findRef(all, "v2.1.225", id);
      // biome-ignore lint/performance/noAwaitInLoops: Fixture parsing is intentionally serialized for deterministic assertions.
      const { warnings } = await parseClaudeSession(ref);
      expect(warnings).toHaveLength(0);
    }
  });

  it("agent-abc123.jsonl's fork-context-ref produces 0 warnings (known/inert — contextLength is a parent-conversation turn-position counter, not tokens/chars; excluded from accounting, see docs/recon/claude-code.md)", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.225", "abc123");
    const { warnings } = await parseClaudeSession(ref);
    expect(warnings).toHaveLength(0);
  });
});

describe("parseClaudeSession — turn counts", () => {
  it("normal-turns.jsonl → 2 turns", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "normal-turns");
    const { session } = await parseClaudeSession(ref);
    expect(session.turns).toHaveLength(2);
    expect(session.turns.every((t) => t.role === "assistant")).toBe(true);
  });

  it("streaming-split.jsonl → 4 turns total, 3 share message.id in raw (undeduped)", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "streaming-split");
    const { session } = await parseClaudeSession(ref);
    expect(session.turns).toHaveLength(4);

    const streamed = session.turns.filter(
      (t) =>
        (t.usage.raw as { message: { id: string } }).message.id ===
        "msg-stream-0001"
    );
    expect(streamed).toHaveLength(3);
    // usage is identical (repeated) across the streaming-split trio
    for (const t of streamed) {
      expect(t.usage.inputUncached).toBe(1000);
      expect(t.usage.cacheRead).toBe(500);
      expect(t.usage.output).toBe(300);
    }
  });

  it("sidechain-replay.jsonl → 2 turns, both message.id msg-orig-0001 (dedup is T2.1, not here)", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "sidechain-replay");
    const { session } = await parseClaudeSession(ref);
    expect(session.turns).toHaveLength(2);
    for (const t of session.turns) {
      expect((t.usage.raw as { message: { id: string } }).message.id).toBe(
        "msg-orig-0001"
      );
    }
    const sidechainFlags = session.turns.map(
      (t) => (t.usage.raw as { isSidechain: boolean }).isSidechain
    );
    expect(
      sidechainFlags.sort((left, right) => Number(left) - Number(right))
    ).toEqual([false, true]);
  });

  it("compaction.jsonl → 3 turns (isApiErrorMessage turn kept, not dropped)", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "compaction");
    const { session } = await parseClaudeSession(ref);
    expect(session.turns).toHaveLength(3);
  });

  it("unknown-type-and-model.jsonl → 1 turn (unknown-type record produces no turn)", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "unknown-type-and-model");
    const { session } = await parseClaudeSession(ref);
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]?.model).toBe("<synthetic>");
  });
});

describe("parseClaudeSession — usage invariants", () => {
  it("cache-heavy.jsonl: TTL sub-split lands in cacheWrite1h/5m; no-sub-object turn lands all in cacheWrite5m", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "cache-heavy");
    const { session } = await parseClaudeSession(ref);
    expect(session.turns).toHaveLength(2);

    const [withSplit, withoutSplit] = session.turns;
    assert(withSplit);
    assert(withoutSplit);
    expect(withSplit.usage.cacheWrite1h).toBe(1000);
    expect(withSplit.usage.cacheWrite5m).toBe(500);

    expect(withoutSplit.usage.cacheWrite1h).toBe(0);
    expect(withoutSplit.usage.cacheWrite5m).toBe(900);
  });

  it("iterations-multi.jsonl: turn usage sums both iterations", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "iterations-multi");
    const { session } = await parseClaudeSession(ref);
    expect(session.turns).toHaveLength(1);
    const turn = session.turns.at(0);
    assert(turn);
    // iterations: {input:300,output:80} + {input:200,output:40} = {500,120},
    // matching (and derived independently of) the top-level mirror.
    expect(turn.usage.inputUncached).toBe(500);
    expect(turn.usage.output).toBe(120);
    expect(turn?.contextTotal).toBe(500);
  });

  it("cache-miss-reason.jsonl: cache_miss_reason surfaces on the turn", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "cache-miss-reason");
    const { session } = await parseClaudeSession(ref);
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]?.cacheMissReason).toEqual({
      cache_missed_input_tokens: 4500,
      type: "system_changed",
    });
  });

  it("normal-turns.jsonl: contextTotal invariant holds per turn", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "normal-turns");
    const { session } = await parseClaudeSession(ref);
    for (const t of session.turns) {
      expect(t.contextTotal).toBe(
        t.usage.inputUncached +
          t.usage.cacheRead +
          t.usage.cacheWrite5m +
          t.usage.cacheWrite1h
      );
    }
  });
});

describe("parseClaudeSession — compaction fixture", () => {
  it("isCompactSummary record is present in raw records (readClaudeRecords itself builds no events)", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "compaction");
    const { records, warnings } = await readClaudeRecords(ref.path);
    expect(warnings).toHaveLength(0);
    const compactSummary = records.find((r) => r.raw.isCompactSummary === true);
    expect(compactSummary).toBeDefined();
    expect(compactSummary?.type).toBe("user");
  });

  it("the isApiErrorMessage record produces an ErrorEvent; usage stays as recorded (zero)", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "compaction");
    const { session } = await parseClaudeSession(ref);

    const errorEvents = session.events.filter((e) => e.kind === "error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      kind: "error",
      message: "api-error assistant record",
      raw: { messageId: "msg-0002" },
    });

    const errorTurn = session.turns.find(
      (t) => (t.usage.raw as { uuid: string }).uuid === "a-0002"
    );
    expect(errorTurn).toBeDefined();
    expect(errorTurn?.contextTotal).toBe(0);
    expect(errorTurn?.usage.output).toBe(0);

    // contextEdit: no applied_edits in this fixture. Compaction anchoring
    // itself is asserted in detail in claude-spans.test.ts.
    expect(session.events.some((e) => e.kind === "compaction")).toBe(true);
    expect(session.events.some((e) => e.kind === "contextEdit")).toBe(false);
  });
});

describe("parseClaudeSession — cross-version + subagent children", () => {
  it("both v2.1.104 and v2.1.225 fixtures parse without throwing", async () => {
    const all = await refs();
    const v104 = findRef(all, "v2.1.104", "normal-turns");
    const v225 = findRef(
      all,
      "v2.1.225",
      "20000000-2000-4200-8200-200000000001"
    );

    const [r104, r225] = await Promise.all([
      parseClaudeSession(v104),
      parseClaudeSession(v225),
    ]);
    expect(r104.session.harnessVersion).toBe("2.1.104");
    expect(r225.session.harnessVersion).toBe("2.1.225");
  });

  it("session 0001 lists its Task-spawned subagent as a child SessionRef (refs only)", async () => {
    const all = await refs();
    const ref = findRef(
      all,
      "v2.1.225",
      "20000000-2000-4200-8200-200000000001"
    );
    const { session } = await parseClaudeSession(ref);
    expect(session.children).toHaveLength(1);
    expect(session.children[0]?.id).toBe("abc123");
    expect(session.children[0]?.kind).toBe("subagent");
    expect(session.children[0]?.parentId).toBe(
      "20000000-2000-4200-8200-200000000001"
    );
  });

  it("session with no subagents dir has empty children", async () => {
    const all = await refs();
    const ref = findRef(
      all,
      "v2.1.225",
      "20000000-2000-4200-8200-200000000003"
    );
    const { session } = await parseClaudeSession(ref);
    expect(session.children).toHaveLength(0);
  });
});

// docs/PERF.md fix #1 — the `list` pipeline's lite parse (spans:false).
// Proves the flag actually empties contentSpans (the toggle engages) while
// every other computed field — usage, contextTotal, cost, events (including
// CompactionEvents) — comes out byte-for-byte identical to the spans:true
// default, since none of those are derived from contentSpans.
describe("parseClaudeSession — spans:false lite parse", () => {
  it("cache-heavy.jsonl: contentSpans empty, usage/contextTotal identical to spans:true", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "cache-heavy");
    const [full, lite] = await Promise.all([
      parseClaudeSession(ref),
      parseClaudeSession(ref, { spans: false }),
    ]);

    expect(full.session.turns.length).toBeGreaterThan(0);
    for (const turn of full.session.turns) {
      expect(turn.contentSpans.length).toBeGreaterThan(0);
    }

    expect(lite.session.turns).toHaveLength(full.session.turns.length);
    for (const turn of lite.session.turns) {
      expect(turn.contentSpans).toEqual([]);
    }

    lite.session.turns.forEach((liteTurn, i) => {
      const fullTurn = full.session.turns[i];
      expect(liteTurn.usage.inputUncached).toBe(fullTurn?.usage.inputUncached);
      expect(liteTurn.usage.cacheRead).toBe(fullTurn?.usage.cacheRead);
      expect(liteTurn.usage.cacheWrite5m).toBe(fullTurn?.usage.cacheWrite5m);
      expect(liteTurn.usage.cacheWrite1h).toBe(fullTurn?.usage.cacheWrite1h);
      expect(liteTurn.usage.output).toBe(fullTurn?.usage.output);
      expect(liteTurn.contextTotal).toBe(fullTurn?.contextTotal);
      expect(liteTurn.cost).toEqual(fullTurn?.cost);
    });
  });

  it("compaction.jsonl: CompactionEvents and error events identical, usage identical, contentSpans empty", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "compaction");
    const [full, lite] = await Promise.all([
      parseClaudeSession(ref),
      parseClaudeSession(ref, { spans: false }),
    ]);

    for (const turn of lite.session.turns) {
      expect(turn.contentSpans).toEqual([]);
    }

    const fullCompactions = full.session.events.filter(
      (e) => e.kind === "compaction"
    );
    const liteCompactions = lite.session.events.filter(
      (e) => e.kind === "compaction"
    );
    expect(fullCompactions.length).toBeGreaterThan(0);
    expect(liteCompactions).toEqual(fullCompactions);

    const fullErrors = full.session.events.filter((e) => e.kind === "error");
    const liteErrors = lite.session.events.filter((e) => e.kind === "error");
    expect(liteErrors).toEqual(fullErrors);

    expect(lite.session.turns).toHaveLength(full.session.turns.length);
    lite.session.turns.forEach((liteTurn, i) => {
      const fullTurn = full.session.turns[i];
      expect(liteTurn.usage.inputUncached).toBe(fullTurn?.usage.inputUncached);
      expect(liteTurn.usage.output).toBe(fullTurn?.usage.output);
      expect(liteTurn.contextTotal).toBe(fullTurn?.contextTotal);
    });
  });
});
