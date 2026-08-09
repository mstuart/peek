// Codex event_msg -> usage attachment (T4.5).
//
// Processes `event_msg` records in stream order and attaches each
// `token_count`'s per-turn usage to the Turn it belongs to. Called from
// parse.ts's main record loop (one call per event_msg record), threading a
// small CodexUsageState across calls so the final cumulative cross-check can
// run once, after the whole file has been walked.
//
// RULE (types.ts): adapters never throw on malformed/unknown records — warn
// and continue.

import { contextTotal, normalizeCodexUsage } from "../../model/normalize.js";
import type { NormalizedUsage, ParseWarning, Turn } from "../../model/types.js";

function prop(raw: unknown, key: string): unknown {
  if (typeof raw !== "object" || raw === null) return undefined;
  return (raw as Record<string, unknown>)[key];
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * event_msg payload.type values that are known but produce no Turn/event at
 * this layer — v1 does not model turn-boundary bookkeeping as its own
 * SessionEvent (docs/recon/codex.md lists `user_message`/`agent_message`/
 * `agent_reasoning` as informational echoes of content already captured via
 * response_item -> items.ts, and `turn_started`/`turn_complete`, wire names
 * `task_started`/`task_complete`, as pure lifecycle markers). Anything NOT
 * in this set and not `token_count`/`context_compacted` (handled elsewhere)
 * is genuinely unrecognized and gets the "unknown-event-msg" warning.
 */
const TOLERATED_EVENT_MSG_TYPES: ReadonlySet<string> = new Set([
  "user_message",
  "agent_message",
  "agent_reasoning",
  "turn_started",
  "turn_complete",
  "task_started",
  "task_complete",
]);

/**
 * Cross-call state threaded through a single session's event_msg stream by
 * the caller (parse.ts) — the most recently seen `total_token_usage` (codex's
 * cumulative counter), used only for the end-of-file cross-check.
 */
export interface CodexUsageState {
  lastCumulativeTotalTokens: number | null;
  sawTokenCount: boolean;
}

export function createCodexUsageState(): CodexUsageState {
  return { lastCumulativeTotalTokens: null, sawTokenCount: false };
}

/**
 * Finds the Turn a `token_count`'s `last_token_usage` should attach to:
 * scanning backward from the end of `turns` (built so far) for the nearest
 * `assistant`-role turn that does not yet carry real usage (`contextTotal
 * === 0` — the same "real usage" convention engine/compaction.ts already
 * uses). This is codex's own turn-taking shape: a "turn" is a run of
 * response_items (reasoning, tool calls, final message) capped by exactly
 * one token_count, so only the FINAL assistant response_item of that run
 * ever receives usage — earlier assistant-role items (reasoning,
 * function_call) legitimately stay at contextTotal 0 forever, which is why
 * "not yet carrying usage" (not "is the last turn") is the right test.
 */
function findAttachTarget(turns: Turn[]): number | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn && turn.role === "assistant" && turn.contextTotal === 0) return i;
  }
  return undefined;
}

/**
 * Handles one `event_msg` record's `payload`. Mutates `turns` in place
 * (replacing the attached-to element with a copy carrying real usage) and
 * pushes warnings/updates `state` as needed. Returns nothing — compaction's
 * `context_compacted` marker is handled separately by parse.ts/compacted.ts,
 * since it interacts with `compacted`-record adjacency, not usage.
 */
export function handleEventMsg(
  payload: unknown,
  turns: Turn[],
  state: CodexUsageState,
  warnings: ParseWarning[],
  line: number,
): void {
  const type = prop(payload, "type");
  const typeStr = typeof type === "string" ? type : undefined;

  if (typeStr === "token_count") {
    attachTokenCount(payload, turns, state, warnings, line);
    return;
  }

  if (typeStr === "context_compacted") {
    // Owned by compacted.ts / parse.ts's compacted-adjacency tracking — not
    // this function's concern.
    return;
  }

  if (typeStr !== undefined && TOLERATED_EVENT_MSG_TYPES.has(typeStr)) {
    return;
  }

  warnings.push({
    code: "unknown-event-msg",
    message: `line ${line}: unrecognized event_msg payload.type ${
      typeStr ? `"${typeStr}"` : "(missing)"
    }`,
    line,
    recordType: "event_msg",
  });
}

