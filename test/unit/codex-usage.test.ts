import path from "node:path";
import { assert, describe, expect, it } from "vitest";
import { discoverCodexSessions } from "../../src/adapters/codex/discover.js";
import { parseCodexSession } from "../../src/adapters/codex/parse.js";
import { finalizeCompactions } from "../../src/engine/compaction.js";
import type { CompactionEvent, SessionRef } from "../../src/model/types.js";

const FIXTURES_ROOT = path.join(import.meta.dirname, "../fixtures/codex");

function refs(): Promise<SessionRef[]> {
  return discoverCodexSessions([FIXTURES_ROOT]);
}

function findRef(all: SessionRef[], id: string): SessionRef {
  const ref = all.find((r) => r.id === id);
  if (!ref) {
    throw new Error(`fixture ref not found: ${id}`);
  }
  return ref;
}

function isCompactionEvent(event: { kind: string }): event is CompactionEvent {
  return event.kind === "compaction";
}

describe("token_count -> usage attachment — v0.134/full-turn.jsonl", () => {
  it("attaches the single token_count to the final assistant turn, subset->additive arithmetic", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "full-turn"));
    const finalTurn = session.turns.at(6);
    assert(finalTurn);
    expect(finalTurn.role).toBe("assistant");
    // Fixture's token_count: input_tokens 18420, cached_input_tokens 12000,
    // output_tokens 612, reasoning_output_tokens 180, no
    // cache_write_input_tokens. Subset semantics: inputUncached = input -
    // cached; contextTotal = inputUncached + cacheRead (+ cacheWrite, 0
    // here) = input_tokens exactly.
    expect(finalTurn.usage.inputUncached).toBe(6420);
    expect(finalTurn.usage.cacheRead).toBe(12_000);
    expect(finalTurn.usage.cacheWrite5m).toBe(0);
    expect(finalTurn.usage.cacheWrite1h).toBe(0);
    expect(finalTurn.usage.output).toBe(612);
    expect(finalTurn.usage.reasoningOutput).toBe(180);
    expect(finalTurn?.contextTotal).toBe(18_420);
  });

  it("earlier assistant-role turns (reasoning, function_calls) never receive usage — only the turn-closing token_count target does", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "full-turn"));
    const reasoningTurn = session.turns.at(1);
    const firstCallTurn = session.turns.at(2);
    const secondCallTurn = session.turns.at(4);
    expect(reasoningTurn?.contextTotal).toBe(0);
    expect(firstCallTurn?.contextTotal).toBe(0);
    expect(secondCallTurn?.contextTotal).toBe(0);
  });

  it("task_complete (turn_complete wire alias) is tolerated — no warning", async () => {
    const all = await refs();
    const { warnings } = await parseCodexSession(findRef(all, "full-turn"));
    expect(warnings).toHaveLength(0);
  });
});

describe("token_count -> usage attachment — v0.134/real-capture-redacted.jsonl", () => {
  it("attaches the single real token_count; contextTotal 37476 = 36068 + 1408", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(
      findRef(all, "real-capture-redacted")
    );
    const assistantTurn = session.turns.find((t) => t.role === "assistant");
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn?.usage.inputUncached).toBe(36_068);
    expect(assistantTurn?.usage.cacheRead).toBe(1408);
    expect(assistantTurn?.contextTotal).toBe(37_476);
  });

  it("cumulative cross-check passes (single token_count: cumulative === last, no mismatch warning)", async () => {
    const all = await refs();
    const { warnings } = await parseCodexSession(
      findRef(all, "real-capture-redacted")
    );
    expect(warnings.some((w) => w.code === "token-count-mismatch")).toBe(false);
  });
});

