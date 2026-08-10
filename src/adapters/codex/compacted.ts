// Codex `compacted` record + `context_compacted` marker -> CompactionEvent
// (T4.5). See docs/recon/codex.md § "compacted records" and § event_msg's
// `context_compacted` entry; docs/DESIGN.md § "Compaction detection".
//
// Fills what codex logs directly at parse time (turnIndex, lineage,
// summaryTokensEst) and leaves tokensBeforeExact/tokensAfterExact/
// shrinkExact/discardedEst null for engine/compaction.ts's finalizeCompactions
// to complete later, following pi's exact precedent (adapters/pi/parse.ts's
// buildCompactionEvent leaves the same fields null) rather than claude-code's
// (which anchors immediately because its own events are already fully
// computed by parse time — see engine/compaction.ts's file header). Adapters
// must not import engine/ (engine may depend on adapter-agnostic types only,
// never the reverse) — codex previously imported engine/compaction.ts's
// findTokensBefore to anchor tokensBeforeExact here itself; that was the
// only adapter->engine import in the codebase and has been removed in favor
// of this null-and-let-engine-finalize approach.
//
// RULE (types.ts): adapters never throw on malformed/unknown records — warn
// and continue.

import type { CompactionEvent, Turn } from "../../model/types.js";

function prop(raw: unknown, key: string): unknown {
  if (typeof raw !== "object" || raw === null) {
    return;
  }
  return (raw as Record<string, unknown>)[key];
}

/**
 * `compacted` line-type record -> CompactionEvent.
 *
 * - `turnIndex` = `turns.length` at the moment this record is encountered —
 *   the pi/claude-code precedent for "the index of the first turn built
 *   after the marker" (one past the last turn already built; a documented
 *   sentinel when nothing follows in the file, as in
 *   test/fixtures/codex/v0.134/compaction.jsonl).
 * - `tokensBeforeExact`: codex's `compacted` record itself carries no
 *   before/after token counts (unlike pi's CompactionEntry, which logs
 *   `tokensBefore` directly) — left null here, same as pi, for
 *   engine/compaction.ts's finalizeCompactions to fill by walking `turns`
 *   backward from turnIndex for the last turn with real (non-zero) usage
 *   (its `findTokensBefore` helper — the one place every harness's
 *   finalization funnels through, so there is exactly one copy of this
 *   anchoring loop rather than one per adapter).
 * - `tokensAfterExact`/`shrinkExact`/`discardedEst`: left null — engine
 *   fills tokensAfterExact from the first real-usage turn at-or-after
 *   turnIndex once the full session (post-dedup) is available, then computes
 *   the deltas. Not derivable here: codex's post-compaction token_count, if
 *   any, may land on a turn built later in the SAME file (fine, engine's
 *   turn-walk finds it) or may never attach to any turn at all (orphaned —
 *   see usage.ts's "orphan-token-count" case, which is exactly what happens
 *   in compaction.jsonl: no response_item follows the compacted record, so
 *   its post-compaction token_count has no turn to attach to and engine
 *   finalize also leaves tokensAfterExact null for that fixture. This is a
 *   real, documented v1 gap, not a bug: only a compaction followed by at
 *   least one more assistant turn before the file ends yields a non-null
 *   tokensAfterExact).
 * - `cost`: null — codex doesn't log the summarization call as a separate
 *   priced usage record (same rationale as claude-code's compaction.ts).
 * - Window lineage (`window_number`/`window_id`/`previous_window_id`/
 *   `first_window_id`) is populated into CompactionEvent.lineage (v2, Lane
 *   F3 — types.ts's lineage field). Each sub-field is included only when the
 *   record actually logs it (older codex builds may omit some).
 */
export function buildCompactionEventFromCompactedRecord(
  payload: unknown,
  at: Date,
  turns: readonly Turn[]
): CompactionEvent {
  const message = prop(payload, "message");
  const summaryText = typeof message === "string" ? message : "";
  const turnIndex = turns.length;

  const windowNumber = prop(payload, "window_number");
  const windowId = prop(payload, "window_id");
  const previousWindowId = prop(payload, "previous_window_id");
  const firstWindowId = prop(payload, "first_window_id");
  const lineage: CompactionEvent["lineage"] = {};
  if (typeof windowNumber === "number") {
    lineage.windowNumber = windowNumber;
  }
  if (typeof windowId === "string") {
    lineage.windowId = windowId;
  }
  if (typeof previousWindowId === "string") {
    lineage.previousWindowId = previousWindowId;
  }
  if (typeof firstWindowId === "string") {
    lineage.firstWindowId = firstWindowId;
  }

  return {
    at,
    cost: null,
    discardedEst: null, // engine computes
    kind: "compaction",
    shrinkExact: null, // engine computes (before − after)
    summaryTokensEst: Math.ceil(summaryText.length / 4),
    tokensAfterExact: null, // engine fills from the next turn's contextTotal
    tokensBeforeExact: null, // engine fills via findTokensBefore
    turnIndex,
    ...(Object.keys(lineage).length > 0 ? { lineage } : {}),
  };
}

/**
 * The zero-field `context_compacted` event_msg marker, standing alone (no
 * adjacent `compacted` record consumed it — see parse.ts's adjacency
 * tracking): produces a minimal CompactionEvent carrying only `at`/
 * `turnIndex`, everything else null/zero. This is the legacy/fallback case
 * documented in docs/recon/codex.md — no local sample has ever shown this
 * marker appearing WITHOUT an adjacent `compacted` record, so it is
 * exercised only defensively (no fixture case), matching the task's
 * "document" framing rather than a "test" requirement.
 */
export function buildMinimalCompactionEventFromMarker(
  at: Date,
  turns: readonly Turn[]
): CompactionEvent {
  return {
    at,
    cost: null,
    discardedEst: null,
    kind: "compaction",
    shrinkExact: null,
    summaryTokensEst: 0,
    tokensAfterExact: null,
    tokensBeforeExact: null,
    turnIndex: turns.length,
  };
}
