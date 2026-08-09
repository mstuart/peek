// Opt-in pricing refresh — DESIGN.md standing worker rule 2: "No network in library code; pricing
// refresh is an explicit opt-in command path." This is that path: `peek pricing refresh` (see
// src/commands/pricing.ts) is the ONLY thing that calls this, and this is the only place that
// calls modelsDev.ts's fetchModelsDevPricing. Nothing else in src/pricing or engine/accounting.ts
// triggers a fetch.

import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type FetchModelsDevOptions,
  MODELS_DEV_API_URL,
  fetchModelsDevPricing,
  resolveModelsDevCachePath,
} from "./modelsDev.js";

/** A models.dev payload parsing to fewer priced models than this is treated as truncated or
 * malformed — refresh refuses to overwrite a good cache with a bad one. The live payload
 * (fetched 2026-08-08) mapped ~2700 priced models; 100 is a conservative floor well below that,
 * not a tight bound on the real payload size. */
const MIN_EXPECTED_MODELS = 100;

// The pricing snapshot is host-local convenience state, not secret — but it lives in
// the same peek cache dir as cache/totals.ts's usernames/project-path rows, so it's
// tightened to owner-only (0700 dir / 0600 file) for consistency and to avoid a
// looser dir mode leaking totals-v1.jsonl's filename to other accounts on a shared
// machine. `mode` on mkdir/writeFile only applies to a path that doesn't yet exist,
// so an explicit chmod after every create/write is required to actually guarantee it.
const CACHE_DIR_MODE = 0o700;
const CACHE_FILE_MODE = 0o600;

/** Best-effort chmod — failure is silently ignored (see cache/totals.ts's identical
 * helper for the rationale: this is convenience cache state, never worth crashing
 * `peek pricing refresh` over). */
async function tightenPerms(targetPath: string, mode: number): Promise<void> {
  try {
    await chmod(targetPath, mode);
  } catch {
    // best-effort — ignore
  }
}

export interface RefreshPricingOptions {
  /** Test-only escape hatch: injects a fake fetch instead of hitting the network. */
  fetchImpl?: FetchModelsDevOptions["fetchImpl"];
  timeoutMs?: number;
  /** Test-only escape hatch: overrides the XDG cache path the snapshot is written to. */
  cachePathOverride?: string;
}

export interface RefreshPricingResult {
  outputPath: string;
  fetchedAt: string;
  modelCount: number;
}

/**
 * Fetches a fresh models.dev pricing snapshot, validates it's plausible (not truncated or
 * malformed), and writes it atomically (tmp file + rename, mirroring cache/totals.ts's
 * compaction convention) to the XDG cache path lookupWithFallback reads from. Never leaves a
 * partial/corrupt file in place: validation happens entirely before any write.
 */
export async function refreshPricingSnapshot(
  options: RefreshPricingOptions = {},
): Promise<RefreshPricingResult> {
  const fetchOptions: FetchModelsDevOptions = {};
  if (options.fetchImpl !== undefined)
    fetchOptions.fetchImpl = options.fetchImpl;
  if (options.timeoutMs !== undefined)
    fetchOptions.timeoutMs = options.timeoutMs;

  const snapshot = await fetchModelsDevPricing(fetchOptions);
  const modelCount = Object.keys(snapshot.models).length;
  if (modelCount < MIN_EXPECTED_MODELS) {
    throw new Error(
      `refreshPricingSnapshot: only ${modelCount} priced models parsed from ${MODELS_DEV_API_URL} ` +
        `(expected at least ${MIN_EXPECTED_MODELS}) — payload looks truncated or malformed, refusing to write cache`,
    );
  }

  const outputPath = resolveModelsDevCachePath(options.cachePathOverride);
  const dir = path.dirname(outputPath);
  await mkdir(dir, { recursive: true, mode: CACHE_DIR_MODE });
  await tightenPerms(dir, CACHE_DIR_MODE);
  const tmpPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(snapshot), {
    encoding: "utf8",
    mode: CACHE_FILE_MODE,
  });
  await tightenPerms(tmpPath, CACHE_FILE_MODE); // chmod before rename
  await rename(tmpPath, outputPath);

  return { outputPath, fetchedAt: snapshot.fetchedAt, modelCount };
}
