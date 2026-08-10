// Codex response_item -> Turn/Span extraction (T4.4).
//
// Turn assembly: ONE Turn per response_item record — no merging of
// consecutive same-role items, no dedup (codex doesn't repeat usage, per
// docs/DESIGN.md T4.4's resolution of the "how do items become
// turns" question: "one Turn per item is simplest and matches Claude
// precedent"). This differs from claude/parse.ts's "attach pending user
// spans to the next assistant Turn" convention: Codex's response_item
// stream already gives each item its own well-formed unit
// (message/reasoning/function_call/...), so there is no analogous
// "trailing content with nothing to attach to" problem to solve.
//
// Usage/composition/cost are all zeroed here per task scope — T4.5 attaches
// real usage from token_count events; composition math (engine) and pricing
// are downstream stages, same as every other adapter's skeleton Turns.
// `usage.raw` is the response_item's own payload (not the whole record),
// per the T4.4 task spec.
//
// RULE (types.ts): adapters never throw on malformed/unknown records — warn
// and continue.

import { contextTotal } from "../../model/normalize.js";
import type {
  Composition,
  CompositionCategory,
  CostBreakdown,
  NormalizedUsage,
  ParseWarning,
  Span,
  Turn,
  TurnRole,
} from "../../model/types.js";
import type { TurnContextInfo } from "./meta.js";
import type { RawCodexRecord } from "./records.js";

const SPAN_TEXT_CAP = 2000;

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

function zeroComposition(): Composition {
  const categories = {} as Record<CompositionCategory, number>;
  for (const category of COMPOSITION_CATEGORIES) {
    categories[category] = 0;
  }
  return { categories, residual: 0, residualShare: 0, truncated: false };
}

// T2.2-equivalent (engine) fills real cost figures; mode "auto" / priced:false
// marks these as not-yet-priced rather than "priced at zero".
function zeroCost(): CostBreakdown {
  return {
    cacheRead: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    input: 0,
    mode: "auto",
    output: 0,
    priced: false,
    total: 0,
  };
}

function zeroUsage(raw: unknown): NormalizedUsage {
  return {
    cacheRead: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    inputUncached: 0,
    output: 0,
    raw,
  };
}

