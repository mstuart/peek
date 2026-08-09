// DESIGN.md accounting rule 4's models.dev fallback tier — pricing/modelsDev.ts (mapping +
// cached-snapshot consult) and pricing/refresh.ts (the opt-in network write path). No network
// in any test here: fetchModelsDevPricing takes an injectable fetchImpl, and the cache-consult
// tests write fixture files directly under a tmp dir.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

// ---------------------------------------------------------------------------
// mapModelsDevPayload — pure, no network. A small inline sample shaped like the real
// models.dev api.json (verified against a live fetch on 2026-08-08 — see modelsDev.ts header).
// ---------------------------------------------------------------------------

const SAMPLE_PAYLOAD = {
  anthropic: {
    id: "anthropic",
    models: {
      "claude-test-model": {
        id: "claude-test-model",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
    },
  },
  openai: {
    id: "openai",
    models: {
      "gpt-test-model": {
        id: "gpt-test-model",
        // No cache_write field — OpenAI-family models carry none, matches lookup.ts convention.
        cost: { input: 1.25, output: 10, cache_read: 0.125 },
      },
    },
  },
  google: {
    id: "google",
    models: {
      "gemini-test-model": {
        id: "gemini-test-model",
        cost: {
          input: 1.25,
          output: 10,
          cache_read: 0.125,
          context_over_200k: { input: 2.5, output: 15, cache_read: 0.25 },
        },
      },
    },
  },
  "some-gateway": {
    id: "some-gateway",
    models: {
      // Collides with anthropic's canonical entry at wildly different (reseller) pricing —
      // canonical priority must win.
      "claude-test-model": {
        id: "claude-test-model",
        cost: { input: 999, output: 999 },
      },
      // Missing "output" — not a priced chat model (e.g. embedding-only), must be excluded.
      "embedding-only-model": {
        id: "embedding-only-model",
        cost: { input: 0.02 },
      },
      // Not listed under any canonical provider — still included (last-resort fallback).
      "gateway-only-model": {
        id: "gateway-only-model",
        cost: { input: 0.1, output: 0.5 },
      },
    },
  },
};

describe("mapModelsDevPayload", () => {
  const models = mapModelsDevPayload(SAMPLE_PAYLOAD);

  it("converts USD-per-million-tokens to USD-per-token", () => {
    expect(models["gpt-test-model"]?.input).toBeCloseTo(1.25e-6);
    expect(models["gpt-test-model"]?.output).toBeCloseTo(1e-5);
    expect(models["gpt-test-model"]?.cacheRead).toBeCloseTo(1.25e-7);
  });

  it("prefers the canonical provider over a reseller on collision", () => {
    // anthropic's price (5/25), not some-gateway's reseller markup (999/999).
    expect(models["claude-test-model"]?.input).toBeCloseTo(5e-6);
    expect(models["claude-test-model"]?.output).toBeCloseTo(2.5e-5);
  });

  it("leaves cacheCreation5m null when cache_write is absent", () => {
    expect(models["gpt-test-model"]?.cacheCreation5m).toBeNull();
  });

  it("always leaves cacheCreation1h null (models.dev has no 1h-TTL field)", () => {
    expect(models["claude-test-model"]?.cacheCreation1h).toBeNull();
    expect(models["gpt-test-model"]?.cacheCreation1h).toBeNull();
  });

  it("maps context_over_200k into the same tiering shape lookup.ts uses", () => {
    const tiering = models["gemini-test-model"]?.tiering;
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
    expect(models["gateway-only-model"]?.input).toBeCloseTo(1e-7);
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
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => SAMPLE_PAYLOAD,
    });
    const snapshot = await fetchModelsDevPricing({ fetchImpl });
    expect(snapshot.models["gpt-test-model"]?.input).toBeCloseTo(1.25e-6);
    expect(new Date(snapshot.fetchedAt).getTime()).not.toBeNaN();
  });

  it("throws a clear error on a non-2xx response", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({}),
    });
    await expect(fetchModelsDevPricing({ fetchImpl })).rejects.toThrow(/503/);
  });

  it("throws a clear error when the request itself fails", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("network down");
    };
    await expect(fetchModelsDevPricing({ fetchImpl })).rejects.toThrow(
      /network down/,
    );
  });
});

// ---------------------------------------------------------------------------
// loadCachedModelsDevSnapshot / lookupWithFallback — the offline consult path.
// ---------------------------------------------------------------------------

describe("loadCachedModelsDevSnapshot + lookupWithFallback", () => {
  function writeSnapshotFile(
    path: string,
    overrides: { fetchedAt?: string; models?: Record<string, unknown> } = {},
  ): void {
    writeFileSync(
      path,
      JSON.stringify({
        fetchedAt: overrides.fetchedAt ?? new Date().toISOString(),
        models: overrides.models ?? {
          "fallback-only-model": {
            input: 1e-6,
            output: 2e-6,
            cacheRead: null,
            cacheCreation5m: null,
            cacheCreation1h: null,
            tiering: null,
          },
        },
      }),
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
      Date.now() - 31 * 24 * 60 * 60 * 1000,
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
      lookupWithFallback("anything", { modelsDevSnapshot: null }),
    ).toBeNull();
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

  function makeTurn(model: string): Turn {
    const usage: NormalizedUsage = {
      inputUncached: 1000,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 500,
      raw: undefined,
    };
    return {
      role: "assistant",
      model,
      timestamp: new Date(0),
      contentSpans: [],
      usage,
      contextTotal: 1000,
      composition: zeroComposition(),
      cost: zeroPlaceholderCost(),
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
            input: 2e-6,
            output: 4e-6,
            cacheRead: null,
            cacheCreation5m: null,
            cacheCreation1h: null,
            tiering: null,
          },
        },
      }),
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
    const bigPayload: Record<string, unknown> = {
      anthropic: SAMPLE_PAYLOAD.anthropic,
    };
    // Pad past the 100-model floor with synthetic priced entries under a throwaway provider.
    const padded: Record<
      string,
      { id: string; cost: { input: number; output: number } }
    > = {};
    for (let i = 0; i < 150; i++) {
      padded[`synthetic-model-${i}`] = {
        id: `synthetic-model-${i}`,
        cost: { input: 1, output: 2 },
      };
    }
    bigPayload.padding = { id: "padding", models: padded };

    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => bigPayload,
    });

    const result = await refreshPricingSnapshot({
      fetchImpl,
      cachePathOverride: cachePath,
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
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ anthropic: SAMPLE_PAYLOAD.anthropic }), // only 1 priced model
    });

    await expect(
      refreshPricingSnapshot({ fetchImpl, cachePathOverride: cachePath }),
    ).rejects.toThrow(/only 1 priced model/);
    expect(existsSync(cachePath)).toBe(false);
  });
});
