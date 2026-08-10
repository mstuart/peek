// Claude Code content-span extraction (T1.5).
//
// Turns content blocks on `user`/`assistant` records into `Span[]` per
// docs/DESIGN.md § "Accounting rules" rule 5 and the frozen `Span` type in
// model/types.ts. Two functions do the work: `extractAssistantContentSpans`
// (a message's own output — text/thinking/tool_use blocks) and
// `extractUserContentSpans` (a user record's own content — text, coordination
// wrapper, compaction summary, and the one authoritative tool_result).
//
// NOT extracted here: `instructionInjection` (CLAUDE.md/@-mention content).
// docs/recon/claude-code.md § "NOT in the logs" confirms CLAUDE.md contents
// are never written to the transcript — there is no schema signal to key an
// @-mention span off of, so per the "if not identifiable, skip" rule this
// category is left unpopulated for claude-code rather than guessed.

import type { CompositionCategory, Span, TurnRole } from "../../model/types.js";
import type { RawClaudeRecord } from "./records.js";

const SPAN_TEXT_CAP = 2000;

/** Prefix match for wrapped coordination content (audit R1: prefix match, not full parse). */
const COORDINATION_PREFIXES = ["<teammate-message", "<task-notification"];

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

function classifyUserText(text: string): CompositionCategory {
  const trimmed = text.trimStart();
  return COORDINATION_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
    ? "coordination"
    : "userText";
}

/**
 * `mcp__<server>__<tool>` (incl. plugin form `mcp__plugin_<marketplace>_<name>__<tool>`)
 * per docs/recon/claude-code.md § tool_use. The delimiter is a literal double
 * underscore between exactly 3 segments (`mcp`, server, tool) — plugin-form
 * servers embed single underscores inside the server segment itself, so a
 * plain `split("__")` still lands the server in position 1. Plain (non-MCP)
 * tool names get `toolName` only, no `mcpServer` key.
 */
export function parseMcpToolName(name: string): {
  toolName: string;
  mcpServer?: string;
} {
  if (!name.startsWith("mcp__")) {
    return { toolName: name };
  }
  const parts = name.split("__");
  if (parts.length < 3) {
    return { toolName: name };
  }
  const mcpServer = parts[1] as string;
  const toolName = parts.slice(2).join("__");
  return { mcpServer, toolName };
}

/** assistant record content blocks → text/thinking/tool_use spans. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Wire-format block dispatch is intentionally explicit and tolerant.
export function extractAssistantContentSpans(content: unknown): Span[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const spans: Span[] = [];

  for (const block of content) {
    const type = getProp(block, "type");

    if (type === "text") {
      const text = getProp(block, "text");
      if (typeof text === "string") {
        spans.push(makeSpan("assistantText", text, "assistant", false));
      }
      continue;
    }

    if (type === "thinking") {
      // Category is tagged here; the zeroing-in-composition rule (PLAN's
      // thinking rule) is T2.3's job, not this parser's.
      const thinking = getProp(block, "thinking");
      if (typeof thinking === "string") {
        spans.push(makeSpan("thinking", thinking, "assistant", false));
      }
      continue;
    }

    if (type === "tool_use") {
      const name = getProp(block, "name");
      const input = getProp(block, "input");
      const text = JSON.stringify(input ?? {});
      const rawName = typeof name === "string" ? name : "unknown";
      const { toolName, mcpServer } = parseMcpToolName(rawName);
      spans.push(
        makeSpan("toolCallArgs", text, "assistant", false, {
          toolName,
          ...(mcpServer === undefined ? {} : { mcpServer }),
        })
      );
    }
    // Other block types (redacted_thinking, server_tool_use, image, ...) are
    // out of scope for the categories PLAN defines and are skipped.
  }

  return spans;
}

/**
 * `tool_use_id` -> {toolName, mcpServer}, built once per session from every
 * `tool_use` block seen in assistant records (see buildToolUseIndex below).
 * A `tool_result`'s own JSON never repeats the tool's name, so this is the
 * only way to tag toolResults spans — mirrors codex's items.ts `call_id`
 * link. Ids with no matching prior `tool_use` (orphaned by a truncated
 * fixture, replay, etc.) are simply absent — looked up as `undefined` and
 * never guessed at.
 */
export type ToolUseIndex = ReadonlyMap<
  string,
  { toolName: string; mcpServer?: string }
>;

/**
 * Scans every assistant record's `tool_use` blocks up front and indexes
 * them by `id` so `extractToolResultSpans` can look the name back up when it
 * later sees the paired `tool_result`'s `tool_use_id`. Built from the whole
 * record list (not incrementally during the main parse loop) so result
 * linking doesn't depend on file ordering, even though docs/recon/claude-code.md
 * confirms results always follow their calls in-file in samples seen so far.
 */
export function buildToolUseIndex(records: RawClaudeRecord[]): ToolUseIndex {
  const index = new Map<string, { toolName: string; mcpServer?: string }>();
  for (const record of records) {
    if (record.type !== "assistant") {
      continue;
    }
    const content = getProp(record.raw.message, "content");
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (getProp(block, "type") !== "tool_use") {
        continue;
      }
      const id = getProp(block, "id");
      const name = getProp(block, "name");
      if (typeof id !== "string" || typeof name !== "string") {
        continue;
      }
      index.set(id, parseMcpToolName(name));
    }
  }
  return index;
}

