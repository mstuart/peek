import { describe, expect, it } from "vitest";
import {
  contextTotal,
  normalizeClaudeUsage,
  normalizeCodexUsage,
  normalizePiUsage,
} from "../../src/model/normalize.js";
import type { NormalizedUsage } from "../../src/model/types.js";

describe("normalizeClaudeUsage", () => {
  it("splits cache_creation by TTL when the sub-object is present", () => {
    const usage = normalizeClaudeUsage({
      cache_creation: {
        ephemeral_1h_input_tokens: 600,
        ephemeral_5m_input_tokens: 300,
      },
      cache_creation_input_tokens: 900,
      cache_read_input_tokens: 200,
      input_tokens: 100,
      output_tokens: 50,
    });

    expect(usage).toMatchObject({
      cacheRead: 200,
      cacheWrite1h: 600,
      cacheWrite5m: 300,
      inputUncached: 100,
      output: 50,
    });
  });

  it("treats all cache_creation_input_tokens as 5m when the sub-object is absent", () => {
    const usage = normalizeClaudeUsage({
      cache_creation_input_tokens: 900,
      cache_read_input_tokens: 200,
      input_tokens: 100,
      output_tokens: 50,
    });

    expect(usage).toMatchObject({
      cacheRead: 200,
      cacheWrite1h: 0,
      cacheWrite5m: 900,
      inputUncached: 100,
      output: 50,
    });
  });

  it("defaults missing/null numeric fields to 0, never NaN", () => {
    const usage = normalizeClaudeUsage({});
    expect(usage).toMatchObject({
      cacheRead: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      inputUncached: 0,
      output: 0,
    });
    for (const value of Object.values(usage)) {
      if (typeof value === "number") {
        expect(Number.isNaN(value)).toBe(false);
      }
    }
  });

  it("preserves raw verbatim", () => {
    const raw = { input_tokens: 1, weird_future_field: "x" };
    expect(normalizeClaudeUsage(raw).raw).toBe(raw);
  });
});

describe("normalizeCodexUsage", () => {
  // DESIGN.md feature-table footnote: real ground-truth capture, codex-cli 0.134.0.
  // total 37481 = input 37476 + output 5; cached_input 1408 is a SUBSET of input.
  it("matches the measured real-capture example (subset semantics)", () => {
    const usage = normalizeCodexUsage({
      cached_input_tokens: 1408,
      input_tokens: 37_476,
      output_tokens: 5,
    });

    expect(usage.inputUncached).toBe(36_068);
    expect(usage.cacheRead).toBe(1408);
    expect(contextTotal(usage)).toBe(37_476);
  });

  it("defaults cache_write_input_tokens to 0 when absent", () => {
    const usage = normalizeCodexUsage({
      cached_input_tokens: 1408,
      input_tokens: 37_476,
      output_tokens: 5,
    });

    expect(usage.cacheWrite5m).toBe(0);
    expect(usage.cacheWrite1h).toBe(0);
  });

  it("maps reasoning_output_tokens to reasoningOutput", () => {
    const usage = normalizeCodexUsage({
      cached_input_tokens: 0,
      input_tokens: 10,
      output_tokens: 5,
      reasoning_output_tokens: 3,
    });

    expect(usage.reasoningOutput).toBe(3);
  });

  it("defaults missing/null numeric fields to 0, never NaN", () => {
    const usage = normalizeCodexUsage({});
    expect(usage).toMatchObject({
      cacheRead: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      inputUncached: 0,
      output: 0,
    });
    expect(usage.reasoningOutput).toBeUndefined();
  });
});

describe("normalizePiUsage", () => {
  it("splits cacheWrite by cacheWrite1h when present", () => {
    const usage = normalizePiUsage({
      cacheRead: 50,
      cacheWrite: 900,
      cacheWrite1h: 600,
      input: 100,
      output: 20,
      reasoning: 10,
    });

    expect(usage).toMatchObject({
      cacheRead: 50,
      cacheWrite1h: 600,
      cacheWrite5m: 300,
      inputUncached: 100,
      output: 20,
      reasoningOutput: 10,
    });
  });

  it("treats all cacheWrite as 5m when cacheWrite1h is absent", () => {
    const usage = normalizePiUsage({
      cacheRead: 50,
      cacheWrite: 900,
      input: 100,
      output: 20,
    });

    expect(usage).toMatchObject({
      cacheRead: 50,
      cacheWrite1h: 0,
      cacheWrite5m: 900,
      inputUncached: 100,
      output: 20,
    });
    expect(usage.reasoningOutput).toBeUndefined();
  });

  it("defaults missing/null numeric fields to 0, never NaN", () => {
    const usage = normalizePiUsage({});
    expect(usage).toMatchObject({
      cacheRead: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      inputUncached: 0,
      output: 0,
    });
  });
});

describe("contextTotal", () => {
  it("is always the sum of the four context-contributing fields", () => {
    const cases: NormalizedUsage[] = [
      {
        cacheRead: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        inputUncached: 0,
        output: 0,
        raw: null,
      },
      {
        cacheRead: 1408,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        inputUncached: 36_068,
        output: 5,
        raw: null,
      },
      {
        cacheRead: 34,
        cacheWrite1h: 78,
        cacheWrite5m: 56,
        inputUncached: 12,
        output: 90,
        raw: null,
      },
      {
        cacheRead: 0,
        cacheWrite1h: 999,
        cacheWrite5m: 0,
        inputUncached: 1,
        output: 0,
        raw: null,
      },
      {
        cacheRead: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 3,
        inputUncached: 7,
        output: 1,
        raw: null,
        reasoningOutput: 42,
      },
    ];

    for (const usage of cases) {
      expect(contextTotal(usage)).toBe(
        usage.inputUncached +
          usage.cacheRead +
          usage.cacheWrite5m +
          usage.cacheWrite1h
      );
    }
  });
});
