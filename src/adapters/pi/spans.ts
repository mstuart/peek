// pi content-span extraction (T6.4).
//
// Mirrors src/adapters/claude/spans.ts's shape-extraction + attachment
// convention, adapted to pi's message shapes (docs/recon/pi.md). Turns
// content into `Span[]` per docs/DESIGN.md § "Accounting rules" rule 5 and the
// frozen `Span` type in model/types.ts.
//
// ATTACHMENT CONVENTION (mirrors claude/parse.ts's file header): pi already
// creates one Turn per "message" entry, including user/toolResult/
// bashExecution/embedded-custom ones (mapTurnRole maps all of these to
// TurnRole "user" — see parse.ts). Rather than attaching each entry's own
// spans to its OWN Turn, this module's extraction functions are pure
// (message/entry -> Span[]) and parse.ts holds every non-assistant entry's
// spans as "pending", flushing them into the NEXT assistant Turn's
// contentSpans alongside that assistant record's own output spans — exactly
// like claude-code's convention, even though pi's user-side entries DO have
// their own Turn (that Turn's contentSpans is simply left empty; the entry's
// real content lives on the assistant Turn that follows it). This keeps the
// two adapters' composition.ts-facing contract identical: a Turn's
// contentSpans is the INCREMENTAL content added at that point, which
// composition.ts accumulates in turn order.
//
// Two entry kinds have NO Turn of their own at all (compaction, and the
// top-level custom_message entry type) — their spans MUST be deferred to a
// future Turn regardless, which is the other reason a uniform
// pending-spans-attach-to-next-assistant-Turn mechanism is used for every
// category here rather than attaching message-entry spans directly to their
// own Turn.

import type { CompositionCategory, Span, TurnRole } from "../../model/types.js";

const SPAN_TEXT_CAP = 2000;

function getProp(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null) {
    return;
  }
  return (obj as Record<string, unknown>)[key];
}

function makeSpan(
  category: CompositionCategory,
  text: string,
  turnRole: TurnRole,
  truncated: boolean,
  toolName?: string
): Span {
  const charCount = text.length;
  return {
    category,
    charCount,
    ...(charCount <= SPAN_TEXT_CAP ? { text } : {}),
    truncated,
    turnRole,
    // pi has no MCP servers (docs/recon/pi.md) — toolName is set, mcpServer
    // never is.
    ...(toolName === undefined ? {} : { toolName }),
  };
}

/** Concatenates string content that may be a plain string or an array of
 * pi-ai content blocks (each either a bare string or `{ type: "text", text
 * }`-shaped, per the same lineage as claude's content-block convention).
 * Non-text blocks are JSON.stringify'd so their size is still counted rather
 * than silently dropped. */
function flattenTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (getProp(block, "type") === "text") {
        const text = getProp(block, "text");
        if (typeof text === "string") {
          return text;
        }
      }
      return JSON.stringify(block);
    })
    .join("");
}

/** UserMessage.content -> a single userText span (string or content-array
 * text items, per docs/recon/pi.md). Empty/absent content yields no span. */
export function extractUserMessageSpans(content: unknown): Span[] {
  const text = flattenTextContent(content);
  if (text.length === 0) {
    return [];
  }
  return [makeSpan("userText", text, "user", false)];
}

/** AssistantMessage.content -> text/thinking/toolCall spans. Mirrors
 * claude/spans.ts's extractAssistantContentSpans but keyed on pi's block
 * shapes: `type:"text"|"thinking"|"toolCall"`, and toolCall's `name`/
 * `arguments` fields (vs. claude's tool_use `name`/`input`). The `thinking`
 * category is tagged here; composition.ts zeroes it for pi (thinking is
 * stripped on resend, never future input). */
export function extractAssistantMessageSpans(content: unknown): Span[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const spans: Span[] = [];

  for (const block of content) {
    const type = getProp(block, "type");

    if (type === "text") {
      const text = getProp(block, "text");
      if (typeof text === "string" && text.length > 0) {
        spans.push(makeSpan("assistantText", text, "assistant", false));
      }
      continue;
    }

    if (type === "thinking") {
      const thinking = getProp(block, "thinking");
      if (typeof thinking === "string" && thinking.length > 0) {
        spans.push(makeSpan("thinking", thinking, "assistant", false));
      }
      continue;
    }

    if (type === "toolCall") {
      const name = getProp(block, "name");
      const args = getProp(block, "arguments");
      const text = JSON.stringify(args ?? {});
      const toolName = typeof name === "string" ? name : "unknown";
      spans.push(makeSpan("toolCallArgs", text, "assistant", false, toolName));
    }
    // Other/unknown block types are skipped (out of scope for the
    // categories PLAN defines).
  }

  return spans;
}