/**
 * Single-source rule (audit R1-C1): a user record's tool_result is counted
 * from exactly one place. `toolUseResult` (top-level, structured) wins when
 * present; the inline `tool_result` content block is the fallback, used only
 * when `toolUseResult` is absent. Never both — see docs/DESIGN.md rule 5.
 *
 * Serialization of `toolUseResult` (documented convention, no fixed schema
 * exists for it): bash-shaped results (`stdout`/`stderr` present) serialize
 * as `stdout + stderr` concatenated; everything else is JSON.stringify'd
 * whole, since its shape varies by tool/MCP server.
 */
function serializeToolUseResult(toolUseResult: unknown): string {
  if (typeof toolUseResult === "object" && toolUseResult !== null) {
    const stdout = getProp(toolUseResult, "stdout");
    const stderr = getProp(toolUseResult, "stderr");
    if (typeof stdout === "string" || typeof stderr === "string") {
      return `${typeof stdout === "string" ? stdout : ""}${
        typeof stderr === "string" ? stderr : ""
      }`;
    }
  }
  return JSON.stringify(toolUseResult);
}

/** Looks a `tool_use_id` up in the session's ToolUseIndex; non-string ids
 * and unmatched ids both fall through to `{}` (no `extra` fields set on the
 * span) rather than guessing. */
function lookupToolUse(
  toolUseIndex: ToolUseIndex,
  toolUseId: unknown
): { toolName?: string; mcpServer?: string } {
  if (typeof toolUseId !== "string") {
    return {};
  }
  return toolUseIndex.get(toolUseId) ?? {};
}

/**
 * Offloaded tool-results (docs/recon/claude-code.md § Directory layout:
 * `tool-results/*.{pdf,txt}`) leave only a short inline reference in the
 * JSONL; the real content lives in a sidecar file we deliberately never
 * read (that would defeat the point — the charCount is a documented lower
 * bound). `offloadedToolIds` is the set of `tool_use_id`s that have a
 * sidecar file, computed once per session from a directory listing.
 */
function extractToolResultSpans(
  record: RawClaudeRecord,
  offloadedToolIds: ReadonlySet<string>,
  toolUseIndex: ToolUseIndex
): Span[] {
  const { message } = record.raw;
  const content = getProp(message, "content");
  if (!Array.isArray(content)) {
    return [];
  }

  const inlineBlocks = content.filter(
    (block) => getProp(block, "type") === "tool_result"
  );
  if (inlineBlocks.length === 0) {
    return [];
  }

  const isOffloaded = (toolUseId: unknown): boolean =>
    typeof toolUseId === "string" && offloadedToolIds.has(toolUseId);

  const { toolUseResult } = record.raw;
  if (toolUseResult !== undefined) {
    // One canonical source per record: toolUseResult covers whichever
    // tool_result block(s) triggered it. Truncation/linking is keyed off the
    // first block's tool_use_id (the common case is exactly one).
    const toolUseId = getProp(inlineBlocks[0], "tool_use_id");
    const text = serializeToolUseResult(toolUseResult);
    return [
      makeSpan(
        "toolResults",
        text,
        "user",
        isOffloaded(toolUseId),
        lookupToolUse(toolUseIndex, toolUseId)
      ),
    ];
  }

  // Fallback: toolUseResult absent, use inline block(s) only.
  return inlineBlocks.map((block) => {
    const toolUseId = getProp(block, "tool_use_id");
    const blockContent = getProp(block, "content");
    const text =
      typeof blockContent === "string"
        ? blockContent
        : JSON.stringify(blockContent);
    return makeSpan(
      "toolResults",
      text,
      "user",
      isOffloaded(toolUseId),
      lookupToolUse(toolUseIndex, toolUseId)
    );
  });
}

/**
 * user record → spans. `isCompactSummary` records are entirely a
 * compaction-summary span (their content is synthetic, never a real user
 * message or tool result); otherwise text content is classified into
 * userText/coordination, and tool_result content is handled by the
 * single-source rule above.
 */
export function extractUserContentSpans(
  record: RawClaudeRecord,
  offloadedToolIds: ReadonlySet<string>,
  toolUseIndex: ToolUseIndex
): Span[] {
  const { message } = record.raw;
  const content = getProp(message, "content");

  if (record.raw.isCompactSummary === true) {
    const text =
      typeof content === "string" ? content : JSON.stringify(content ?? "");
    return [makeSpan("compactionSummaries", text, "user", false)];
  }

  const spans: Span[] = [];

  if (typeof content === "string") {
    spans.push(makeSpan(classifyUserText(content), content, "user", false));
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (getProp(block, "type") !== "text") {
        continue;
      }
      const text = getProp(block, "text");
      if (typeof text === "string") {
        spans.push(makeSpan(classifyUserText(text), text, "user", false));
      }
      // tool_result blocks are handled by extractToolResultSpans below;
      // image/other block types are not text-representable and are skipped.
    }
  }

  spans.push(...extractToolResultSpans(record, offloadedToolIds, toolUseIndex));
  return spans;
}