function prop(raw: unknown, key: string): unknown {
  if (typeof raw !== "object" || raw === null) {
    return;
  }
  return (raw as Record<string, unknown>)[key];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function makeSpan(
  category: CompositionCategory,
  text: string,
  turnRole: TurnRole,
  truncated: boolean,
  extra?: { toolName?: string; mcpServer?: string }
): Span {
  const charCount = text.length;
  return {
    category,
    charCount,
    ...(charCount <= SPAN_TEXT_CAP ? { text } : {}),
    truncated,
    turnRole,
    ...(extra?.toolName === undefined ? {} : { toolName: extra.toolName }),
    ...(extra?.mcpServer === undefined ? {} : { mcpServer: extra.mcpServer }),
  };
}

function skeletonTurn(
  role: TurnRole,
  model: string,
  timestamp: Date,
  spans: Span[],
  usageRaw: unknown
): Turn {
  const usage = zeroUsage(usageRaw);
  return {
    composition: zeroComposition(),
    contentSpans: spans,
    contextTotal: contextTotal(usage),
    cost: zeroCost(),
    model,
    role,
    timestamp,
    usage,
  };
}

function textFromContentItem(item: unknown): string | undefined {
  return str(prop(item, "text"));
}

/**
 * `user`-role message text is one of three documented shapes
 * (docs/recon/codex.md § response_item variants): AGENTS.md injection
 * ("# AGENTS.md instructions for <cwd>", observed WRAPPED in an
 * `<INSTRUCTIONS>` tag in the real 0.88-vintage fixture — both the wrapper
 * prefix and the unwrapped prefix are checked since the recon documents the
 * wrapped form but the task spec's shorthand names only the unwrapped
 * one — this covers both without inventing a third shape), the synthetic
 * `<environment_context>` block, or the actual task text (fallback).
 * `truncated` is set when the current turn_context's byte truncation limit
 * is at-or-below this text's length — the 10KB `user_instructions` cap
 * (docs/DESIGN.md accounting rule 5) means the AGENTS.md content itself was
 * (or could have been) cut off before being echoed into this message.
 */
const AGENTS_INJECTION_PREFIXES = [
  "<INSTRUCTIONS>",
  "# AGENTS.md instructions",
];
const ENVIRONMENT_CONTEXT_PREFIX = "<environment_context>";

function classifyUserMessageText(
  text: string,
  turnContext: TurnContextInfo | undefined
): Span {
  const trimmed = text.trimStart();
  if (AGENTS_INJECTION_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    const limit = turnContext?.truncationLimitBytes;
    const truncated = limit !== undefined && limit <= text.length;
    return makeSpan("instructionInjection", text, "user", truncated);
  }
  if (trimmed.startsWith(ENVIRONMENT_CONTEXT_PREFIX)) {
    return makeSpan("instructionInjection", text, "user", false);
  }
  return makeSpan("userText", text, "user", false);
}

/**
 * `message` variant -> one Turn. `developer` = sandbox/permission text
 * (always instructionInjection); `assistant` = model output (assistantText,
 * from `output_text` content items only); `user` = classified per
 * classifyUserMessageText above. Content items are filtered to the
 * role-appropriate wire type (`input_text` for developer/user,
 * `output_text` for assistant) — other item types (images etc.) are not
 * text-representable and are skipped, mirroring claude/spans.ts's
 * block-type filtering.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Wire-format item dispatch is intentionally explicit and tolerant.
function buildMessageTurn(
  payload: unknown,
  timestamp: Date,
  model: string,
  turnContext: TurnContextInfo | undefined,
  spansEnabled: boolean
): Turn {
  const role = str(prop(payload, "role"));
  const content = prop(payload, "content");
  const items = Array.isArray(content) ? content : [];
  const spans: Span[] = [];

  let turnRole: TurnRole;
  if (role === "developer") {
    turnRole = "system";
    if (spansEnabled) {
      for (const item of items) {
        if (prop(item, "type") !== "input_text") {
          continue;
        }
        const text = textFromContentItem(item);
        if (text !== undefined) {
          spans.push(makeSpan("instructionInjection", text, "system", false));
        }
      }
    }
  } else if (role === "assistant") {
    turnRole = "assistant";
    if (spansEnabled) {
      for (const item of items) {
        if (prop(item, "type") !== "output_text") {
          continue;
        }
        const text = textFromContentItem(item);
        if (text !== undefined) {
          spans.push(makeSpan("assistantText", text, "assistant", false));
        }
      }
    }
  } else {
    // "user" (and any unrecognized role — treated as user, the only other
    // documented message role).
    turnRole = "user";
    if (spansEnabled) {
      for (const item of items) {
        if (prop(item, "type") !== "input_text") {
          continue;
        }
        const text = textFromContentItem(item);
        if (text !== undefined) {
          spans.push(classifyUserMessageText(text, turnContext));
        }
      }
    }
  }

  return skeletonTurn(turnRole, model, timestamp, spans, payload);
}

/**
 * `reasoning` variant -> one Turn. `summary[]` items become `thinking`
 * spans (plaintext, resent per the Responses API — PLAN's codex thinking
 * rule). `encrypted_content`, when present, is opaque CoT ciphertext:
 * unmeasurable by design, so it produces NO span at all — its bytes are
 * absorbed into the engine's residual rather than any counted category.
 */
function buildReasoningTurn(
  payload: unknown,
  timestamp: Date,
  model: string,
  spansEnabled: boolean
): Turn {
  const summary = prop(payload, "summary");
  const spans: Span[] = [];
  if (spansEnabled && Array.isArray(summary)) {
    for (const item of summary) {
      const text = textFromContentItem(item);
      if (text !== undefined) {
        spans.push(makeSpan("thinking", text, "assistant", false));
      }
    }
  }
  return skeletonTurn("assistant", model, timestamp, spans, payload);
}

/**
 * `function_call`'s `arguments` is a JSON STRING (docs/recon/codex.md) —
 * charCount is over that string as-is, never reparsed/reserialized.
 * `custom_tool_call`/`local_shell_call`/`tool_search_call` have no locally
 * observed example (fixtures README, T4.1); this stays tolerant by trying
 * an `input` field next (string, or stringified if not), and finally
 * falling back to the whole payload so charCount is never silently 0 for a
 * shape this parser hasn't seen yet.
 */
function extractArgsText(payload: unknown): string {
  const args = prop(payload, "arguments");
  if (typeof args === "string") {
    return args;
  }
  const input = prop(payload, "input");
  if (typeof input === "string") {
    return input;
  }
  if (input !== undefined) {
    return JSON.stringify(input);
  }
  return JSON.stringify(payload ?? {});
}

/**
 * `function_call`/`custom_tool_call`/`local_shell_call`/`tool_search_call`
 * -> one Turn (toolCallArgs span, turnRole "assistant" — the model issuing
 * the call). `namespace` routes MCP-server tools (recon-confirmed key
 * name). Indexes `call_id` -> {toolName, mcpServer} in `state` so the
 * matching `_output` item can link back to it (call_ids are otherwise
 * absent from the output payload's own name/namespace fields).
 */
function buildToolCallTurn(
  payload: unknown,
  timestamp: Date,
  model: string,
  state: CodexItemState,
  spansEnabled: boolean
): Turn {
  const toolName = str(prop(payload, "name")) ?? "unknown";
  const mcpServer = str(prop(payload, "namespace"));
  const callId = str(prop(payload, "call_id"));
  if (callId !== undefined) {
    state.callIndex.set(callId, {
      toolName,
      ...(mcpServer === undefined ? {} : { mcpServer }),
    });
  }

  if (!spansEnabled) {
    return skeletonTurn("assistant", model, timestamp, [], payload);
  }

  const text = extractArgsText(payload);
  const span = makeSpan("toolCallArgs", text, "assistant", false, {
    toolName,
    ...(mcpServer === undefined ? {} : { mcpServer }),
  });
  return skeletonTurn("assistant", model, timestamp, [span], payload);
}

/**
 * `output` is string OR `{content_items:[...]}` (dual wire shape per recon)
 * — string used verbatim; the array shape concatenates each content item's
 * text. Any other shape (neither string nor a `content_items` array) is
 * JSON.stringify'd whole, same fallback spirit as extractArgsText.
 */
function extractOutputText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  const contentItems = prop(output, "content_items");
  if (Array.isArray(contentItems)) {
    return contentItems.map((item) => textFromContentItem(item) ?? "").join("");
  }
  return JSON.stringify(output ?? "");
}

