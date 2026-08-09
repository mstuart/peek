// Composition engine (T2.3) — docs/DESIGN.md § "Accounting rules" rule 5 +
// § "Unified Session Model" Composition/CompositionCategory/Span (frozen).
//
// computeComposition is an ACCUMULATOR over a session's turns, walked in
// order: each turn's own contentSpans add to a running per-category char
// total (char/4, PLAN rule 5's estimation basis), accumulated from the
// start of the current "compaction phase" through that turn. The phase
// resets to empty at each CompactionEvent boundary (matched by
// CompactionEvent.turnIndex against this same turns[] — see RESET_AT below
// for a known cross-module limitation in that matching), after which the
// compaction summary's own span (already attached to the landing turn's
// contentSpans per parse.ts's ATTACHMENT CONVENTION) naturally reseeds the
// new phase as the first thing added — no special-casing needed here.
//
// SESSION-LEVEL SEED (2026-08-08 fix): each phase does NOT start fully
// empty — initCompositionAccumulator(session.configSnapshot) seeds
// systemPrompt/toolSchemas from the session's configSnapshot at the start of
// every phase (initial + every reset), since those are resent on every
// request and so persist across compactions. See that function's doc
// comment for what is and isn't seeded and why.
//
// Precondition (audit R3-F1): callers MUST run dedup.ts's dedupTurns() over
// session.turns before calling this — composition consumes DEDUPED turns,
// never raw parse output (mirrors accounting.ts's precondition on
// priceSession). This module does not dedup for you and has no way to
// detect an undeduped session.
//
// THINKING EXCLUSION (audit R2-C2, PLAN's CompositionCategory rule): on
// claude-code and pi, thinking content is stripped on resend / is pure
// output, so it never becomes future input — categories.thinking is forced
// to 0 by simply never folding "thinking"-category spans into the
// accumulator for those two harnesses. On codex, the Responses API resends
// reasoning items, so plaintext reasoning-summary spans (tagged "thinking"
// by the codex adapter) DO accumulate here like any other category.
// Encrypted reasoning content has no span at all (unmeasurable at parse
// time) and so is invisible to this accumulator — it lands in residual,
// per PLAN's residual definition. This codex behavior is UNVERIFIED (PLAN
// risk 2) pending Phase 4's empirical measurement; implemented per the
// orchestrator-approved rule, not yet confirmed against real codex logs.

import type {
  Composition,
  CompositionCategory,
  HarnessId,
  Session,
  Turn,
} from "../model/types.js";

const COMPOSITION_CATEGORIES: readonly CompositionCategory[] = [
  "userText",
  "assistantText",
  "thinking",
  "toolResults",
  "toolCallArgs",
  "instructionInjection",
  "systemPrompt",
  "toolSchemas",
  "compactionSummaries",
  "coordination",
];

function zeroCategories(): Record<CompositionCategory, number> {
  const categories = {} as Record<CompositionCategory, number>;
  for (const category of COMPOSITION_CATEGORIES) categories[category] = 0;
  return categories;
}

function zeroComposition(): Composition {
  return {
    categories: zeroCategories(),
    residual: 0,
    residualShare: 0,
    truncated: false,
  };
}

/**
 * Running state the accumulator carries turn-to-turn within one compaction
 * phase; a fresh instance replaces it at each CompactionEvent boundary.
 * Exported so tests can drive accumulateTurnComposition directly.
 */
export interface CompositionAccumulatorState {
  runningChars: Record<CompositionCategory, number>;
  truncatedSoFar: boolean;
}

