// Vendored LiteLLM pricing snapshot lookup.
//
// Source: https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
// Snapshot date: 2026-08-08
// Snapshot size: fetched raw at ~1.6MB / 2988 top-level keys (incl. a "sample_spec" non-model
// entry) — under the docs/DESIGN.md T0.3 2MB prune-consideration threshold, but over
// this repo's biome `files.maxSize` (1MiB), which does apply. Pruned to keys matching
// /claude|gpt|o[0-9]|codex|qwen|gemini/i (1288 of 2988 keys retained), landing at ~736KB. The
// full unpruned fetch is not committed anywhere in the repo.
//
// Field mapping observed in the snapshot for Claude models (e.g. "claude-opus-5",
// "claude-sonnet-4-5"), confirming DESIGN.md accounting rule 4:
//   input_cost_per_token                                  -> input
//   output_cost_per_token                                 -> output
//   cache_read_input_token_cost                            -> cacheRead
//   cache_creation_input_token_cost                        -> cacheCreation5m (default/ephemeral TTL)
//   cache_creation_input_token_cost_above_1hr               -> cacheCreation1h
// When cache_creation_input_token_cost_above_1hr is absent, cacheCreation1h is left null —
// the accounting engine (T2.2) hardcodes 2x input in that case per PLAN rule 4. This module
// does NOT apply that hardcode; it only reports what the snapshot contains.
//
// Long-context tiering: only a "> 200k input tokens" tier was found in this snapshot, keyed as
// "<field>_above_200k_tokens" (and "cache_creation_input_token_cost_above_1hr_above_200k_tokens"
// for the 1h-TTL tier at that same threshold). Not all models carry tiering fields — e.g.
// "claude-opus-5" (this snapshot: max_input_tokens 1,000,000) has none, while
// "claude-sonnet-4-5" (max_input_tokens 200,000) has the full set. Mapped 1:1 below; no
// threshold other than 200k was observed anywhere in the snapshot.
//
// GPT-5-family models (e.g. "gpt-5") carry input/output/cacheRead costs but no
// cache_creation_input_token_cost field at all — OpenAI's prompt caching has no write cost, so
// cacheCreation5m/cacheCreation1h are both null for these models. This is expected, not a gap.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Loader is fs-based (reads the JSON snapshot relative to this module's URL) rather than a
 * static `import ... assert { type: "json" }`, so tsup's single-file ESM bundle for src/cli.ts
 * doesn't need to inline a ~1.6MB data file into the bundle — the snapshot ships alongside the
 * compiled output as a plain file and is read at runtime. Packaging (making sure
 * dist-relative paths resolve after `tsup` build / `npm pack`) is a build-config concern for a
 * later task, not addressed here. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PRICING_SNAPSHOT_SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const PRICING_SNAPSHOT_DATE = "2026-08-08";

const SNAPSHOT_FILENAME = "litellm-2026-08-08.json";

type RawLiteLLMRecord = Record<string, unknown>;
type RawLiteLLMSnapshot = Record<string, RawLiteLLMRecord>;

let cachedSnapshot: RawLiteLLMSnapshot | null = null;

function loadSnapshot(): RawLiteLLMSnapshot {
  if (cachedSnapshot) {
    return cachedSnapshot;
  }
  const filePath = path.join(__dirname, "data", SNAPSHOT_FILENAME);
  const raw = readFileSync(filePath, "utf8");
  cachedSnapshot = JSON.parse(raw) as RawLiteLLMSnapshot;
  return cachedSnapshot;
}

/** Long-context pricing tier, keyed off the ">200k input tokens" fields observed in the
 * snapshot. Fields are only present when the source record carried the corresponding
 * "*_above_200k_tokens" key. */
export interface TieredModelPrice {
  thresholdTokens: 200_000;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation5m?: number;
  cacheCreation1h?: number;
}

