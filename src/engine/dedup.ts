// Dedup engine (T2.1) — docs/DESIGN.md § "Accounting rules" rule 2.
//
// Two required cases, both keyed off fields that live on the WHOLE raw record
// preserved at `turn.usage.raw` (parse.ts never surfaces message.id/requestId/
// isSidechain on Turn itself — types.ts is frozen):
//
//   1. Streaming split (dominant): records sharing BOTH message.id and
//      requestId are fragments (thinking/text/tool_use) of one logical turn.
//      Merge into ONE Turn — usage counted once, contentSpans concatenated.
//   2. Sidechain replay (ccusage #913): records sharing message.id but with
//      DIFFERENT requestId are a replay family. Keep exactly one: prefer
//      non-sidechain (raw.isSidechain !== true); on a sidechain-ness tie,
//      prefer the higher total token count (contextTotal + usage.output).
//
// Turns without both message.id and requestId on their raw record (pi/codex
// adapters — recon: pi entries are already unique, codex response items don't
// repeat usage) are not eligible for either case and pass through unchanged,
// as does anything that isn't an assistant turn (only assistant records can
// be streaming-split fragments or sidechain replays per the recon).
//
// Order is preserved: the merged/kept turn for a message.id family occupies
// the position of that family's EARLIEST record in the input array; deduped-
// away turns leave no gap (the array is compacted).
//
// dedupFamily (T2.5 reconciliation follow-up): the two cases above are
// PER-FILE — dedupTurnsWithMap/dedupSession only ever see one Session's own
// turns[]. Claude Code subagent files can independently REPLAY a message the
// parent file already logged (same message.id, sometimes also the same
// requestId) — measured on a real 210-file session family: 319 cross-file
// duplicate turns carrying ~76M tokens, which inflated family-level rollups
// (bySubagent) relative to ccusage's corpus-wide dedup. dedupFamily is the
// cross-file extension: run dedupSession per member first (unchanged), then
// walk every member's turns in FILE ORDER (sessions[0] first — the caller's
// documented parent-first contract, same as attribution.ts's bySubagent) and
// zero out any turn whose (message.id, requestId) — or message.id alone,
// fallback — was already seen in an earlier file.

import type {
  CostBreakdown,
  NormalizedUsage,
  Session,
  Turn,
} from "../model/types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function rawOf(turn: Turn): Record<string, unknown> | undefined {
  return asRecord(turn.usage.raw);
}