/**
 * Seeds a fresh accumulator from a session's configSnapshot (measured fix,
 * 2026-08-08: on the real codex capture, 30,599 of 37,476 residual tokens
 * were unexplained, of which ~5.6k is the system prompt — logged verbatim in
 * configSnapshot.systemPrompt but never folded into the running totals).
 * `configSnapshot` is passed at EVERY phase start (both the initial call and
 * every post-CompactionEvent reset in computeComposition below) because the
 * system prompt and tool schemas are resent on every request — they persist
 * across compactions exactly like any other harness-level constant, so each
 * new phase needs its own copy of the seed rather than inheriting one.
 *
 * Only systemPrompt/toolSchemas are seeded here:
 *   - systemPrompt: char basis is configSnapshot.systemPrompt's own length
 *     (codex only — types.ts documents the field as "codex only (logged
 *     verbatim); empty elsewhere", and claude/pi's adapters never populate
 *     it, so this seeds 0 there and leaves those harnesses' behavior
 *     unchanged).
 *   - toolSchemas: configSnapshot.toolSchemas is the already-JSON.stringify'd
 *     flattened tool array (see adapters/codex/meta.ts); its raw .length is
 *     used as the char basis directly rather than re-summing per-tool
 *     description/inputSchema text, which makes this a slight OVER-estimate
 *     (JSON punctuation — braces, quotes, commas — counts toward chars that
 *     aren't tool content). Accepted per the orchestrator: it's a labeled
 *     ~estimate like every other category here, not an exact accounting.
 *
 * projectInstructions/instructionInjection are deliberately NOT seeded from
 * configSnapshot even though codex's TurnContextInfo carries
 * projectInstructions (AGENTS.md / user_instructions) alongside
 * systemPrompt: that same AGENTS.md content also arrives as an in-stream
 * instructionInjection span on the turns that reference it (both on codex
 * and on claude, per the parse.ts ATTACHMENT CONVENTION), so seeding it here
 * on top of that span would double-count the identical content — the same
 * audit-style reasoning as rule 5's toolUseResult-vs-inline-tool_result
 * "exactly one source" rule for tool results.
 */
export function initCompositionAccumulator(
  configSnapshot?: Session["configSnapshot"],
): CompositionAccumulatorState {
  const runningChars = zeroCategories();
  if (configSnapshot?.systemPrompt) {
    runningChars.systemPrompt = configSnapshot.systemPrompt.length;
  }
  if (configSnapshot?.toolSchemas) {
    runningChars.toolSchemas = configSnapshot.toolSchemas.length;
  }
  return { runningChars, truncatedSoFar: false };
}

/**
 * Folds one turn's own contentSpans into `state` (mutated in place, for
 * cheap chaining across a turns[] walk) and returns the Composition that
 * turn carries, per the accumulator semantics above.
 *
 * Rule 6 (turns with contextTotal === 0 — e.g. isApiErrorMessage records,
 * or pi's non-assistant turns which never carry usage): the turn's own
 * spans still fold into `state` for LATER turns to inherit (they're real
 * content that happened), but THIS turn's own composition reads all-zero /
 * residual-0 rather than the computed accumulation — there's no real
 * contextTotal to reconcile a nonzero categories sum against without
 * breaking the Σ categories + residual = contextTotal invariant this
 * exists to satisfy.
 */
export function accumulateTurnComposition(
  state: CompositionAccumulatorState,
  turn: Pick<Turn, "contentSpans" | "contextTotal">,
  harness: HarnessId,
): Composition {
  for (const span of turn.contentSpans) {
    if (span.category === "thinking" && harness !== "codex") continue;
    state.runningChars[span.category] += span.charCount;
    if (span.truncated) state.truncatedSoFar = true;
  }

  if (turn.contextTotal === 0) return zeroComposition();

  const categories = {} as Record<CompositionCategory, number>;
  let sum = 0;
  for (const category of COMPOSITION_CATEGORIES) {
    const value = Math.ceil(state.runningChars[category] / 4);
    categories[category] = value;
    sum += value;
  }
  const residual = turn.contextTotal - sum; // never clamped — may be negative (PLAN rule, over-estimation is measured, not hidden)
  return {
    categories,
    residual,
    residualShare: residual / turn.contextTotal,
    truncated: state.truncatedSoFar,
  };
}

/**
 * Computes per-turn Composition for every turn in `session`, per
 * docs/DESIGN.md rule 5. Expects `session.turns` to already be DEDUPED (see
 * precondition note above). Pure — does not mutate its input.
 *
 * RESET_AT: CompactionEvent.turnIndex is matched positionally against
 * `session.turns` — the same array this function walks. Adapters compute
 * turnIndex against their OWN pre-dedup turns[], so the session passed in
 * here MUST have gone through engine/dedup.ts's dedupSession() (not the
 * bare dedupTurns()) — dedupSession remaps every CompactionEvent.turnIndex
 * through the same indexMap used to dedup session.turns, which is what
 * keeps this positional match correct.
 */
export function computeComposition(session: Session): Session {
  const resetAt = new Set(
    session.events
      .filter((event) => event.kind === "compaction")
      .map((event) => event.turnIndex),
  );

  let state = initCompositionAccumulator(session.configSnapshot);
  const turns = session.turns.map((turn, index) => {
    if (resetAt.has(index)) {
      state = initCompositionAccumulator(session.configSnapshot);
    }
    const composition = accumulateTurnComposition(state, turn, session.harness);
    return { ...turn, composition };
  });

  return { ...session, turns };
}
