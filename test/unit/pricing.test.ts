import { describe, expect, it } from "vitest";
import { lookupModelPrice } from "../../src/pricing/lookup.js";

describe("lookupModelPrice", () => {
  it("resolves claude-opus-5 with cache-price fields populated", () => {
    const price = lookupModelPrice("claude-opus-5");
    expect(price).not.toBeNull();
    expect(price?.input).toBeGreaterThan(0);
    expect(price?.output).toBeGreaterThan(0);
    expect(price?.cacheRead).toBeGreaterThan(0);
    expect(price?.cacheCreation5m).toBeGreaterThan(0);
    // Snapshot carries the 1h-TTL cache-write price for claude-opus-5.
    expect(price?.cacheCreation1h).toBeGreaterThan(0);
  });

  it("resolves a GPT-5-family model (gpt-5) with its cache-read field populated", () => {
    // GPT-5-family snapshot records carry no cache_creation_input_token_cost at all — OpenAI's
    // prompt caching has no write cost — so cacheCreation5m/cacheCreation1h are expected null
    // here, while cacheRead is populated. See src/pricing/lookup.ts header comment.
    const price = lookupModelPrice("gpt-5");
    expect(price).not.toBeNull();
    expect(price?.input).toBeGreaterThan(0);
    expect(price?.output).toBeGreaterThan(0);
    expect(price?.cacheRead).toBeGreaterThan(0);
    expect(price?.cacheCreation5m).toBeNull();
    expect(price?.cacheCreation1h).toBeNull();
  });

  it("returns null for an unknown model id", () => {
    expect(lookupModelPrice("totally-unknown-model-id-xyz")).toBeNull();
  });

  it("falls back through a provider prefix (anthropic/claude-opus-5 -> claude-opus-5)", () => {
    const direct = lookupModelPrice("claude-opus-5");
    const prefixed = lookupModelPrice("anthropic/claude-opus-5");
    expect(prefixed).not.toBeNull();
    expect(prefixed).toEqual(direct);
  });

  it("falls back through a trailing date suffix (claude-opus-5-20260101 -> claude-opus-5)", () => {
    const direct = lookupModelPrice("claude-opus-5");
    const dated = lookupModelPrice("claude-opus-5-20260101");
    expect(dated).not.toBeNull();
    expect(dated).toEqual(direct);
  });

  it("does not fuzzy-match beyond the documented prefix/date fallback", () => {
    expect(lookupModelPrice("claude-opus-5-preview-xyz")).toBeNull();
  });
});
