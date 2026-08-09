// Per-harness raw usage → NormalizedUsage. Pure functions; no I/O. See docs/DESIGN.md
// § "Unified Session Model (USM)" / "Accounting rules" rule 1 for the additive vs.
// subset conventions each of these encodes.

import type { NormalizedUsage } from "./types.js";

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function prop(raw: unknown, key: string): unknown {
  if (typeof raw !== "object" || raw === null) return undefined;
  return (raw as Record<string, unknown>)[key];
}

/**
 * Claude Code usage → NormalizedUsage. Additive fields: input_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens. When the
 * cache_creation sub-object (ephemeral_5m_input_tokens / ephemeral_1h_input_tokens)
 * is present it splits the TTL; when absent, all cache_creation_input_tokens is
 * treated as a 5m write.
 */
export function normalizeClaudeUsage(raw: unknown): NormalizedUsage {
  const inputUncached = toNumber(prop(raw, "input_tokens"));
  const cacheRead = toNumber(prop(raw, "cache_read_input_tokens"));
  const cacheCreation = prop(raw, "cache_creation");

  let cacheWrite5m: number;
  let cacheWrite1h: number;
  if (typeof cacheCreation === "object" && cacheCreation !== null) {
    cacheWrite5m = toNumber(prop(cacheCreation, "ephemeral_5m_input_tokens"));
    cacheWrite1h = toNumber(prop(cacheCreation, "ephemeral_1h_input_tokens"));
  } else {
    cacheWrite5m = toNumber(prop(raw, "cache_creation_input_tokens"));
    cacheWrite1h = 0;
  }

  return {
    inputUncached,
    cacheRead,
    cacheWrite5m,
    cacheWrite1h,
    output: toNumber(prop(raw, "output_tokens")),
    raw,
  };
}

/**
 * Codex usage → NormalizedUsage. SUBSET semantics (measured 2026-08-08 against
 * codex-cli 0.134.0): input_tokens INCLUDES cached_input_tokens, so
 * inputUncached is the difference. cache_write_input_tokens defaults to 0 when
 * absent (observed absent even on 0.134.0) and is treated as a 5m write —
 * codex has no observed 1h TTL split.
 */
export function normalizeCodexUsage(raw: unknown): NormalizedUsage {
  const inputTotal = toNumber(prop(raw, "input_tokens"));
  const cachedInput = toNumber(prop(raw, "cached_input_tokens"));
  const reasoning = prop(raw, "reasoning_output_tokens");

  const usage: NormalizedUsage = {
    // Subset semantics measured on real captures; clamp so malformed data
    // (cached > total) can never produce a negative (engine review Q3).
    inputUncached: Math.max(0, inputTotal - cachedInput),
    cacheRead: cachedInput,
    cacheWrite5m: toNumber(prop(raw, "cache_write_input_tokens")),
    cacheWrite1h: 0,
    output: toNumber(prop(raw, "output_tokens")),
    raw,
  };
  if (reasoning !== undefined) {
    usage.reasoningOutput = toNumber(reasoning);
  }
  return usage;
}

/**
 * pi usage → NormalizedUsage. Additive fields: input, cacheRead, cacheWrite,
 * output. When cacheWrite1h is present it is a subset of cacheWrite
 * (cacheWrite5m = cacheWrite − cacheWrite1h); when absent, all of cacheWrite
 * is treated as a 5m write. reasoning → reasoningOutput.
 */
export function normalizePiUsage(raw: unknown): NormalizedUsage {
  const cacheWriteTotal = toNumber(prop(raw, "cacheWrite"));
  const cacheWrite1hRaw = prop(raw, "cacheWrite1h");
  const hasCacheWrite1h =
    cacheWrite1hRaw !== undefined && cacheWrite1hRaw !== null;
  const cacheWrite1h = hasCacheWrite1h ? toNumber(cacheWrite1hRaw) : 0;
  const reasoning = prop(raw, "reasoning");

  const usage: NormalizedUsage = {
    inputUncached: toNumber(prop(raw, "input")),
    cacheRead: toNumber(prop(raw, "cacheRead")),
    cacheWrite5m: hasCacheWrite1h
      ? cacheWriteTotal - cacheWrite1h
      : cacheWriteTotal,
    cacheWrite1h,
    output: toNumber(prop(raw, "output")),
    raw,
  };
  if (reasoning !== undefined) {
    usage.reasoningOutput = toNumber(reasoning);
  }
  return usage;
}

/** contextTotal invariant: inputUncached + cacheRead + cacheWrite5m + cacheWrite1h. */
export function contextTotal(usage: NormalizedUsage): number {
  return (
    usage.inputUncached +
    usage.cacheRead +
    usage.cacheWrite5m +
    usage.cacheWrite1h
  );
}