describe("compacted -> CompactionEvent — v0.134/compaction.jsonl", () => {
  it("turnIndex = turns.length at the marker (2)", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "compaction"));
    const compactionEvents = session.events.filter(isCompactionEvent);
    expect(compactionEvents).toHaveLength(1);
    const event = compactionEvents[0] as CompactionEvent;
    expect(event.turnIndex).toBe(2);
  });

  it("tokensBeforeExact/tokensAfterExact/shrinkExact/discardedEst are null at parse level (engine-style — pi precedent, no adapter->engine anchoring)", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "compaction"));
    const event = session.events.find(isCompactionEvent) as CompactionEvent;
    expect(event.tokensBeforeExact).toBeNull();
    expect(event.tokensAfterExact).toBeNull();
    expect(event.shrinkExact).toBeNull();
    expect(event.discardedEst).toBeNull();
    expect(event.cost).toBeNull();
  });

  it("summaryTokensEst = ceil(message.length / 4)", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "compaction"));
    const event = session.events.find(isCompactionEvent) as CompactionEvent;
    const message =
      "Compacted 38 turns of tool output and file reads into a summary: implemented client-side validation for 4 of 6 forms under src/forms/ (LoginForm, SignupForm, ProfileForm, BillingForm) with matching unit tests; SettingsForm and InviteForm remain.";
    expect(event.summaryTokensEst).toBe(Math.ceil(message.length / 4));
  });

  it("lineage populated from the compacted record's window_number/window_id/previous_window_id/first_window_id (v2, Lane F3)", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "compaction"));
    const event = session.events.find(isCompactionEvent) as CompactionEvent;
    expect(event.lineage).toEqual({
      firstWindowId: "0190f4a1-4e55-7f06-c077-d8e9f0a1b2c3",
      previousWindowId: "0190f4a1-4e55-7f06-c077-d8e9f0a1b2c3",
      windowId: "0190f4a1-5f66-7017-d188-e9f0a1b2c3d4",
      windowNumber: 1,
    });
  });

  it("the redundant context_compacted marker produces no second CompactionEvent", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "compaction"));
    expect(session.events.filter(isCompactionEvent)).toHaveLength(1);
  });

  it("post-compaction turn (added after the re-emitted turn_context, T4.5) has 3 turns total; the trailing assistant turn carries the post-compaction token_count's usage — no orphan-token-count warning", async () => {
    const all = await refs();
    const { session, warnings } = await parseCodexSession(
      findRef(all, "compaction")
    );
    expect(session.turns).toHaveLength(3);
    const trailingTurn = session.turns.at(2);
    assert(trailingTurn);
    expect(trailingTurn.role).toBe("assistant");
    expect(trailingTurn.usage.inputUncached).toBe(22_600); // 26800 - 4200
    expect(trailingTurn.usage.cacheRead).toBe(4200);
    expect(trailingTurn?.contextTotal).toBe(26_800);
    expect(
      warnings.filter((w) => w.code === "orphan-token-count")
    ).toHaveLength(0);
  });

  it("cumulative cross-check still fails across the compaction boundary (codex's cumulative counter resets post-compaction — a real, expected discontinuity) -> token-count-mismatch warning", async () => {
    const all = await refs();
    const { warnings } = await parseCodexSession(findRef(all, "compaction"));
    expect(
      warnings.filter((w) => w.code === "token-count-mismatch")
    ).toHaveLength(1);
  });

  it(
    "engine finalizeCompactions DOES recover tokensAfterExact/shrinkExact on this fixture now: the " +
      "trailing post-compaction assistant turn (added T4.5) carries contextTotal 26800, so the " +
      "engine's turn-walk from turnIndex finds it — tokensAfterExact fills null->26800 and " +
      "shrinkExact/discardedEst compute from it, demonstrating the full finalize path on real " +
      "parsed output (not just a synthetic turns array).",
    async () => {
      const all = await refs();
      const { session } = await parseCodexSession(findRef(all, "compaction"));
      const finalized = finalizeCompactions(session);
      const event = finalized.events.find(isCompactionEvent) as CompactionEvent;
      expect(event.tokensBeforeExact).toBe(214_300);
      expect(event.tokensAfterExact).toBe(26_800);
      expect(event.shrinkExact).toBe(214_300 - 26_800);
      expect(event.discardedEst).toBe(
        214_300 - 26_800 + event.summaryTokensEst
      );
    }
  );

  it(
    "finalizeCompactions DOES recover tokensAfterExact/shrinkExact when a real-usage turn " +
      "follows the marker (synthetic turns array, exercising engine/compaction.ts's normal " +
      "case directly/in isolation, independent of this fixture's own trailing turn above)",
    async () => {
      const all = await refs();
      const { session } = await parseCodexSession(findRef(all, "compaction"));
      const preCompactionOnly = {
        ...session,
        turns: session.turns.slice(0, 2),
      };
      const trailingAssistantTurn = {
        ...(session.turns[1] as (typeof session.turns)[number]),
        contextTotal: 26_800,
        usage: {
          ...(session.turns[1] as (typeof session.turns)[number]).usage,
          output: 4100,
        },
      };
      const withTrailingTurn = {
        ...preCompactionOnly,
        turns: [...preCompactionOnly.turns, trailingAssistantTurn],
      };
      const finalized = finalizeCompactions(withTrailingTurn);
      const event = finalized.events.find(isCompactionEvent) as CompactionEvent;
      expect(event.tokensBeforeExact).toBe(214_300);
      expect(event.tokensAfterExact).toBe(26_800);
      expect(event.shrinkExact).toBe(214_300 - 26_800);
    }
  );
});