export interface ModelPrice {
  /** USD per input token. */
  input: number;
  /** USD per output token. */
  output: number;
  /** USD per cache-read token, or null when the snapshot doesn't price it. */
  cacheRead: number | null;
  /** USD per cache-write token at the default (5-minute) TTL, or null when absent. */
  cacheCreation5m: number | null;
  /** USD per cache-write token at the 1-hour TTL, or null when absent (engine hardcodes 2x
   * input in that case per DESIGN.md accounting rule 4 — not applied here). */
  cacheCreation1h: number | null;
  /** Long-context tier pricing, or null when the model has none in the snapshot. */
  tiering: TieredModelPrice | null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function toModelPrice(record: RawLiteLLMRecord): ModelPrice | null {
  const input = numOrNull(record.input_cost_per_token);
  const output = numOrNull(record.output_cost_per_token);
  if (input === null || output === null) {
    // Not a priced chat/completion model (e.g. embedding-only, moderation, or metadata entries).
    return null;
  }

  const tieredInput = numOrNull(record.input_cost_per_token_above_200k_tokens);
  const tieredOutput = numOrNull(
    record.output_cost_per_token_above_200k_tokens,
  );
  const tieredCacheRead = numOrNull(
    record.cache_read_input_token_cost_above_200k_tokens,
  );
  const tieredCacheCreation5m = numOrNull(
    record.cache_creation_input_token_cost_above_200k_tokens,
  );
  const tieredCacheCreation1h = numOrNull(
    record.cache_creation_input_token_cost_above_1hr_above_200k_tokens,
  );
  const hasTiering =
    tieredInput !== null ||
    tieredOutput !== null ||
    tieredCacheRead !== null ||
    tieredCacheCreation5m !== null ||
    tieredCacheCreation1h !== null;

  const tiering: TieredModelPrice | null = hasTiering
    ? {
        thresholdTokens: 200_000,
        ...(tieredInput !== null ? { input: tieredInput } : {}),
        ...(tieredOutput !== null ? { output: tieredOutput } : {}),
        ...(tieredCacheRead !== null ? { cacheRead: tieredCacheRead } : {}),
        ...(tieredCacheCreation5m !== null
          ? { cacheCreation5m: tieredCacheCreation5m }
          : {}),
        ...(tieredCacheCreation1h !== null
          ? { cacheCreation1h: tieredCacheCreation1h }
          : {}),
      }
    : null;

  return {
    input,
    output,
    cacheRead: numOrNull(record.cache_read_input_token_cost),
    cacheCreation5m: numOrNull(record.cache_creation_input_token_cost),
    cacheCreation1h: numOrNull(
      record.cache_creation_input_token_cost_above_1hr,
    ),
    tiering,
  };
}

const PROVIDER_PREFIX_RE = /^[a-z0-9_.]+\//i;
const DATE_SUFFIX_RE = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;

/**
 * Looks up a model's pricing in the vendored LiteLLM snapshot.
 *
 * Resolution order:
 *   1. Exact key match against the snapshot.
 *   2. Conservative normalized fallback — strip a leading "<provider>/" prefix (e.g.
 *      "anthropic/claude-opus-5" -> "claude-opus-5") and/or a trailing date suffix (e.g.
 *      "claude-opus-5-20260101" -> "claude-opus-5"), then require the *exact* normalized
 *      string to be a snapshot key. No fuzzy/partial/substring matching — a miss is a miss.
 *
 * Returns null when no exact or normalized-fallback key resolves to a priced record.
 */
export function lookupModelPrice(modelId: string): ModelPrice | null {
  const snapshot = loadSnapshot();

  const direct = snapshot[modelId];
  if (direct) {
    const price = toModelPrice(direct);
    if (price) {
      return price;
    }
  }

  const withoutPrefix = modelId.replace(PROVIDER_PREFIX_RE, "");
  const candidates = new Set<string>([
    withoutPrefix,
    modelId.replace(DATE_SUFFIX_RE, ""),
    withoutPrefix.replace(DATE_SUFFIX_RE, ""),
  ]);

  for (const candidate of candidates) {
    if (candidate === modelId) {
      continue;
    }
    const record = snapshot[candidate];
    if (record) {
      const price = toModelPrice(record);
      if (price) {
        return price;
      }
    }
  }

  return null;
}
