// Compaction normalization (T2.4) — docs/DESIGN.md § "Compaction detection".
//
// Adapters attach as much of a CompactionEvent as they can measure at parse
// time (claude-code's adapters/claude/compaction.ts fills every field from
// its own anchoring pass; pi's adapters/pi/parse.ts fills only
// tokensBeforeExact from the CompactionEntry's `tokensBefore` field, leaving
// tokensAfterExact/shrinkExact/discardedEst null per its own file-header
// note). finalizeCompactions is the one place that COMPLETES whatever a
// given adapter left null, using the same anchoring rule every adapter
// already applies: the first/last turn with real (non-zero) usage, walked
// from the event's turnIndex. It never recomputes a field an adapter already
// filled — idempotent by construction (see the idempotence test in
// test/unit/compaction-attribution.test.ts).
//
// Precondition: callers should run this AFTER dedup.ts's dedupTurns() (the
// turnIndex an adapter recorded is only positionally meaningful against the
// turns[] shape it was computed from — see engine/composition.ts's RESET_AT
// note for the same cross-module index-space caveat; claude-code sidesteps
// it here because its events are already fully computed by parse time, so
// this module never needs to walk turns[] for a claude-code session).

import type {
  CompactionEvent,
  Session,
  SessionEvent,
  Turn,
} from "../model/types.js";

function isRealUsageTurn(turn: Pick<Turn, "contextTotal">): boolean {
  return turn.contextTotal !== 0;
}

/** Last real-usage turn strictly before `beforeIndex`, skipping zero-usage turns. */
export function findTokensBefore(
  turns: readonly Turn[],
  beforeIndex: number
): number | null {
  for (let i = Math.min(beforeIndex, turns.length) - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn && isRealUsageTurn(turn)) {
      return turn.contextTotal;
    }
  }
  return null;
}

/**
 * First real-usage turn at-or-after `fromIndex`, skipping zero-usage turns.
 * Inclusive of `fromIndex` itself: an adapter's turnIndex convention is
 * "the index of the first turn built after the marker" (both claude-code's
 * and pi's adapters document this), so that turn IS the candidate to check
 * first, not one past it.
 */
export function findTokensAfter(
  turns: readonly Turn[],
  fromIndex: number
): number | null {
  for (let i = Math.max(fromIndex, 0); i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn && isRealUsageTurn(turn)) {
      return turn.contextTotal;
    }
  }
  return null;
}

/**
 * shrinkExact / discardedEst per the PLAN worked example (docs/DESIGN.md §
 * "Compaction detection"): tokensBeforeExact 844,000, tokensAfterExact
 * 54,437, summaryTokensEst 30,581 -> shrinkExact 789,563, discardedEst
 * 820,144. Both null unless before/after are both known. Duplicated (not
 * imported) from adapters/claude/compaction.ts's identical helper — engine/
 * must not depend on a specific adapter, and this is the one place every
 * harness's finalization funnels through.
 */
export function computeCompactionDeltas(
  tokensBeforeExact: number | null,
  tokensAfterExact: number | null,
  summaryTokensEst: number
): { shrinkExact: number | null; discardedEst: number | null } {
  if (tokensBeforeExact === null || tokensAfterExact === null) {
    return { discardedEst: null, shrinkExact: null };
  }
  return {
    discardedEst: tokensBeforeExact - tokensAfterExact + summaryTokensEst,
    shrinkExact: tokensBeforeExact - tokensAfterExact,
  };
}

/**
 * Completes one CompactionEvent against `turns` (the session's — already-
 * deduped — turns[]). Null tokensBeforeExact/tokensAfterExact are filled via
 * the anchoring rule above; already-non-null values are never overwritten.
 * shrinkExact/discardedEst are (re)computed only when not already set by the
 * adapter (event.shrinkExact === null) — once an adapter (or a prior call to
 * this function) has computed them, they are left exactly as-is, which is
 * what makes finalizeCompactions idempotent.
 */
export function finalizeCompactionEvent(
  event: CompactionEvent,
  turns: readonly Turn[]
): CompactionEvent {
  const tokensBeforeExact =
    event.tokensBeforeExact ?? findTokensBefore(turns, event.turnIndex);
  const tokensAfterExact =
    event.tokensAfterExact ?? findTokensAfter(turns, event.turnIndex);

  if (event.shrinkExact !== null) {
    // Already computed (by an adapter, or a previous finalize pass) —
    // leave the deltas untouched; only backfill before/after if somehow
    // still null (defensive; not reachable from any current adapter).
    return { ...event, tokensAfterExact, tokensBeforeExact };
  }

  const { shrinkExact, discardedEst } = computeCompactionDeltas(
    tokensBeforeExact,
    tokensAfterExact,
    event.summaryTokensEst
  );
  return {
    ...event,
    discardedEst,
    shrinkExact,
    tokensAfterExact,
    tokensBeforeExact,
  };
}

function isCompactionEvent(event: SessionEvent): event is CompactionEvent {
  return event.kind === "compaction";
}

/**
 * Completes every CompactionEvent in `session.events` (see file header for
 * the anchoring rule and idempotence guarantee). Pure — returns a new
 * Session; does not mutate its input. Non-compaction events pass through
 * unchanged.
 */
export function finalizeCompactions(session: Session): Session {
  const events = session.events.map((event) =>
    isCompactionEvent(event)
      ? finalizeCompactionEvent(event, session.turns)
      : event
  );
  return { ...session, events };
}
