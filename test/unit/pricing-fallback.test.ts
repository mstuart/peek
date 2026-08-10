// DESIGN.md accounting rule 4's models.dev fallback tier — pricing/modelsDev.ts (mapping +
// cached-snapshot consult) and pricing/refresh.ts (the opt-in network write path). No network
// in any test here: fetchModelsDevPricing takes an injectable fetchImpl, and the cache-consult
// tests write fixture files directly under a tmp dir.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import { priceTurn } from "../../src/engine/accounting.js";
import type {
  Composition,
  CostBreakdown,
  NormalizedUsage,
  Turn,
} from "../../src/model/types.js";
import type { FetchLike } from "../../src/pricing/modelsDev.js";
import {
  fetchModelsDevPricing,
  loadCachedModelsDevSnapshot,
  lookupWithFallback,
  mapModelsDevPayload,
} from "../../src/pricing/modelsDev.js";
import { refreshPricingSnapshot } from "../../src/pricing/refresh.js";

const TEST_PATTERN_1 = /503/;
const TEST_PATTERN_2 = /network down/;
const TEST_PATTERN_3 = /only 1 priced model/;

// ---------------------------------------------------------------------------
// mapModelsDevPayload — pure, no network. A small inline sample shaped like the real
// models.dev api.json (verified against a live fetch on 2026-08-08 — see modelsDev.ts header).
// ---------------------------------------------------------------------------

const SAMPLE_PAYLOAD = {
  anthropic: {
    id: "anthropic",
    models: {
      "claude-test-model": {
        cost: { cache_read: 0.5, cache_write: 6.25, input: 5, output: 25 },
        id: "claude-test-model",
      },
    },
  },
  google: {
    id: "google",
    models: {
      "gemini-test-model": {
        cost: {
          cache_read: 0.125,
          context_over_200k: { cache_read: 0.25, input: 2.5, output: 15 },
          input: 1.25,
          output: 10,
        },
        id: "gemini-test-model",
      },
    },
  },
  openai: {
    id: "openai",
    models: {
      "gpt-test-model": {
        // No cache_write field — OpenAI-family models carry none, matches lookup.ts convention.
        cost: { cache_read: 0.125, input: 1.25, output: 10 },
        id: "gpt-test-model",
      },
    },
  },
  "some-gateway": {
    id: "some-gateway",
    models: {
      // Collides with anthropic's canonical entry at wildly different (reseller) pricing —
      // canonical priority must win.
      "claude-test-model": {
        cost: { input: 999, output: 999 },
        id: "claude-test-model",
      },
      // Missing "output" — not a priced chat model (e.g. embedding-only), must be excluded.
      "embedding-only-model": {
        cost: { input: 0.02 },
        id: "embedding-only-model",
      },
      // Not listed under any canonical provider — still included (last-resort fallback).
      "gateway-only-model": {
        cost: { input: 0.1, output: 0.5 },
        id: "gateway-only-model",
      },
    },
  },
};

/** A payload past the MIN_EXPECTED_MODELS floor — shared by refreshPricingSnapshot
 * tests that need a valid (non-rejected) fetch response. */
function makeValidBigPayload(): Record<string, unknown> {
  const padded: Record<
    string,
    { id: string; cost: { input: number; output: number } }
  > = {};
  for (let i = 0; i < 150; i += 1) {
    padded[`synthetic-model-${i}`] = {
      cost: { input: 1, output: 2 },
      id: `synthetic-model-${i}`,
    };
  }
  return {
    anthropic: SAMPLE_PAYLOAD.anthropic,
    padding: { id: "padding", models: padded },
  };
}