/**
 * `function_call_output`/`custom_tool_call_output`/`tool_search_output` ->
 * one Turn (toolResults span, turnRole "user" — matches claude/spans.ts's
 * convention that tool results are counted on the "user" side of the
 * conversation). `toolName`/`mcpServer` are looked up via `call_id` against
 * `state.callIndex` (populated by the matching call above); left unset if
 * the call_id has no matching prior call (e.g. `call_id` missing or the
 * call landed on a truncated/earlier window).
 */
function buildToolOutputTurn(
  payload: unknown,
  timestamp: Date,
  model: string,
  state: CodexItemState,
  spansEnabled: boolean
): Turn {
  if (!spansEnabled) {
    return skeletonTurn("user", model, timestamp, [], payload);
  }

  const callId = str(prop(payload, "call_id"));
  const linked = callId === undefined ? undefined : state.callIndex.get(callId);

  const text = extractOutputText(prop(payload, "output"));
  const span = makeSpan("toolResults", text, "user", false, {
    ...(linked?.toolName === undefined ? {} : { toolName: linked.toolName }),
    ...(linked?.mcpServer === undefined ? {} : { mcpServer: linked.mcpServer }),
  });
  return skeletonTurn("user", model, timestamp, [span], payload);
}

const TOOL_CALL_TYPES: ReadonlySet<string> = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "tool_search_call",
]);

const TOOL_OUTPUT_TYPES: ReadonlySet<string> = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "tool_search_output",
]);

/**
 * Cross-item state threaded through a single session's response_item
 * stream by the caller (parse.ts) — currently just the call_id -> tool
 * index used to link `_output` items back to the call that produced them.
 */
export interface CodexItemState {
  callIndex: Map<string, { toolName: string; mcpServer?: string }>;
}

export function createCodexItemState(): CodexItemState {
  return { callIndex: new Map() };
}

/**
 * Dispatches one `response_item` record (`payload.type`) to a Turn builder.
 * Returns `undefined` for an unrecognized `payload.type`, pushing an
 * "unknown-response-item" warning instead — never throws. `event_msg`
 * variants (including their own unknown-variant tolerance) are a separate,
 * T4.5-owned layer; nothing here reads or validates `event_msg` records.
 *
 * `spansEnabled` (false for the `list` pipeline's lite parse — see
 * claude/parse.ts's ParseClaudeSessionOptions doc for the shared rationale):
 * when false, every builder below still returns a Turn (needed so
 * usage.ts's index-based token_count attachment keeps working) but with
 * contentSpans: [] and none of the text-extraction/JSON.stringify work that
 * only feeds spans.
 */
export function buildResponseItemTurn(
  record: RawCodexRecord,
  state: CodexItemState,
  currentModel: string,
  turnContext: TurnContextInfo | undefined,
  warnings: ParseWarning[],
  spansEnabled: boolean
): Turn | undefined {
  const { payload } = record;
  const type = str(prop(payload, "type"));
  const timestamp = record.timestamp ?? new Date(0);

  if (type === "message") {
    return buildMessageTurn(
      payload,
      timestamp,
      currentModel,
      turnContext,
      spansEnabled
    );
  }
  if (type === "reasoning") {
    return buildReasoningTurn(payload, timestamp, currentModel, spansEnabled);
  }
  if (type !== undefined && TOOL_CALL_TYPES.has(type)) {
    return buildToolCallTurn(
      payload,
      timestamp,
      currentModel,
      state,
      spansEnabled
    );
  }
  if (type !== undefined && TOOL_OUTPUT_TYPES.has(type)) {
    return buildToolOutputTurn(
      payload,
      timestamp,
      currentModel,
      state,
      spansEnabled
    );
  }

  warnings.push({
    code: "unknown-response-item",
    line: record.line,
    message: `line ${record.line}: unrecognized response_item payload.type ${
      type ? `"${type}"` : "(missing)"
    }`,
    recordType: "response_item",
  });
}
