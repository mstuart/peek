// Claude Code compaction-event normalization (T1.5).
//
// One CompactionEvent per `isCompactSummary` record, anchored against the
// Turns already built by parse.ts, per docs/DESIGN.md § "Compaction detection"
// and the frozen CompactionEvent semantics in model/types.ts (audit R1-C2).
//
// Anchoring walks Turns (one per assistant record) by their originating
// record's line number relative to the marker's line — not by turn index —
// because turns[] here is raw parse output (pre-dedup); line number is the
// stable, unambiguous position signal.

import type { CompactionEvent } from "../../model/types.js";
import type { RawClaudeRecord } from "./records.js";

/** The subset of a built Turn's identity anchoring needs, keyed by source line. */
export interface AnchorableTurn {
  contextTotal: number;
  isApiError: boolean;
  line: number;
}

function isRealUsageTurn(turn: AnchorableTurn): boolean {
  return turn.contextTotal !== 0 && !turn.isApiError;
}

/**
 * Last real-usage turn strictly before the marker line, skipping zero-usage
 * and `isApiErrorMessage` turns (audit R1-C2's anchoring trap: an adjacent
 * all-zero-usage error record must not be read as "context reset to 0").
 */
export function findTokensBefore(
  turns: readonly AnchorableTurn[],
  markerLine: number
): number | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i] as AnchorableTurn;
    if (turn.line < markerLine && isRealUsageTurn(turn)) {
      return turn.contextTotal;
    }
  }
  return null;
}

/** First real-usage turn strictly after the marker line (includes the fresh summary). */
export function findTokensAfter(
  turns: readonly AnchorableTurn[],
  markerLine: number
): number | null {
  for (const turn of turns) {
    if (turn.line > markerLine && isRealUsageTurn(turn)) {
      return turn.contextTotal;
    }
  }
  return null;
}

/**
 * turnIndex convention: the index (into the same turns[] this was built
 * from) of the first turn built after the marker — i.e. the turn whose
 * contentSpans carry this marker's compactionSummaries span (parse.ts
 * attaches a user record's spans to the next assistant Turn). When the
 * marker is the last thing in the file (no following assistant turn),
 * turnIndex is turns.length — one past the end, a documented sentinel.
 */
export function findNextTurnIndex(
  turns: readonly AnchorableTurn[],
  markerLine: number
): number {
  const idx = turns.findIndex((turn) => turn.line > markerLine);
  return idx === -1 ? turns.length : idx;
}

/**
 * shrinkExact / discardedEst per the PLAN worked example: shrinkExact is the
 * exact net reduction (before − after); discardedEst adds the summary's own
 * size back (it's new text living inside `after`, not part of what was
 * discarded from the original). Both null unless before/after are both known.
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
 * Builds one CompactionEvent for an `isCompactSummary` record. `at` is
 * passed in (parse.ts already parses record timestamps; no need to
 * duplicate that here). `summaryContent` is the same canonical text used
 * for the record's compactionSummaries span, so summaryTokensEst is
 * consistent with what composition.ts will later sum. Cost is always null —
 * Claude Code doesn't log the summarization call as a separate usage record.
 */
export function buildCompactionEvent(
  markerRecord: RawClaudeRecord,
  at: Date,
  summaryContent: string,
  turns: readonly AnchorableTurn[]
): CompactionEvent {
  const tokensBeforeExact = findTokensBefore(turns, markerRecord.line);
  const tokensAfterExact = findTokensAfter(turns, markerRecord.line);
  const summaryTokensEst = Math.ceil(summaryContent.length / 4);
  const { shrinkExact, discardedEst } = computeCompactionDeltas(
    tokensBeforeExact,
    tokensAfterExact,
    summaryTokensEst
  );

  return {
    at,
    cost: null,
    discardedEst,
    kind: "compaction",
    shrinkExact,
    summaryTokensEst,
    tokensAfterExact,
    tokensBeforeExact,
    turnIndex: findNextTurnIndex(turns, markerRecord.line),
  };
}
