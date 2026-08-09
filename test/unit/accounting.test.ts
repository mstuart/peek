import { describe, expect, it } from "vitest";
import {
  calculateCost,
  priceSession,
  priceTurn,
  sessionTotals,
} from "../../src/engine/accounting.js";
import type {
  CompactionEvent,
  Composition,
  CostBreakdown,
  NormalizedUsage,
  Session,
  Turn,
} from "../../src/model/types.js";
import type { ModelPrice } from "../../src/pricing/lookup.js";

function zeroComposition(): Composition {
  return {
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
  };
}

function zeroPlaceholderCost(): CostBreakdown {
  // Mirrors adapters/claude/parse.ts's zeroCost() placeholder — mode:"auto", priced:false —
  // the state a Turn is in before T2.2 prices it.
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    total: 0,
    mode: "auto",
    priced: false,
  };
}

function makeTurn(opts: {
  raw?: unknown;
  usage?: Partial<Omit<NormalizedUsage, "raw">>;
  model?: string;
  cost?: CostBreakdown;
}): Turn {
  const usage: NormalizedUsage = {
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    ...opts.usage,
    raw: opts.raw,
  };
  return {
    role: "assistant",
    model: opts.model ?? "claude-opus-5",
    timestamp: new Date(0),
    contentSpans: [],
    usage,
    contextTotal:
      usage.inputUncached +
      usage.cacheRead +
      usage.cacheWrite5m +
      usage.cacheWrite1h,
    composition: zeroComposition(),
    cost: opts.cost ?? zeroPlaceholderCost(),
  };
}

function makeSession(turns: Turn[], events: Session["events"] = []): Session {
  return {
    harness: "claude-code",
    harnessVersion: "test",
    id: "session-1",
    cwd: "/tmp/project",
    startedAt: new Date(0),
    endedAt: new Date(0),
    configSnapshot: { model: "claude-opus-5", modelChanges: [] },
    turns,
    events,
    children: [],
    warnings: [],
  };
}

