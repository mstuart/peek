// models.dev fallback pricing — DESIGN.md accounting rule 4's second tier:
// "vendored LiteLLM snapshot -> models.dev fallback -> 2x-input hardcode".
//
// Two jobs live here:
//   1. `fetchModelsDevPricing` / `mapModelsDevPayload` — turn models.dev's live JSON into the
//      same `ModelPrice` shape lookup.ts uses. Network-capable, called ONLY from refresh.ts's
//      opt-in `peek pricing refresh` command (standing worker rule 2: "no network in library
//      code").
//   2. `loadCachedModelsDevSnapshot` / `lookupWithFallback` — the offline consumer side. Reads
//      the snapshot refresh already wrote to disk (never fetches itself) and resolves a single
//      model id against it. This is what accounting.ts's priceTurn calls when the LiteLLM
//      snapshot misses — still zero network at price time, per PLAN's "no network in library
//      code" rule: only `peek pricing refresh` (and this module's own fetchModelsDevPricing,
//      which nothing calls implicitly) ever touch the network.
//
// ---------------------------------------------------------------------------
// models.dev JSON shape (fetched 2026-08-08, https://models.dev/api.json, ~3.6MB / 181
// providers / ~6200 model entries):
//
//   { "<providerId>": { "id": ..., "models": { "<modelId>": {
//         "id": "claude-opus-5",
//         "cost": {
//           "input": 5, "output": 25,            // USD per MILLION tokens (NOT per-token —
//           "cache_read": 0.5, "cache_write": 6.25 //  divide by 1e6 to match lookup.ts's ModelPrice)
//           "context_over_200k"?: { "input": ..., "output": ..., "cache_read"?: ..., "cache_write"?: ... }
//         }
//   } } }, ... }
//
// Verified against the vendored LiteLLM snapshot: anthropic/claude-opus-5's cost.input=5 here
// matches litellm's input_cost_per_token=5e-6 (5 / 1e6). cost.cache_write matches
// cache_creation_input_token_cost (the 5-minute-TTL price) — models.dev carries NO separate
// 1-hour-TTL cache-write field at all, so cacheCreation1h is always null out of this mapper
// (same as an absent field in the LiteLLM snapshot: accounting.ts's 2x-input hardcode covers
// it). "context_over_200k" mirrors lookup.ts's single ">200k input tokens" tiering shape and is
// mapped into the same `tiering` field — seen on canonical `google` (Gemini) entries; not
// present on every model.
//
// COLLISION POLICY: models.dev lists most models under MULTIPLE providers — not just the
// vendor, but every gateway/reseller (openrouter, azure, vercel, ...) that resells it, often at
// different markup. Picking an arbitrary provider's price would silently misprice canonical
// models (verified: e.g. "claude-sonnet-4-6" is listed first under a reseller ("daoxe") ahead of
// "anthropic" in raw JSON key order for ~90 claude/gpt/o*/codex model ids in the fetched
// payload). To avoid that, a model id found under more than one provider prefers the first
// provider matching CANONICAL_PROVIDER_PRIORITY below (the first-party vendors covering the
// same model families the vendored LiteLLM snapshot targets — lookup.ts's header pruning regex
// /claude|gpt|o[0-9]|codex|qwen|gemini/i — plus deepseek). A model listed under NONE of those
// (open-weight models with no first-party host, e.g. many "gpt-oss-*"/"deepseek-v4-*" gateway
// listings) falls back to whichever provider models.dev's JSON lists first — deterministic, but
// not guaranteed to be the cheapest or most representative price. This fallback is a last
// resort after the LiteLLM snapshot already missed, so an imprecise price on an obscure
// gateway-only model is preferable to no price at all.
// ---------------------------------------------------------------------------

import { chmodSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ModelPrice, TieredModelPrice } from "./lookup.js";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";

const CANONICAL_PROVIDER_PRIORITY: readonly string[] = [
  "anthropic",
  "openai",
  "google",
  "alibaba",
  "deepseek",
];

export interface ModelsDevSnapshot {
  fetchedAt: string; // ISO
  models: Record<string, ModelPrice>;
}

