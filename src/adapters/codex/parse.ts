// Codex session parser — SKELETON (T4.3) + response_item assembly (T4.4) +
// usage/compaction (T4.5).
//
// Scope: session_meta + turn_context (T4.3), response_item variants
// (message/reasoning/function_call/... -> Turns, T4.4, via items.ts),
// event_msg token_count -> usage + `compacted`/`context_compacted` ->
// CompactionEvent (T4.5, via usage.ts/compacted.ts). `events` carries
// turn_context-derived model-change ModeChanges plus CompactionEvents.
//
// RULE (types.ts): adapters never throw on malformed/unknown records — warn
// and continue. Only an unreadable file rejects.

import type {
  CompactionEvent,
  ModeChange,
  ParseResult,
  ParseWarning,
  Session,
  SessionEvent,
  SessionRef,
  Turn,
} from "../../model/types.js";
import {
  buildCompactionEventFromCompactedRecord,
  buildMinimalCompactionEventFromMarker,
} from "./compacted.js";
import { buildResponseItemTurn, createCodexItemState } from "./items.js";
import {
  type TurnContextInfo,
  extractSessionMeta,
  extractTurnContext,
} from "./meta.js";
import { type RawCodexRecord, readCodexRecords } from "./records.js";
import {
  checkCumulativeCrossCheck,
  createCodexUsageState,
  handleEventMsg,
} from "./usage.js";

/**
 * Extra state accumulated while building the skeleton, exposed alongside
 * the ParseResult-shaped {session, warnings} for T4.4/T4.5 to extend
 * without re-deriving it — NOT part of the public ParseResult (types.ts's
 * ParseResult is frozen to {session, warnings}; do not thread these fields
 * onto Session/ParseResult directly).
 *
 * `turnContexts` is every turn_context seen, in file order (re-emitted
 * turn_contexts after mid-turn compaction all land here). Each entry's
 * `truncationLimitBytes` is what T4.4 needs to decide whether the
 * projectInstructions Span it builds should be marked `truncated` (compare
 * the sourced text's byte length against the limit recorded on the
 * turn_context that supplied it).
 */
export interface CodexParseState {
  turnContexts: TurnContextInfo[];
}

export interface ParseCodexSessionOptions {
  /** See claude/parse.ts's ParseClaudeSessionOptions — same contract: false
   * skips content-span extraction (turns get contentSpans: []); usage/cost/
   * events/compaction are unaffected. Default true. */
  spans?: boolean;
}

function prop(raw: unknown, key: string): unknown {
  if (typeof raw !== "object" || raw === null) return undefined;
  return (raw as Record<string, unknown>)[key];
}

/**
 * Builds the Session skeleton from session_meta + turn_context records
 * only, returning the internal parse state alongside so downstream tasks
 * can extend the same pass instead of re-reading the file.
 */