/**
 * `info.last_token_usage` -> NormalizedUsage via normalizeCodexUsage
 * (subset->additive, T0.2/normalize.ts), attached to the nearest unattached
 * assistant Turn. `info.model_context_window` isn't part of
 * `last_token_usage`'s own shape, so it would otherwise be dropped by
 * normalizeCodexUsage(raw) reading only last_token_usage's fields — kept by
 * overriding NormalizedUsage.raw to the whole `info` object (not just
 * last_token_usage) after normalizing, so model_context_window (and the
 * cumulative total_token_usage) stay inspectable off the Turn's own usage.raw
 * rather than being lost.
 *
 * `total_token_usage` is NOT summed into any turn (docs/DESIGN.md: codex's
 * cumulative counter is a cross-check only) — just recorded on `state` for
 * the end-of-file comparison in checkCumulativeCrossCheck.
 */
function attachTokenCount(
  payload: unknown,
  turns: Turn[],
  state: CodexUsageState,
  warnings: ParseWarning[],
  line: number,
): void {
  const info = prop(payload, "info");
  const lastTokenUsage = prop(info, "last_token_usage");
  const totalTokenUsage = prop(info, "total_token_usage");

  state.sawTokenCount = true;
  const cumulativeTotal = toNumber(prop(totalTokenUsage, "total_tokens"));
  state.lastCumulativeTotalTokens =
    cumulativeTotal ?? state.lastCumulativeTotalTokens;

  const targetIndex = findAttachTarget(turns);
  if (targetIndex === undefined) {
    warnings.push({
      code: "orphan-token-count",
      message: `line ${line}: token_count has no unattached assistant turn to attach to`,
      line,
      recordType: "event_msg",
    });
    return;
  }

  const normalized: NormalizedUsage = {
    ...normalizeCodexUsage(lastTokenUsage),
    raw: info,
  };
  const target = turns[targetIndex];
  if (!target) return;
  turns[targetIndex] = {
    ...target,
    usage: normalized,
    contextTotal: contextTotal(normalized),
  };
}

const CROSS_CHECK_TOLERANCE = 0.01; // 1%

/**
 * End-of-file cumulative cross-check (docs/DESIGN.md T4.5): codex's
 * `total_token_usage` is the cumulative counter as of the LAST token_count
 * seen in the file; it should be ~= the sum of every turn's own
 * (contextTotal + usage.output) — the per-turn equivalent of codex's own
 * `total_tokens` field (`total = input + output`, recon-measured).
 *
 * Measured behavior (compaction.jsonl): codex's cumulative counter does NOT
 * persist additively across a compaction — it resets to reflect the
 * post-compaction window, so a session containing a compaction is EXPECTED
 * to fail this check by a wide margin. That is a real, correctly-detected
 * discontinuity, not a parser bug — the warning documents it rather than
 * hiding it.
 */
export function checkCumulativeCrossCheck(
  turns: readonly Turn[],
  state: CodexUsageState,
  warnings: ParseWarning[],
): void {
  if (!state.sawTokenCount || state.lastCumulativeTotalTokens === null) return;

  let sum = 0;
  for (const turn of turns) {
    if (turn.contextTotal === 0) continue;
    sum += turn.contextTotal + turn.usage.output;
  }

  const cumulative = state.lastCumulativeTotalTokens;
  const diff = Math.abs(cumulative - sum);
  const denom = Math.max(Math.abs(cumulative), 1);
  if (diff / denom > CROSS_CHECK_TOLERANCE) {
    warnings.push({
      code: "token-count-mismatch",
      message: `cumulative total_token_usage (${cumulative}) diverges from Σ per-turn totals (${sum}) by more than 1%`,
    });
  }
}