describe("event_msg unknown-variant tolerance — v0.134/unknown-variant.jsonl", () => {
  it("exactly 1 unknown-event-msg warning for the unrecognized agent_status_update variant", async () => {
    const all = await refs();
    const { warnings } = await parseCodexSession(
      findRef(all, "unknown-variant")
    );
    const eventMsgWarnings = warnings.filter(
      (w) => w.code === "unknown-event-msg"
    );
    expect(eventMsgWarnings).toHaveLength(1);
    expect(eventMsgWarnings[0]?.recordType).toBe("event_msg");
  });
});

// docs/PERF.md fix #1 — spans:false lite parse (list's pipeline). usage/
// contextTotal/CompactionEvents are computed independently of contentSpans
// (token_count/compacted records, not response_item text), so they must come
// out identical; only contentSpans should go empty.
describe("parseCodexSession — spans:false lite parse", () => {
  it("full-turn.jsonl: contentSpans empty, usage/contextTotal identical to spans:true", async () => {
    const all = await refs();
    const ref = findRef(all, "full-turn");
    const [full, lite] = await Promise.all([
      parseCodexSession(ref),
      parseCodexSession(ref, { spans: false }),
    ]);

    expect(full.session.turns.some((t) => t.contentSpans.length > 0)).toBe(
      true
    );
    expect(lite.session.turns).toHaveLength(full.session.turns.length);
    for (const turn of lite.session.turns) {
      expect(turn.contentSpans).toEqual([]);
    }

    lite.session.turns.forEach((liteTurn, i) => {
      const fullTurn = full.session.turns[i];
      expect(liteTurn.usage.inputUncached).toBe(fullTurn?.usage.inputUncached);
      expect(liteTurn.usage.cacheRead).toBe(fullTurn?.usage.cacheRead);
      expect(liteTurn.usage.output).toBe(fullTurn?.usage.output);
      expect(liteTurn.contextTotal).toBe(fullTurn?.contextTotal);
      expect(liteTurn.cost).toEqual(fullTurn?.cost);
    });
  });

  it("compaction.jsonl: CompactionEvents identical, contentSpans empty", async () => {
    const all = await refs();
    const ref = findRef(all, "compaction");
    const [full, lite] = await Promise.all([
      parseCodexSession(ref),
      parseCodexSession(ref, { spans: false }),
    ]);

    for (const turn of lite.session.turns) {
      expect(turn.contentSpans).toEqual([]);
    }

    const fullCompactions = full.session.events.filter(isCompactionEvent);
    const liteCompactions = lite.session.events.filter(isCompactionEvent);
    expect(fullCompactions.length).toBeGreaterThan(0);
    expect(liteCompactions).toEqual(fullCompactions);
  });
});