// ---------------------------------------------------------------------------
// Pure mapping — no I/O. Exercised directly by test/unit/pricing-fallback.test.ts against a
// small inline sample, no network required.
// ---------------------------------------------------------------------------

function numOrUndef(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

interface RawCost {
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
  context_over_200k?: unknown;
}

const MILLION = 1_000_000;

function toModelPrice(rawCost: RawCost): ModelPrice | null {
  const input = numOrUndef(rawCost.input);
  const output = numOrUndef(rawCost.output);
  if (input === undefined || output === undefined) {
    // Not a priced chat/completion model (e.g. embedding-only entries carry input only).
    return null;
  }

  let tiering: TieredModelPrice | null = null;
  if (
    typeof rawCost.context_over_200k === "object" &&
    rawCost.context_over_200k !== null
  ) {
    const t = rawCost.context_over_200k as RawCost;
    const tInput = numOrUndef(t.input);
    const tOutput = numOrUndef(t.output);
    const tCacheRead = numOrUndef(t.cache_read);
    const tCacheWrite = numOrUndef(t.cache_write);
    if (
      tInput !== undefined ||
      tOutput !== undefined ||
      tCacheRead !== undefined ||
      tCacheWrite !== undefined
    ) {
      tiering = {
        thresholdTokens: 200_000,
        ...(tInput !== undefined ? { input: tInput / MILLION } : {}),
        ...(tOutput !== undefined ? { output: tOutput / MILLION } : {}),
        ...(tCacheRead !== undefined
          ? { cacheRead: tCacheRead / MILLION }
          : {}),
        // models.dev's tier cache_write is the same (only) TTL as the base cache_write below —
        // mapped to cacheCreation5m, mirroring the base-rate mapping just below.
        ...(tCacheWrite !== undefined
          ? { cacheCreation5m: tCacheWrite / MILLION }
          : {}),
      };
    }
  }

  const cacheRead = numOrUndef(rawCost.cache_read);
  const cacheWrite = numOrUndef(rawCost.cache_write);

  return {
    input: input / MILLION,
    output: output / MILLION,
    cacheRead: cacheRead !== undefined ? cacheRead / MILLION : null,
    cacheCreation5m: cacheWrite !== undefined ? cacheWrite / MILLION : null,
    // models.dev carries no 1-hour-TTL cache-write field at all — see header comment.
    cacheCreation1h: null,
    tiering,
  };
}

/**
 * Maps models.dev's raw `api.json` payload (or any equivalently-shaped object, e.g. a test
 * fixture) into a flat `modelId -> ModelPrice` map, applying the collision policy documented
 * above. Tolerant of malformed/missing fields at every level — a bad provider or model entry is
 * skipped, never thrown. Returns an empty map for a non-object root.
 */
export function mapModelsDevPayload(raw: unknown): Record<string, ModelPrice> {
  const result: Record<string, ModelPrice> = {};
  if (typeof raw !== "object" || raw === null) return result;

  // Two passes: canonical providers first (in priority order), then everything else — so a
  // later canonical provider never gets clobbered by an earlier non-canonical one, and a
  // non-canonical provider never overwrites a canonical one already set.
  const providers = raw as Record<string, unknown>;
  const providerIds = Object.keys(providers);
  const orderedProviderIds = [
    ...CANONICAL_PROVIDER_PRIORITY.filter((id) => providerIds.includes(id)),
    ...providerIds.filter((id) => !CANONICAL_PROVIDER_PRIORITY.includes(id)),
  ];

  for (const providerId of orderedProviderIds) {
    const provider = providers[providerId];
    if (typeof provider !== "object" || provider === null) continue;
    const models = (provider as Record<string, unknown>).models;
    if (typeof models !== "object" || models === null) continue;

    for (const [modelId, modelEntry] of Object.entries(
      models as Record<string, unknown>,
    )) {
      if (modelId in result) continue; // already set by a higher-priority provider
      if (typeof modelEntry !== "object" || modelEntry === null) continue;
      const rawCost = (modelEntry as Record<string, unknown>).cost;
      if (typeof rawCost !== "object" || rawCost === null) continue;
      const price = toModelPrice(rawCost as RawCost);
      if (price) result[modelId] = price;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Network fetch — the ONLY place in src/pricing that calls out. Called exclusively from
// refresh.ts (`peek pricing refresh`); nothing in the library/lookup path invokes this.
// ---------------------------------------------------------------------------

/** Structural subset of the global `fetch` signature this module needs — narrow enough that
 * tests can pass a plain mock object instead of constructing a real Response. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

export interface FetchModelsDevOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Fetches and maps the live models.dev pricing payload. Throws a clear Error on network
 * failure, timeout, non-2xx response, or unparseable JSON — never returns a partial result. */
export async function fetchModelsDevPricing(
  options: FetchModelsDevOptions = {},
): Promise<ModelsDevSnapshot> {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(MODELS_DEV_API_URL, {
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `fetchModelsDevPricing: request to ${MODELS_DEV_API_URL} failed (${reason})`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(
      `fetchModelsDevPricing: ${MODELS_DEV_API_URL} responded ${response.status} ${response.statusText}`,
    );
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `fetchModelsDevPricing: ${MODELS_DEV_API_URL} response was not valid JSON (${reason})`,
    );
  }

  return {
    fetchedAt: new Date().toISOString(),
    models: mapModelsDevPayload(raw),
  };
}

// ---------------------------------------------------------------------------
// Cached-snapshot consult path — offline, synchronous, the only network-adjacent thing
// accounting.ts's priceTurn touches (a local file read, not a network call).
// ---------------------------------------------------------------------------

const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** `${XDG_CACHE_HOME ?? ~/.cache}/peek/models-dev.json` — mirrors cache/totals.ts's
 * resolveCachePath convention. `override` is a test-only escape hatch. */
export function resolveModelsDevCachePath(override?: string): string {
  if (override) return override;
  const base = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(base, "peek", "models-dev.json");
}

function isValidSnapshot(value: unknown): value is ModelsDevSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.fetchedAt !== "string") return false;
  if (typeof v.models !== "object" || v.models === null) return false;
  return true;
}

/** A price field must be a finite, non-negative number — mirrors lookup.ts's numOrNull()
 * shape-check but additionally rejects NaN/Infinity/negative, which numOrNull doesn't (that
 * module only ever sees the vendored, trusted LiteLLM snapshot; this one reads a cache file
 * that's plain JSON on disk and can be hand-edited to anything "typeof number" accepts, e.g.
 * `1/0`-style Infinity via JSON's `1e999`). */
function isValidPriceNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidNullablePriceNumber(value: unknown): boolean {
  return value === null || isValidPriceNumber(value);
}

function isValidTiering(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  if (t.thresholdTokens !== 200_000) return false;
  const optionalFields = [
    "input",
    "output",
    "cacheRead",
    "cacheCreation5m",
    "cacheCreation1h",
  ] as const;
  for (const key of optionalFields) {
    if (key in t && !isValidPriceNumber(t[key])) return false;
  }
  return true;
}

/** Validates a single cached ModelPrice leaf: input/output required finite >=0 numbers,
 * the three nullable cache fields either null or finite >=0, tiering either null or
 * well-shaped. Mirrors the finiteness/sign guarantee mapModelsDevPayload's toModelPrice
 * establishes for network-fetched data — needed again here because this is the disk-read
 * path, which trusts a file that isn't re-validated at fetch time. */
function isValidModelPrice(value: unknown): value is ModelPrice {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  if (!isValidPriceNumber(p.input)) return false;
  if (!isValidPriceNumber(p.output)) return false;
  if (!isValidNullablePriceNumber(p.cacheRead)) return false;
  if (!isValidNullablePriceNumber(p.cacheCreation5m)) return false;
  if (!isValidNullablePriceNumber(p.cacheCreation1h)) return false;
  if (!isValidTiering(p.tiering)) return false;
  return true;
}

/** Drops any model entry whose price leaves fail validation, rather than rejecting the whole
 * snapshot: a single poisoned/hand-edited model entry (e.g. `"input":"not-a-number"`) shouldn't
 * take down fallback pricing for every other model the cache still has good data for. Per-entry
 * drop is the deliberate, less-surprising choice here — the alternative (reject-on-any-bad-leaf)
 * would turn one corrupt row into a total fallback-pricing outage. */
function sanitizeSnapshotModels(
  models: Record<string, unknown>,
): Record<string, ModelPrice> {
  const result: Record<string, ModelPrice> = {};
  for (const [modelId, price] of Object.entries(models)) {
    if (isValidModelPrice(price)) result[modelId] = price;
  }
  return result;
}

function readCachedSnapshotFromDisk(
  cachePath: string,
): ModelsDevSnapshot | null {
  let raw: string;
  try {
    raw = readFileSync(cachePath, "utf8");
  } catch {
    return null; // missing/unreadable — silently ignored, per PLAN's opt-in-refresh design
  }
  // File existed and was readable — tighten it (and its dir) to owner-only in case it
  // was left loose by a peek version predating refresh.ts's permission hardening.
  // Best-effort: a failed chmod here is silently ignored, same rationale as
  // refresh.ts's write-side tightenPerms.
  try {
    chmodSync(cachePath, 0o600);
    chmodSync(path.dirname(cachePath), 0o700);
  } catch {
    // best-effort — ignore
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt JSON — silently ignored
  }
  if (!isValidSnapshot(parsed)) return null; // wrong/stale shape — silently ignored

  const ageMs = Date.now() - new Date(parsed.fetchedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > CACHE_MAX_AGE_MS)
    return null; // stale

  return {
    fetchedAt: parsed.fetchedAt,
    models: sanitizeSnapshotModels(
      parsed.models as unknown as Record<string, unknown>,
    ),
  };
}

// Memoized by resolved cache path (not a single flat flag) so distinct paths — as used by
// tests exercising different tmp XDG_CACHE_HOME dirs in the same process — never collide. A
// real `peek` invocation only ever resolves one path per process, so this is effectively
// "read once per process" in production, same as lookup.ts's loadSnapshot().
const snapshotCacheByPath = new Map<string, ModelsDevSnapshot | null>();

/** Lazily, synchronously loads the models.dev fallback snapshot `refresh.ts` last wrote to
 * disk. Returns null on any problem — missing file, corrupt JSON, wrong shape, or a snapshot
 * older than 30 days — never throws. `cachePathOverride` is a test-only escape hatch (see
 * resolveModelsDevCachePath). */
export function loadCachedModelsDevSnapshot(
  cachePathOverride?: string,
): ModelsDevSnapshot | null {
  const cachePath = resolveModelsDevCachePath(cachePathOverride);
  const cached = snapshotCacheByPath.get(cachePath);
  if (cached !== undefined) return cached;
  const result = readCachedSnapshotFromDisk(cachePath);
  snapshotCacheByPath.set(cachePath, result);
  return result;
}

const PROVIDER_PREFIX_RE = /^[a-z0-9_.]+\//i;
const DATE_SUFFIX_RE = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;

/**
 * Resolves a model id against an already-loaded models.dev snapshot — the fallback tier only,
 * consulted after `lookupModelPrice` (lookup.ts, the LiteLLM snapshot) has already missed.
 * Mirrors lookup.ts's exact-then-normalized-prefix/date-suffix resolution order for parity.
 * `modelsDevSnapshot` is null when no fresh cache is available (loadCachedModelsDevSnapshot
 * returned null) — that's always a miss here, never an error.
 */
export function lookupWithFallback(
  modelId: string,
  opts: { modelsDevSnapshot: ModelsDevSnapshot | null },
): ModelPrice | null {
  const snapshot = opts.modelsDevSnapshot;
  if (!snapshot) return null;

  const direct = snapshot.models[modelId];
  if (direct) return direct;

  const withoutPrefix = modelId.replace(PROVIDER_PREFIX_RE, "");
  const candidates = new Set<string>([
    withoutPrefix,
    modelId.replace(DATE_SUFFIX_RE, ""),
    withoutPrefix.replace(DATE_SUFFIX_RE, ""),
  ]);

  for (const candidate of candidates) {
    if (candidate === modelId) continue;
    const price = snapshot.models[candidate];
    if (price) return price;
  }

  return null;
}