describe("mapModelsDevPayload", () => {
  const models = mapModelsDevPayload(SAMPLE_PAYLOAD);
  const model = (id: string) => {
    const price = models[id];
    assert(price);
    return price;
  };

  it("converts USD-per-million-tokens to USD-per-token", () => {
    expect(model("gpt-test-model").input).toBeCloseTo(1.25e-6);
    expect(model("gpt-test-model").output).toBeCloseTo(1e-5);
    expect(model("gpt-test-model").cacheRead).toBeCloseTo(1.25e-7);
  });

  it("prefers the canonical provider over a reseller on collision", () => {
    // anthropic's price (5/25), not some-gateway's reseller markup (999/999).
    expect(model("claude-test-model").input).toBeCloseTo(5e-6);
    expect(model("claude-test-model").output).toBeCloseTo(2.5e-5);
  });

  it("leaves cacheCreation5m null when cache_write is absent", () => {
    expect(model("gpt-test-model").cacheCreation5m).toBeNull();
  });

  it("always leaves cacheCreation1h null (models.dev has no 1h-TTL field)", () => {
    expect(model("claude-test-model").cacheCreation1h).toBeNull();
    expect(model("gpt-test-model").cacheCreation1h).toBeNull();
  });

  it("maps context_over_200k into the same tiering shape lookup.ts uses", () => {
    const { tiering } = model("gemini-test-model");
    expect(tiering).not.toBeNull();
    expect(tiering?.thresholdTokens).toBe(200_000);
    expect(tiering?.input).toBeCloseTo(2.5e-6);
    expect(tiering?.output).toBeCloseTo(1.5e-5);
    expect(tiering?.cacheRead).toBeCloseTo(2.5e-7);
  });

  it("excludes entries missing input or output", () => {
    expect(models["embedding-only-model"]).toBeUndefined();
  });

  it("includes non-canonical-only models as a last resort", () => {
    expect(model("gateway-only-model").input).toBeCloseTo(1e-7);
  });

  it("returns an empty map for a non-object root", () => {
    expect(mapModelsDevPayload(null)).toEqual({});
    expect(mapModelsDevPayload("garbage")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// fetchModelsDevPricing — injectable fetchImpl, no real network.
// ---------------------------------------------------------------------------

describe("fetchModelsDevPricing", () => {
  it("maps a successful response", async () => {
    const fetchImpl: FetchLike = async () => ({
      json: async () => SAMPLE_PAYLOAD,
      ok: true,
      status: 200,
      statusText: "OK",
    });
    const snapshot = await fetchModelsDevPricing({ fetchImpl });
    const fetchedModel = snapshot.models["gpt-test-model"];
    assert(fetchedModel);
    expect(fetchedModel.input).toBeCloseTo(1.25e-6);
    expect(new Date(snapshot.fetchedAt).getTime()).not.toBeNaN();
  });

  it("throws a clear error on a non-2xx response", async () => {
    const fetchImpl: FetchLike = async () => ({
      json: async () => ({}),
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });
    await expect(fetchModelsDevPricing({ fetchImpl })).rejects.toThrow(
      TEST_PATTERN_1
    );
  });

  it("throws a clear error when the request itself fails", async () => {
    const fetchImpl: FetchLike = () =>
      Promise.reject(new Error("network down"));
    await expect(fetchModelsDevPricing({ fetchImpl })).rejects.toThrow(
      TEST_PATTERN_2
    );
  });
});

// ---------------------------------------------------------------------------
// loadCachedModelsDevSnapshot / lookupWithFallback — the offline consult path.
// ---------------------------------------------------------------------------

describe("loadCachedModelsDevSnapshot + lookupWithFallback", () => {
  function writeSnapshotFile(
    path: string,
    overrides: { fetchedAt?: string; models?: Record<string, unknown> } = {}
  ): void {
    writeFileSync(
      path,
      JSON.stringify({
        fetchedAt: overrides.fetchedAt ?? new Date().toISOString(),
        models: overrides.models ?? {
          "fallback-only-model": {
            cacheCreation1h: null,
            cacheCreation5m: null,
            cacheRead: null,
            input: 1e-6,
            output: 2e-6,
            tiering: null,
          },
        },
      })
    );
  }

  it("resolves a model present only in a fresh cached snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "peek-modelsdev-hit-"));
    const cachePath = join(dir, "models-dev.json");
    writeSnapshotFile(cachePath);

    const snapshot = loadCachedModelsDevSnapshot(cachePath);
    expect(snapshot).not.toBeNull();
    const price = lookupWithFallback("fallback-only-model", {
      modelsDevSnapshot: snapshot,
    });
    expect(price?.input).toBeCloseTo(1e-6);
  });

  it("returns null for a missing cache file", () => {
    const dir = mkdtempSync(join(tmpdir(), "peek-modelsdev-missing-"));
    const cachePath = join(dir, "does-not-exist.json");
    expect(loadCachedModelsDevSnapshot(cachePath)).toBeNull();
  });

  it("ignores a stale (>30 days old) cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "peek-modelsdev-stale-"));
    const cachePath = join(dir, "models-dev.json");
    const staleDate = new Date(
      Date.now() - 31 * 24 * 60 * 60 * 1000
    ).toISOString();
    writeSnapshotFile(cachePath, { fetchedAt: staleDate });

    expect(loadCachedModelsDevSnapshot(cachePath)).toBeNull();
  });

  it("ignores a corrupt cache file", () => {
    const dir = mkdtempSync(join(tmpdir(), "peek-modelsdev-corrupt-"));
    const cachePath = join(dir, "models-dev.json");
    writeFileSync(cachePath, "{ not valid json");

    expect(loadCachedModelsDevSnapshot(cachePath)).toBeNull();
  });

  it("lookupWithFallback misses when the snapshot is null", () => {
    expect(
      lookupWithFallback("anything", { modelsDevSnapshot: null })
    ).toBeNull();
  });

  it("tightens a pre-existing loosely-permissioned snapshot file/dir on load", () => {
    const dir = mkdtempSync(join(tmpdir(), "peek-modelsdev-perms-"));
    const cachePath = join(dir, "models-dev.json");
    writeSnapshotFile(cachePath);
    chmodSync(dir, 0o755);
    chmodSync(cachePath, 0o644);

    expect(loadCachedModelsDevSnapshot(cachePath)).not.toBeNull();

    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission checks require a mode-bit mask.
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission checks require a mode-bit mask.
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
  });

  it("drops a poisoned model leaf (non-numeric input) but keeps other valid entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "peek-modelsdev-poison-"));
    const cachePath = join(dir, "models-dev.json");
    writeSnapshotFile(cachePath, {
      models: {
        "healthy-model": {
          cacheCreation1h: null,
          cacheCreation5m: null,
          cacheRead: null,
          input: 1e-6,
          output: 2e-6,
          tiering: null,
        },
        "poisoned-model": {
          cacheCreation1h: null,
          cacheCreation5m: null,
          cacheRead: null,
          input: "not-a-number",
          output: 2e-6,
          tiering: null,
        },
      },
    });

    const snapshot = loadCachedModelsDevSnapshot(cachePath);
    expect(snapshot).not.toBeNull();
    expect(
      lookupWithFallback("poisoned-model", { modelsDevSnapshot: snapshot })
    ).toBeNull();
    expect(
      lookupWithFallback("healthy-model", { modelsDevSnapshot: snapshot })
    ).not.toBeNull();
  });

  it.each([
    ["NaN via non-numeric input", { input: "NaN", output: 2e-6 }],
    ["negative input", { input: -1e-6, output: 2e-6 }],
    [
      "negative nullable cacheRead",
      { cacheRead: -1, input: 1e-6, output: 2e-6 },
    ],
    [
      "malformed tiering",
      {
        input: 1e-6,
        output: 2e-6,
        tiering: { input: -1, thresholdTokens: 200_000 },
      },
    ],
  ])("drops a model leaf with %s", (_label, badFields) => {
    const dir = mkdtempSync(join(tmpdir(), "peek-modelsdev-poison2-"));
    const cachePath = join(dir, "models-dev.json");
    writeSnapshotFile(cachePath, {
      models: {
        "bad-model": {
          cacheCreation1h: null,
          cacheCreation5m: null,
          cacheRead: null,
          tiering: null,
          ...badFields,
        },
      },
    });

    const snapshot = loadCachedModelsDevSnapshot(cachePath);
    expect(snapshot).not.toBeNull();
    expect(
      lookupWithFallback("bad-model", { modelsDevSnapshot: snapshot })
    ).toBeNull();
  });

  it("drops a model leaf whose input overflows to Infinity when the raw JSON is parsed", () => {
    // JSON.stringify(Infinity) serializes to `null`, so this scenario (a disk-level numeral
    // large enough to overflow float64 on parse, e.g. from a hand-edited cache file) has to be
    // written as raw JSON text rather than built from a JS Infinity literal.
    const dir = mkdtempSync(join(tmpdir(), "peek-modelsdev-poison-inf-"));
    const cachePath = join(dir, "models-dev.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        models: { "bad-model": { input: 0, output: 2e-6 } },
      }).replace('"input":0', '"input":1e400')
    );

    const snapshot = loadCachedModelsDevSnapshot(cachePath);
    expect(snapshot).not.toBeNull();
    expect(
      lookupWithFallback("bad-model", { modelsDevSnapshot: snapshot })
    ).toBeNull();
  });

  it("priceTurn never returns priced:true with a non-finite cost for a poisoned cache entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "peek-modelsdev-poison-priceturn-"));
    process.env.XDG_CACHE_HOME = dir;
    mkdirSync(join(dir, "peek"), { recursive: true });
    writeFileSync(
      join(dir, "peek", "models-dev.json"),
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        models: {
          "poisoned-repro-model": {
            cacheCreation1h: null,
            cacheCreation5m: null,
            cacheRead: null,
            input: "not-a-number",
            output: 2e-6,
            tiering: null,
          },
        },
      })
    );

    const usage: NormalizedUsage = {
      cacheRead: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      inputUncached: 1000,
      output: 500,
      raw: undefined,
    };
    const turn: Turn = {
      composition: {
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
      },
      contentSpans: [],
      contextTotal: 1000,
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
      model: "poisoned-repro-model",
      role: "assistant",
      timestamp: new Date(0),
      usage,
    };

    const cost = priceTurn(turn, { mode: "calculate" });
    // The poisoned entry was dropped at the cache-validation layer, so this degrades to an
    // honest unpriced zero — never priced:true with a NaN total.
    expect(cost.priced).toBe(false);
    expect(cost.total).toBe(0);
    expect(Number.isNaN(cost.total)).toBe(false);

    Reflect.deleteProperty(process.env, "XDG_CACHE_HOME");
  });
});