describe("calculateCost", () => {
  it("computes all five components against real claude-opus-5 snapshot prices", () => {
    // Snapshot values (litellm-2026-08-08.json, claude-opus-5): input=0.000005,
    // output=0.000025, cacheRead=5e-7, cache5m=0.00000625, cache1h=0.00001 — all present, no
    // fallback triggered. Hand-computed: 1000*0.000005=0.005, 300*0.000025=0.0075,
    // 500*5e-7=0.00025, 200*0.00000625=0.00125, 100*0.00001=0.001 -> total 0.015.
    const turn = makeTurn({
      model: "claude-opus-5",
      usage: {
        inputUncached: 1000,
        cacheRead: 500,
        cacheWrite5m: 200,
        cacheWrite1h: 100,
        output: 300,
      },
    });
    const cost = priceTurn(turn, { mode: "calculate" });
    expect(cost.priced).toBe(true);
    expect(cost.mode).toBe("calculate");
    expect(cost.input).toBeCloseTo(0.005, 10);
    expect(cost.output).toBeCloseTo(0.0075, 10);
    expect(cost.cacheRead).toBeCloseTo(0.00025, 10);
    expect(cost.cacheWrite5m).toBeCloseTo(0.00125, 10);
    expect(cost.cacheWrite1h).toBeCloseTo(0.001, 10);
    expect(cost.total).toBeCloseTo(0.015, 10);
  });

  it("hardcodes cacheWrite1h at 2x input when cacheCreation1h is absent (synthetic price)", () => {
    const price: ModelPrice = {
      input: 0.000004,
      output: 0.00002,
      cacheRead: 0.0000004,
      cacheCreation5m: 0.000005, // present -> no fallback needed for this component
      cacheCreation1h: null, // absent -> 2x-input hardcode
      tiering: null,
    };
    const turn = makeTurn({ usage: { cacheWrite5m: 50, cacheWrite1h: 100 } });
    const cost = calculateCost(turn, price, "calculate");
    expect(cost.cacheWrite5m).toBeCloseTo(50 * 0.000005, 10);
    expect(cost.cacheWrite1h).toBeCloseTo(100 * (0.000004 * 2.0), 10);
    expect(cost.total).toBeCloseTo(cost.cacheWrite5m + cost.cacheWrite1h, 10);
  });

  it("falls back cacheWrite5m to 1.25x input when cacheCreation5m is also absent", () => {
    const price: ModelPrice = {
      input: 0.000004,
      output: 0.00002,
      cacheRead: 0.0000004,
      cacheCreation5m: null,
      cacheCreation1h: null,
      tiering: null,
    };
    const turn = makeTurn({ usage: { cacheWrite5m: 10, cacheWrite1h: 10 } });
    const cost = calculateCost(turn, price, "calculate");
    expect(cost.cacheWrite5m).toBeCloseTo(10 * (0.000004 * 1.25), 10);
    expect(cost.cacheWrite1h).toBeCloseTo(10 * (0.000004 * 2.0), 10);
  });

  it("treats absent cacheRead price as zero cost (no hardcode specified)", () => {
    const price: ModelPrice = {
      input: 0.000004,
      output: 0.00002,
      cacheRead: null,
      cacheCreation5m: 0.000005,
      cacheCreation1h: 0.000008,
      tiering: null,
    };
    const turn = makeTurn({ usage: { cacheRead: 1000 } });
    const cost = calculateCost(turn, price, "calculate");
    expect(cost.cacheRead).toBe(0);
  });

  describe("long-context tiering boundary", () => {
    const syntheticTiered: ModelPrice = {
      input: 0.000004,
      output: 0.00002,
      cacheRead: 0.0000004,
      cacheCreation5m: 0.000005,
      cacheCreation1h: 0.000008,
      tiering: {
        thresholdTokens: 200_000,
        input: 0.000008,
        output: 0.00004,
        cacheRead: 0.0000008,
        cacheCreation5m: 0.00001,
        cacheCreation1h: 0.000016,
      },
    };

    it("marginal (claude*): exactly at threshold stays entirely at base rate", () => {
      const turn = makeTurn({
        model: "claude-tiered-test",
        usage: { inputUncached: 200_000, output: 1000 },
      });
      const cost = calculateCost(turn, syntheticTiered, "calculate");
      expect(cost.input).toBeCloseTo(200_000 * 0.000004, 10);
      expect(cost.output).toBeCloseTo(1000 * 0.00002, 10);
      expect(cost.total).toBeCloseTo(200_000 * 0.000004 + 1000 * 0.00002, 10);
    });

    it("marginal (claude*): one token over threshold bills only the excess at tier rate", () => {
      const turn = makeTurn({
        model: "claude-tiered-test",
        usage: { inputUncached: 200_001, output: 1000 },
      });
      const cost = calculateCost(turn, syntheticTiered, "calculate");
      const expectedInput = 200_000 * 0.000004 + 1 * 0.000008;
      const expectedOutput = 1000 * 0.00004; // output switches wholesale once over threshold
      expect(cost.input).toBeCloseTo(expectedInput, 10);
      expect(cost.output).toBeCloseTo(expectedOutput, 10);
      expect(cost.total).toBeCloseTo(expectedInput + expectedOutput, 10);
    });

    it("whole-request (gpt*/o*/codex*): exactly at threshold stays at base rate", () => {
      const turn = makeTurn({
        model: "gpt-tiered-test",
        usage: { inputUncached: 200_000, output: 1000 },
      });
      const cost = calculateCost(turn, syntheticTiered, "calculate");
      expect(cost.input).toBeCloseTo(200_000 * 0.000004, 10);
      expect(cost.output).toBeCloseTo(1000 * 0.00002, 10);
    });

    it("whole-request (gpt*/o*/codex*): one token over threshold prices the ENTIRE input at tier rate", () => {
      const turn = makeTurn({
        model: "gpt-tiered-test",
        usage: { inputUncached: 200_001, output: 1000 },
      });
      const cost = calculateCost(turn, syntheticTiered, "calculate");
      const expectedInput = 200_001 * 0.000008;
      const expectedOutput = 1000 * 0.00004;
      expect(cost.input).toBeCloseTo(expectedInput, 10);
      expect(cost.output).toBeCloseTo(expectedOutput, 10);
      expect(cost.total).toBeCloseTo(expectedInput + expectedOutput, 10);
    });

    it("marginal vs whole-request diverge once over threshold (same usage, same price table)", () => {
      const claudeTurn = makeTurn({
        model: "claude-tiered-test",
        usage: { inputUncached: 200_001, output: 1000 },
      });
      const gptTurn = makeTurn({
        model: "gpt-tiered-test",
        usage: { inputUncached: 200_001, output: 1000 },
      });
      const claudeCost = calculateCost(
        claudeTurn,
        syntheticTiered,
        "calculate",
      );
      const gptCost = calculateCost(gptTurn, syntheticTiered, "calculate");
      expect(claudeCost.total).toBeLessThan(gptCost.total);
    });

    it("never returns priced:true with a NaN/Infinity component — degrades to an honest unpriced zero (defense-in-depth backstop)", () => {
      // A hostile/corrupted ModelPrice that slipped past upstream validation (e.g. a future
      // bug in a cache/snapshot reader) must still never produce priced:true + NaN here — this
      // is the backstop the honesty invariant relies on regardless of how a bad price arrived.
      const poisonedPrice: ModelPrice = {
        input: Number.POSITIVE_INFINITY,
        output: 0.00002,
        cacheRead: 0.0000004,
        cacheCreation5m: 0.000005,
        cacheCreation1h: 0.000008,
        tiering: null,
      };
      const turn = makeTurn({ usage: { inputUncached: 1000, output: 100 } });
      const cost = calculateCost(turn, poisonedPrice, "calculate");
      expect(cost.priced).toBe(false);
      expect(cost.total).toBe(0);
      expect(Number.isNaN(cost.total)).toBe(false);
      expect(Number.isFinite(cost.total)).toBe(true);
    });

    it("catches NaN arising from 0 * Infinity in a component product", () => {
      const poisonedPrice: ModelPrice = {
        input: 0.000004,
        output: Number.POSITIVE_INFINITY,
        cacheRead: null,
        cacheCreation5m: null,
        cacheCreation1h: null,
        tiering: null,
      };
      // output usage of 0 against an Infinity rate -> NaN component.
      const turn = makeTurn({ usage: { inputUncached: 1000, output: 0 } });
      const cost = calculateCost(turn, poisonedPrice, "calculate");
      expect(cost.priced).toBe(false);
      expect(cost.total).toBe(0);
    });

    it("unrecognized provider family with tiering fields present: tiering never applied", () => {
      const turn = makeTurn({
        model: "some-other-vendor-model",
        usage: { inputUncached: 500_000, output: 1000 },
      });
      const cost = calculateCost(turn, syntheticTiered, "calculate");
      expect(cost.input).toBeCloseTo(500_000 * 0.000004, 10);
      expect(cost.output).toBeCloseTo(1000 * 0.00002, 10);
    });
  });
});