function rawMessageId(turn: Turn): string | undefined {
  const message = asRecord(rawOf(turn)?.message);
  const id = message?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function rawRequestId(turn: Turn): string | undefined {
  const id = rawOf(turn)?.requestId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** raw.isSidechain !== true counts as non-sidechain (missing/undefined included). */
function rawIsSidechain(turn: Turn): boolean {
  return rawOf(turn)?.isSidechain === true;
}

export interface DedupKey {
  messageId: string;
  requestId: string;
}

/**
 * Primary dedup key extractor. Returns undefined (not eligible for dedup)
 * when the turn isn't an assistant turn, or its raw record lacks either
 * message.id or requestId.
 */
export function extractDedupKey(turn: Turn): DedupKey | undefined {
  if (turn.role !== "assistant") {
    return;
  }
  const messageId = rawMessageId(turn);
  const requestId = rawRequestId(turn);
  if (messageId === undefined || requestId === undefined) {
    return;
  }
  return { messageId, requestId };
}

/** contextTotal + output, the tie-break metric named in DESIGN.md rule 2. */
export function totalTokenCount(turn: Turn): number {
  return turn.contextTotal + turn.usage.output;
}

function usageEquals(a: NormalizedUsage, b: NormalizedUsage): boolean {
  return (
    a.inputUncached === b.inputUncached &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite5m === b.cacheWrite5m &&
    a.cacheWrite1h === b.cacheWrite1h &&
    a.output === b.output
  );
}

/**
 * Merges a group of Turns known to share (message.id, requestId) — the
 * streaming-split case — into one logical Turn. `turns` must be non-empty and
 * in original record order.
 *
 * Usage is identical across fragments by definition (recon: the same
 * top-level usage object is repeated on every thinking/text/tool_use
 * fragment of one logical turn) and is counted once. If a group violates
 * that invariant, this falls back to the fragment with the highest total
 * token count rather than summing (summing would double-count real tokens).
 * There is no ParseWarning channel reachable here — dedupTurns is a pure
 * Turn[] -> Turn[] transform with no Session/warnings context — so that
 * fallback is documented here rather than attached as a formal warning.
 *
 * model/timestamp/composition/cost/cacheMissReason are taken from the first
 * fragment (chronologically earliest); contentSpans is the concatenation of
 * every fragment's spans in record order.
 */
export function mergeStreamingSplit(turns: readonly Turn[]): Turn {
  const [first] = turns;
  if (first === undefined) {
    throw new Error("mergeStreamingSplit: turns must be non-empty");
  }
  if (turns.length === 1) {
    return first;
  }

  const identical = turns.every((t) => usageEquals(t.usage, first.usage));
  const usageSource = identical
    ? first
    : turns.reduce((best, t) =>
        totalTokenCount(t) > totalTokenCount(best) ? t : best
      );

  return {
    ...first,
    contentSpans: turns.flatMap((t) => t.contentSpans),
    contextTotal: usageSource.contextTotal,
    usage: usageSource.usage,
  };
}

/**
 * Picks the surviving Turn from a sidechain-replay family (records sharing
 * message.id, differing requestId — ccusage #913). Non-sidechain
 * (raw.isSidechain !== true) beats sidechain; on a sidechain-ness tie, the
 * higher total token count (contextTotal + usage.output) wins. `turns` must
 * be non-empty.
 */
export function pickSidechainWinner(turns: readonly Turn[]): Turn {
  const [first] = turns;
  if (first === undefined) {
    throw new Error("pickSidechainWinner: turns must be non-empty");
  }
  return turns.reduce((best, candidate) => {
    const bestSidechain = rawIsSidechain(best);
    const candidateSidechain = rawIsSidechain(candidate);
    if (bestSidechain !== candidateSidechain) {
      return candidateSidechain ? best : candidate;
    }
    return totalTokenCount(candidate) > totalTokenCount(best)
      ? candidate
      : best;
  }, first);
}

interface KeyedEntry {
  index: number;
  requestId: string;
  turn: Turn;
}

export interface DedupResult {
  /**
   * indexMap[originalIndex] = index in `turns` (the deduped array) of the
   * turn that survived/absorbed the turn originally at `originalIndex`.
   * Non-eligible turns (no dedup key, or not an assistant turn) map to their
   * own final position — they're never absorbed by anything. Every merged
   * fragment or sidechain-replay loser in a family maps to its surviving
   * turn's final position.
   */
  indexMap: number[];
  turns: Turn[];
}

/**
 * Dedups a Turn[] per DESIGN.md accounting rule 2, also returning the
 * original-index -> deduped-index map (see DedupResult). Pure,
 * order-preserving, idempotent — see dedupTurns below.
 */
export function dedupTurnsWithMap(turns: readonly Turn[]): DedupResult {
  const result: (Turn | undefined)[] = new Array(turns.length);
  // absorbedInto[originalIndex] = the pre-compaction slot in `result` that
  // ends up holding the turn this original index was folded into.
  const absorbedInto: number[] = new Array(turns.length);

  // messageId -> requestId -> entries sharing both keys, in first-seen order.
  const byMessageId = new Map<string, Map<string, KeyedEntry[]>>();
  const messageIdOrder: string[] = [];

  turns.forEach((turn, index) => {
    const key = extractDedupKey(turn);
    if (key === undefined) {
      result[index] = turn;
      absorbedInto[index] = index;
      return;
    }
    let byRequestId = byMessageId.get(key.messageId);
    if (!byRequestId) {
      byRequestId = new Map();
      byMessageId.set(key.messageId, byRequestId);
      messageIdOrder.push(key.messageId);
    }
    const entry: KeyedEntry = { index, requestId: key.requestId, turn };
    const group = byRequestId.get(key.requestId);
    if (group) {
      group.push(entry);
    } else {
      byRequestId.set(key.requestId, [entry]);
    }
  });

  for (const messageId of messageIdOrder) {
    const byRequestId = byMessageId.get(messageId);
    if (!byRequestId) {
      continue;
    }

    const requestGroups = [...byRequestId.values()];
    const merged = requestGroups.map((group) => ({
      entries: group,
      firstIndex: Math.min(...group.map((entry) => entry.index)),
      turn: mergeStreamingSplit(group.map((entry) => entry.turn)),
    }));

    const anchorIndex = Math.min(...merged.map((m) => m.firstIndex));
    const winner =
      merged.length === 1
        ? merged[0]?.turn
        : pickSidechainWinner(merged.map((m) => m.turn));
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserve the empty-group guard for malformed input.
    if (winner !== undefined) {
      result[anchorIndex] = winner;
    }

    for (const m of merged) {
      for (const entry of m.entries) {
        absorbedInto[entry.index] = anchorIndex;
      }
    }
  }

  const slotToFinalIndex: number[] = new Array(turns.length);
  const finalTurns: Turn[] = [];
  for (let i = 0; i < result.length; i += 1) {
    const turn = result[i];
    if (turn === undefined) {
      continue;
    }
    slotToFinalIndex[i] = finalTurns.length;
    finalTurns.push(turn);
  }

  const indexMap = turns.map(
    (_, i) => slotToFinalIndex[absorbedInto[i] as number] as number
  );

  return { indexMap, turns: finalTurns };
}

/**
 * Dedups a Turn[] per DESIGN.md accounting rule 2. Pure, order-preserving,
 * idempotent (dedupTurns(dedupTurns(x)) toEqual dedupTurns(x) — a second pass
 * finds only singleton (message.id, requestId) groups, which merge/pick to
 * themselves). Thin wrapper over dedupTurnsWithMap for callers that don't
 * need the index map (e.g. a bare Turn[] with no owning Session/events).
 */
export function dedupTurns(turns: readonly Turn[]): Turn[] {
  return dedupTurnsWithMap(turns).turns;
}

/**
 * Dedups a Session's turns and remaps every CompactionEvent.turnIndex
 * through the resulting indexMap, so turnIndex stays positionally correct
 * against the now-deduped session.turns — see engine/composition.ts's
 * RESET_AT note and engine/compaction.ts's file header for why this
 * (not the bare dedupTurns) is the required entry point for any caller that
 * also consumes session.events. Other SessionEvent kinds carry no turnIndex
 * (model/types.ts) and pass through unchanged.
 *
 * A turnIndex equal to the PRE-dedup turns.length is the documented
 * one-past-the-end sentinel (adapters/claude/compaction.ts's
 * findNextTurnIndex: the marker was the last thing in the file, no
 * following turn) and remaps to the POST-dedup turns.length — indexMap has
 * no entry for an out-of-range index since it's built from the original
 * turns[] length.
 */
export function dedupSession(session: Session): Session {
  const { turns, indexMap } = dedupTurnsWithMap(session.turns);
  const preDedupLength = session.turns.length;

  const events = session.events.map((event) => {
    if (event.kind !== "compaction") {
      return event;
    }
    const turnIndex =
      event.turnIndex >= preDedupLength
        ? turns.length
        : (indexMap[event.turnIndex] as number);
    return { ...event, turnIndex };
  });

  return { ...session, events, turns };
}

// ---------------------------------------------------------------------------
// dedupFamily — cross-file extension (see file header)
// ---------------------------------------------------------------------------

function zeroNormalizedUsage(usage: NormalizedUsage): NormalizedUsage {
  return {
    ...usage,
    cacheRead: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    inputUncached: 0,
    output: 0,
    ...(usage.reasoningOutput === undefined ? {} : { reasoningOutput: 0 }),
  };
}

/**
 * Zeros every dollar component. `mode` is preserved (accounting.ts's own
 * "mode preserved" convention — see priceTurn); `priced` is forced to `true`
 * rather than left as-is. Rationale: a zeroed-out replay isn't real spend,
 * so it must not count against a family's all-or-nothing `priced` flag
 * (SessionTotals.priced) the way a genuinely-unpriced turn would.
 */
function zeroCostBreakdown(cost: CostBreakdown): CostBreakdown {
  return {
    cacheRead: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    input: 0,
    mode: cost.mode,
    output: 0,
    priced: true,
    total: 0,
  };
}

/**
 * POLICY DECISION: zeros usage AND cost AND contextTotal — not usage alone.
 * dedupFamily's documented callers (attribution.ts's bySubagent) consume
 * sessions that are already priced (module precondition); accounting.ts's
 * sessionTotals() sums turn.cost.total independently of turn.usage.*, so
 * leaving a replay's already-computed CostBreakdown untouched would still
 * double-count its dollar figure in family rollups even after its token
 * counts were zeroed — the exact class of bug this function exists to fix,
 * just moved from tokens to dollars. "Zero usage removes it from all
 * aggregation" (see file header) is read as covering both.
 *
 * contentSpans and composition are deliberately left untouched — per the
 * task spec, a session's own (non-family) view of itself must still show
 * this turn's real content/shape. This is a documented, intentional
 * violation of the `Σ categories + residual = contextTotal` invariant
 * (model/types.ts) for a zeroed turn: composition was computed against the
 * turn's ORIGINAL (pre-dedupFamily) contextTotal and is not recomputed here.
 */
function zeroOutTurn(turn: Turn): Turn {
  return {
    ...turn,
    contextTotal: 0,
    cost: zeroCostBreakdown(turn.cost),
    usage: zeroNormalizedUsage(turn.usage),
  };
}

/**
 * Dedups a family of Sessions (a parent main session plus its subagent
 * children, or any Session[] the caller has already resolved as one family)
 * across file boundaries. `sessions` order IS the precedence order: whichever
 * session comes first in the array is canonical for any message.id it
 * contains — matching is by message.id ALONE by design, since cross-file
 * replays may carry a different requestId than the original (engine review
 * finding 2, 2026-08-08: an earlier draft kept unreachable (id,requestId)
 * machinery; removed); every later
 * occurrence of that same key, in the SAME or a LATER session, has its
 * usage/cost ZEROED (not removed — removing would break that session's own
 * turnIndex/composition internals downstream; see dedupSession's header).
 * Events are untouched.
 *
 * Callers (e.g. attribution.ts's bySubagent) are documented to pass
 * `sessions[0]` as the parent (kind "main") and the rest as children — same
 * contract bySubagent already has. dedupFamily has NO way to verify that
 * itself: Session (model/types.ts) carries no `kind` field (only SessionRef
 * does), so this is purely POSITIONAL — sessions[0] wins ties, full stop.
 * A caller that passes a child-first array gets a child treated as
 * canonical instead of the true parent; that's a caller contract violation,
 * not something dedupFamily can detect or correct (documented explicitly —
 * see dedup-family.test.ts's ordering case).
 *
 * Each member is run through dedupSession first (reuses the per-file case;
 * a no-op if the caller already deduped). Idempotent: a second dedupFamily
 * pass sees the same first-occurrence winners (their raw message.id is
 * untouched by zeroing) and re-zeros the same already-zero losers.
 */
export function dedupFamily(sessions: readonly Session[]): Session[] {
  const perFile = sessions.map((session) => dedupSession(session));

  const seenMessageId = new Set<string>();

  return perFile.map((session) => ({
    ...session,
    turns: session.turns.map((turn) => {
      if (turn.role !== "assistant") {
        return turn;
      }
      const messageId = rawMessageId(turn);
      if (messageId === undefined) {
        return turn;
      }

      if (seenMessageId.has(messageId)) {
        return zeroOutTurn(turn);
      }

      seenMessageId.add(messageId);
      return turn;
    }),
  }));
}