/**
 * ToolResultMessage -> a single toolResults span. Unlike claude-code, pi has
 * only one representation of a tool result (no separate structured
 * `toolUseResult` vs. inline content) — the message's own `content` field is
 * the sole source, so there is no dual-source/single-canonical-source
 * decision to make here (docs/recon/pi.md: "pi has no dual-source issue").
 */
export function extractToolResultMessageSpans(
  message: Record<string, unknown>
): Span[] {
  const text = flattenTextContent(message.content);
  const toolName =
    typeof message.toolName === "string" ? message.toolName : "unknown";
  return [makeSpan("toolResults", text, "user", false, toolName)];
}

/**
 * BashExecutionMessage -> a single toolResults span (command + output
 * concatenated, toolName "bash"). DECISION (task-flagged ambiguity,
 * resolved): when `excludeFromContext` is true, the command's output was
 * deliberately kept out of the LLM's context (docs/recon/pi.md), so it must
 * never contribute to composition's context accounting — the span is
 * skipped entirely (not recorded with charCount 0) so there's no possible
 * way for it to be folded into the accumulator, rather than relying on
 * every future call site to remember to ignore a zero-value span.
 */
export function extractBashExecutionMessageSpans(
  message: Record<string, unknown>
): Span[] {
  if (message.excludeFromContext === true) {
    return [];
  }

  const command = typeof message.command === "string" ? message.command : "";
  const output = typeof message.output === "string" ? message.output : "";
  const truncated = message.truncated === true;
  return [
    makeSpan("toolResults", `${command}${output}`, "user", truncated, "bash"),
  ];
}

/**
 * CustomMessage / custom_message entry content -> a single coordination
 * span. DECISION (task-flagged ambiguity, resolved): pi's custom_message is
 * extension-injected content (status updates, coordination notices) rather
 * than something the human user typed, so it is classified "coordination"
 * unconditionally (unlike claude's prefix-matched userText/coordination
 * split) rather than "userText"-equivalent. Only materializes into context
 * when `display` is true AND content is present (docs/recon/pi.md: `custom`
 * entries are NOT in context; `custom_message` entries ARE, gated on
 * `display`) — used for both the top-level `custom_message` entry type and
 * the embedded `message.role === "custom"` CustomMessage variant, which
 * share the same `customType`/`content`/`display` shape.
 */
export function extractCustomContentSpans(
  content: unknown,
  display: unknown
): Span[] {
  if (display !== true) {
    return [];
  }
  const text = flattenTextContent(content);
  if (text.length === 0) {
    return [];
  }
  return [makeSpan("coordination", text, "user", false)];
}

/**
 * compaction entry's `summary` -> a single compactionSummaries span, held
 * pending and attached to the next assistant Turn (see file header) — this
 * is what seeds the fresh accumulator state composition.ts starts after its
 * phase reset at this same compaction's turnIndex.
 */
export function extractCompactionSummarySpans(summary: unknown): Span[] {
  const text = typeof summary === "string" ? summary : "";
  if (text.length === 0) {
    return [];
  }
  return [makeSpan("compactionSummaries", text, "user", false)];
}

/** Dispatches a "message" entry's own message object to the right
 * extractor, by `message.role`. Used for every role EXCEPT "assistant",
 * whose spans parse.ts computes separately (they attach to the assistant's
 * own Turn immediately, not via the pending-spans mechanism). */
export function extractPendingMessageSpans(
  message: Record<string, unknown>
): Span[] {
  switch (message.role) {
    case "user":
      return extractUserMessageSpans(message.content);
    case "toolResult":
      return extractToolResultMessageSpans(message);
    case "bashExecution":
      return extractBashExecutionMessageSpans(message);
    case "custom":
      return extractCustomContentSpans(message.content, message.display);
    default:
      return [];
  }
}