describe("priceTurn mode matrix", () => {
  it("calculate mode always computes, ignoring a costUSD raw field", () => {
    const turn = makeTurn({ model: "claude-opus-5", raw: { costUSD: 999 } });
    const cost = priceTurn(turn, { mode: "calculate" });
    expect(cost.priced).toBe(true);
    expect(cost.mode).toBe("calculate");
    expect(cost.total).toBe(0); // zero usage -> zero computed cost, not 999
  });

  it("display mode passes through claude's raw.costUSD verbatim as the total", () => {
    const turn = makeTurn({ raw: { costUSD: 0.0042 } });
    const cost = priceTurn(turn, { mode: "display" });
    expect(cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      total: 0.0042,
      mode: "display",
      priced: true,
    });
  });

  it("display mode with no precomputed cost degrades to zeros, priced:false", () => {
    const turn = makeTurn({ raw: {} });
    const cost = priceTurn(turn, { mode: "display" });
    expect(cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      total: 0,
      mode: "display",
      priced: false,
    });
  });

  it("auto mode with claude costUSD present: freshly constructed, mode tagged 'auto' (not 'display')", () => {
    const turn = makeTurn({ raw: { costUSD: 0.0042 } });
    const cost = priceTurn(turn, { mode: "auto" });
    expect(cost.total).toBe(0.0042);
    expect(cost.priced).toBe(true);
    expect(cost.mode).toBe("auto");
  });

  it("pi's display-mode cost passes through unchanged, even under an auto request", () => {
    const piCost: CostBreakdown = {
      input: 0.1,
      output: 0.2,
      cacheRead: 0.01,
      cacheWrite5m: 0.02,
      cacheWrite1h: 0,
      total: 0.33,
      mode: "display",
      priced: true,
    };
    const turn = makeTurn({ model: "some-pi-model", cost: piCost });
    const autoResult = priceTurn(turn, { mode: "auto" });
    const displayResult = priceTurn(turn, { mode: "display" });
    expect(autoResult).toBe(piCost); // same object, mode NOT overwritten to "auto"
    expect(displayResult).toBe(piCost);
  });

  it("auto mode with nothing precomputed falls through to calculate, mode tagged 'auto'", () => {
    const turn = makeTurn({
      model: "claude-opus-5",
      raw: {},
      usage: { inputUncached: 1000, output: 100 },
    });
    const cost = priceTurn(turn, { mode: "auto" });
    expect(cost.priced).toBe(true);
    expect(cost.mode).toBe("auto");
    expect(cost.total).toBeGreaterThan(0);
  });

  it("unknown model <synthetic> degrades to zeros, priced:false, mode preserved, never throws", () => {
    const turn = makeTurn({ model: "totally-unknown-model-xyz", raw: {} });
    expect(() => priceTurn(turn, { mode: "calculate" })).not.toThrow();
    const cost = priceTurn(turn, { mode: "calculate" });
    expect(cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      total: 0,
      mode: "calculate",
      priced: false,
    });

    const autoCost = priceTurn(turn, { mode: "auto" });
    expect(autoCost.priced).toBe(false);
    expect(autoCost.mode).toBe("auto");
  });
});