// ---------------------------------------------------------------------------
// priceTurn wired to the cache — engine/accounting.ts's resolveModelPrice.
// LiteLLM miss + models.dev cache hit -> priced; both miss -> priced:false unchanged.
// ---------------------------------------------------------------------------

describe("priceTurn consults the cached models.dev fallback", () => {
  let originalXdgCacheHome: string | undefined;

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

  function zeroPlaceholderCost(): CostBreakdown {
    return {
      cacheRead: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      input: 0,
      mode: "auto",
      output: 0,
      priced: false,
      total: 0,
    };
  }

  function makeTurn(model: string): Turn {
    const usage: NormalizedUsage = {
      cacheRead: 0,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      inputUncached: 1000,
      output: 500,
      raw: undefined,
    };
    return {
      composition: zeroComposition(),
      contentSpans: [],
      contextTotal: 1000,
      cost: zeroPlaceholderCost(),
      model,
      role: "assistant",
      timestamp: new Date(0),
      usage,
    };
  }

  beforeEach(() => {
    originalXdgCacheHome = process.env.XDG_CACHE_HOME;
  });

  afterEach(() => {
    if (originalXdgCacheHome === undefined) {
      Reflect.deleteProperty(process.env, "XDG_CACHE_HOME");
    } else {
      process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    }
  });

  it("prices via the cached models.dev fallback when the LiteLLM snapshot misses", () => {
    const dir = mkdtempSync(join(tmpdir(), "peek-xdg-hit-"));
    process.env.XDG_CACHE_HOME = dir;
    mkdirSync(join(dir, "peek"), { recursive: true });
    writeFileSync(
      join(dir, "peek", "models-dev.json"),
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        models: {
          "totally-unknown-model-id-xyz": {
            cacheCreation1h: null,
            cacheCreation5m: null,
            cacheRead: null,
            input: 2e-6,
            output: 4e-6,
            tiering: null,
          },
        },
      })
    );

    const turn = makeTurn("totally-unknown-model-id-xyz");
    const cost = priceTurn(turn, { mode: "calculate" });
    expect(cost.priced).toBe(true);
    expect(cost.input).toBeCloseTo(1000 * 2e-6);
    expect(cost.output).toBeCloseTo(500 * 4e-6);
  });

  it("leaves priced:false unchanged when both tiers miss", () => {
    const dir = mkdtempSync(join(tmpdir(), "peek-xdg-miss-"));
    process.env.XDG_CACHE_HOME = dir; // no models-dev.json written — cache miss too

    const turn = makeTurn("totally-unknown-model-id-xyz-2");
    const cost = priceTurn(turn, { mode: "calculate" });
    expect(cost.priced).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// refreshPricingSnapshot — injectable fetchImpl, writes atomically, validates first.
// ---------------------------------------------------------------------------

describe("refreshPricingSnapshot", () => {
  it("writes the cache file and reports counts on a valid payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peek-refresh-ok-"));
    const cachePath = join(dir, "models-dev.json");
    const bigPayload = makeValidBigPayload();

    const fetchImpl: FetchLike = async () => ({
      json: async () => bigPayload,
      ok: true,
      status: 200,
      statusText: "OK",
    });

    const result = await refreshPricingSnapshot({
      cachePathOverride: cachePath,
      fetchImpl,
    });

    expect(result.modelCount).toBeGreaterThan(100);
    expect(existsSync(cachePath)).toBe(true);
    const written = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(Object.keys(written.models).length).toBe(result.modelCount);
  });

  it("rejects a tiny/invalid payload without writing a cache file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peek-refresh-tiny-"));
    const cachePath = join(dir, "models-dev.json");
    const fetchImpl: FetchLike = async () => ({
      json: async () => ({ anthropic: SAMPLE_PAYLOAD.anthropic }), // only 1 priced model
      ok: true,
      status: 200,
      statusText: "OK",
    });

    await expect(
      refreshPricingSnapshot({ cachePathOverride: cachePath, fetchImpl })
    ).rejects.toThrow(TEST_PATTERN_3);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("writes the cache dir as 0700 and the cache file as 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peek-refresh-perms-"));
    const cachePath = join(dir, "nested", "models-dev.json");
    const fetchImpl: FetchLike = async () => ({
      json: async () => makeValidBigPayload(),
      ok: true,
      status: 200,
      statusText: "OK",
    });

    await refreshPricingSnapshot({ cachePathOverride: cachePath, fetchImpl });

    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission checks require a mode-bit mask.
    expect(statSync(dirname(cachePath)).mode & 0o777).toBe(0o700);
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission checks require a mode-bit mask.
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
  });
});