export async function buildSessionSkeleton(
  ref: SessionRef,
  opts: ParseCodexSessionOptions = {},
): Promise<{
  session: Session;
  warnings: ParseWarning[];
  state: CodexParseState;
}> {
  const spansEnabled = opts.spans ?? true;
  const { records, warnings: readWarnings } = await readCodexRecords(ref.path);
  const warnings: ParseWarning[] = [...readWarnings];

  let harnessVersion = "";
  let cwd = ref.cwd ?? "";
  let gitBranch: string | undefined;
  let systemPrompt: string | undefined;
  let toolSchemas: string | undefined;
  let sessionMetaModel: string | undefined;
  let sawSessionMeta = false;

  let startedAt: Date | undefined;
  let endedAt: Date | undefined;

  const events: SessionEvent[] = [];
  const turns: Turn[] = [];
  const state: CodexParseState = { turnContexts: [] };
  const itemState = createCodexItemState();
  const usageState = createCodexUsageState();
  let currentModel: string | undefined;
  let projectInstructions: string | undefined;
  // Set right after a `compacted` line-type record is processed; consumed
  // (and reset) by the next `context_compacted` event_msg marker, which is
  // then skipped as redundant — see compacted.ts's file header. If a
  // `context_compacted` marker arrives with this flag false, no `compacted`
  // record preceded it, so it stands alone and gets the minimal-event
  // fallback.
  let pendingCompactedRecordConsumesNextMarker = false;

  for (const record of records) {
    if (record.timestamp) {
      if (!startedAt) startedAt = record.timestamp;
      endedAt = record.timestamp;
    }

    if (record.type === "session_meta") {
      // First session_meta wins — codex sessions carry exactly one, at
      // line 1, in every local sample.
      if (!sawSessionMeta) {
        sawSessionMeta = true;
        const meta = extractSessionMeta(record.payload);
        harnessVersion = meta.harnessVersion;
        if (meta.cwd) cwd = meta.cwd;
        gitBranch = meta.gitBranch;
        systemPrompt = meta.systemPrompt;
        toolSchemas = meta.toolSchemas;
        sessionMetaModel = meta.model;
        if (!startedAt) startedAt = meta.startedAt;
      }
      continue;
    }

    if (record.type === "turn_context") {
      const info = extractTurnContext(record.payload);
      state.turnContexts.push(info);

      if (info.projectInstructions !== undefined) {
        projectInstructions = info.projectInstructions;
      }

      if (info.model !== undefined) {
        // Only a REAL prior model (from an earlier turn_context) makes a
        // transition meaningful — the initial "unknown"/session_meta
        // sentinel is not a genuine prior state, so no ModeChange fires on
        // the first turn_context that supplies a model.
        if (currentModel !== undefined && info.model !== currentModel) {
          const change: ModeChange = {
            kind: "modeChange",
            at: record.timestamp ?? endedAt ?? new Date(0),
            field: "model",
            from: currentModel,
            to: info.model,
          };
          events.push(change);
        }
        currentModel = info.model;
      }
      continue;
    }

    if (record.type === "response_item") {
      const turn = buildResponseItemTurn(
        record,
        itemState,
        currentModel ?? sessionMetaModel ?? "unknown",
        state.turnContexts.at(-1),
        warnings,
        spansEnabled,
      );
      if (turn) turns.push(turn);
    }

    if (record.type === "event_msg") {
      const type = prop(record.payload, "type");
      if (type === "context_compacted") {
        if (pendingCompactedRecordConsumesNextMarker) {
          // Redundant with the `compacted` record just processed — skip.
          pendingCompactedRecordConsumesNextMarker = false;
        } else {
          const event = buildMinimalCompactionEventFromMarker(
            record.timestamp ?? endedAt ?? new Date(0),
            turns,
          );
          events.push(event);
        }
        continue;
      }

      handleEventMsg(record.payload, turns, usageState, warnings, record.line);
      continue;
    }

    if (record.type === "compacted") {
      const event: CompactionEvent = buildCompactionEventFromCompactedRecord(
        record.payload,
        record.timestamp ?? endedAt ?? new Date(0),
        turns,
      );
      events.push(event);
      pendingCompactedRecordConsumesNextMarker = true;
    }

    // inter_agent_* / world_state / unknown-line-type records: no fields
    // are read here — `readCodexRecords` already warned on genuinely
    // unrecognized line types, and the recon documents no consumer-relevant
    // content in inter_agent_communication(_metadata)/world_state for v1.
  }

  checkCumulativeCrossCheck(turns, usageState, warnings);

  const model = currentModel ?? sessionMetaModel ?? "unknown";

  const session: Session = {
    harness: "codex",
    harnessVersion,
    id: ref.id,
    cwd,
    ...(gitBranch !== undefined ? { gitBranch } : {}),
    startedAt: startedAt ?? new Date(0),
    endedAt: endedAt ?? startedAt ?? new Date(0),
    configSnapshot: {
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(projectInstructions !== undefined ? { projectInstructions } : {}),
      ...(toolSchemas !== undefined ? { toolSchemas } : {}),
      model,
      modelChanges: events.filter(
        (event): event is ModeChange => event.kind === "modeChange",
      ),
    },
    turns,
    events,
    children: [], // no on-disk codex subagent linkage discoverable from the JSONL tree
    warnings,
  };

  return { session, warnings, state };
}

export async function parseCodexSession(
  ref: SessionRef,
  opts: ParseCodexSessionOptions = {},
): Promise<ParseResult> {
  const { session, warnings } = await buildSessionSkeleton(ref, opts);
  return { session, warnings };
}
