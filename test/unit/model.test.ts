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
      input_tokens: 100,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 900,
      cache_creation: {
        ephemeral_5m_input_tokens: 300,
        ephemeral_1h_input_tokens: 600,
      },
      output_tokens: 50,
    });

    expect(usage).toMatchObject({
      inputUncached: 100,
      cacheRead: 200,
      cacheWrite5m: 300,
      cacheWrite1h: 600,
      output: 50,
    });
  });

  it("treats all cache_creation_input_tokens as 5m when the sub-object is absent", () => {
    const usage = normalizeClaudeUsage({
      input_tokens: 100,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 900,
      output_tokens: 50,
    });

    expect(usage).toMatchObject({
      inputUncached: 100,
      cacheRead: 200,
      cacheWrite5m: 900,
      cacheWrite1h: 0,
      output: 50,
    });
  });

  it("defaults missing/null numeric fields to 0, never NaN", () => {
    const usage = normalizeClaudeUsage({});
    expect(usage).toMatchObject({
      inputUncached: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 0,
    });
    for (const value of Object.values(usage)) {
      if (typeof value === "number") expect(Number.isNaN(value)).toBe(false);
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
      input_tokens: 37476,
      cached_input_tokens: 1408,
      output_tokens: 5,
    });

    expect(usage.inputUncached).toBe(36068);
    expect(usage.cacheRead).toBe(1408);
    expect(contextTotal(usage)).toBe(37476);
  });

  it("defaults cache_write_input_tokens to 0 when absent", () => {
    const usage = normalizeCodexUsage({
      input_tokens: 37476,
      cached_input_tokens: 1408,
      output_tokens: 5,
    });

    expect(usage.cacheWrite5m).toBe(0);
    expect(usage.cacheWrite1h).toBe(0);
  });

  it("maps reasoning_output_tokens to reasoningOutput", () => {
    const usage = normalizeCodexUsage({
      input_tokens: 10,
      cached_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 3,
    });

    expect(usage.reasoningOutput).toBe(3);
  });

  it("defaults missing/null numeric fields to 0, never NaN", () => {
    const usage = normalizeCodexUsage({});
    expect(usage).toMatchObject({
      inputUncached: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 0,
    });
    expect(usage.reasoningOutput).toBeUndefined();
  });
});

describe("normalizePiUsage", () => {
  it("splits cacheWrite by cacheWrite1h when present", () => {
    const usage = normalizePiUsage({
      input: 100,
      cacheRead: 50,
      cacheWrite: 900,
      cacheWrite1h: 600,
      output: 20,
      reasoning: 10,
    });

    expect(usage).toMatchObject({
      inputUncached: 100,
      cacheRead: 50,
      cacheWrite5m: 300,
      cacheWrite1h: 600,
      output: 20,
      reasoningOutput: 10,
    });
  });

  it("treats all cacheWrite as 5m when cacheWrite1h is absent", () => {
    const usage = normalizePiUsage({
      input: 100,
      cacheRead: 50,
      cacheWrite: 900,
      output: 20,
    });

    expect(usage).toMatchObject({
      inputUncached: 100,
      cacheRead: 50,
      cacheWrite5m: 900,
      cacheWrite1h: 0,
      output: 20,
    });
    expect(usage.reasoningOutput).toBeUndefined();
  });

  it("defaults missing/null numeric fields to 0, never NaN", () => {
    const usage = normalizePiUsage({});
    expect(usage).toMatchObject({
      inputUncached: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 0,
    });
  });
});

describe("contextTotal", () => {
  it("is always the sum of the four context-contributing fields", () => {
    const cases: NormalizedUsage[] = [
      {
        inputUncached: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 0,
        raw: null,
      },
      {
        inputUncached: 36068,
        cacheRead: 1408,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 5,
        raw: null,
      },
      {
        inputUncached: 12,
        cacheRead: 34,
        cacheWrite5m: 56,
        cacheWrite1h: 78,
        output: 90,
        raw: null,
      },
      {
        inputUncached: 1,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 999,
        output: 0,
        raw: null,
      },
      {
        inputUncached: 7,
        cacheRead: 0,
        cacheWrite5m: 3,
        cacheWrite1h: 0,
        output: 1,
        reasoningOutput: 42,
        raw: null,
      },
    ];

    for (const usage of cases) {
      expect(contextTotal(usage)).toBe(
        usage.inputUncached +
          usage.cacheRead +
          usage.cacheWrite5m +
          usage.cacheWrite1h,
      );
    }
  });
});