describe("priceSession", () => {
  it("prices every turn and leaves events untouched", () => {
    const compactionEvent: CompactionEvent = {
      kind: "compaction",
      at: new Date(0),
      turnIndex: 1,
      tokensBeforeExact: 1000,
      tokensAfterExact: 100,
      shrinkExact: 900,
      discardedEst: 900,
      summaryTokensEst: 50,
      cost: null,
    };
    const turn = makeTurn({
      model: "claude-opus-5",
      raw: {},
      usage: { inputUncached: 1000, output: 100 },
    });
    const session = makeSession([turn], [compactionEvent]);
    const priced = priceSession(session, { mode: "calculate" });

    expect(priced.turns[0]?.cost.priced).toBe(true);
    expect(priced.turns[0]?.cost.mode).toBe("calculate");
    expect(priced.events[0]).toBe(compactionEvent); // untouched, still cost:null
  });
});

describe("sessionTotals", () => {
  it("sums tokens and cost, priced:true when every turn is priced", () => {
    const turnA = makeTurn({
      usage: { inputUncached: 100, output: 10 },
      cost: {
        input: 0.001,
        output: 0.002,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        total: 0.003,
        mode: "calculate",
        priced: true,
      },
    });
    const turnB = makeTurn({
      usage: { inputUncached: 50, output: 5 },
      cost: {
        input: 0.0005,
        output: 0.001,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        total: 0.0015,
        mode: "calculate",
        priced: true,
      },
    });
    const totals = sessionTotals(makeSession([turnA, turnB]));
    expect(totals.priced).toBe(true);
    expect(totals.tokens.inputUncached).toBe(150);
    expect(totals.tokens.output).toBe(15);
    expect(totals.cost).toBeCloseTo(0.0045, 10);
  });

  it("propagates priced:false to the session total when any turn is unpriced, without dropping the partial dollar sum", () => {
    const pricedTurn = makeTurn({
      usage: { inputUncached: 100, output: 10 },
      cost: {
        input: 0.001,
        output: 0.002,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        total: 0.003,
        mode: "calculate",
        priced: true,
      },
    });
    const unpricedTurn = makeTurn({
      model: "totally-unknown-model-xyz",
      usage: { inputUncached: 999, output: 999 },
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        total: 0,
        mode: "calculate",
        priced: false,
      },
    });
    const totals = sessionTotals(makeSession([pricedTurn, unpricedTurn]));
    expect(totals.priced).toBe(false);
    expect(totals.cost).toBeCloseTo(0.003, 10); // partial sum still surfaced, not zeroed
    expect(totals.tokens.inputUncached).toBe(1099); // token sums are exact regardless of pricing
  });

  it("is trivially priced:true for a session with no turns", () => {
    const totals = sessionTotals(makeSession([]));
    expect(totals.priced).toBe(true);
    expect(totals.cost).toBe(0);
  });
});
