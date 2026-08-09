# Recon: pi coding agent session format (2026-08-08)

Source-verified against github.com/earendil-works/pi @ main (v0.84.1); NO local data. Parser-facing reference for T6.x. **Two unrelated persistence systems exist — the pi CLI writes System A; parse System A, detect+skip System B.**

## System A — pi CLI sessions (the parse target)

Location: `$PI_AGENT_DIR or ~/.pi/agent` + `/sessions/--<cwd-with-/-replaced-by-->--/<ISO-ts-colons-dots-to-dashes>_<uuid>.jsonl`

JSONL; line 1 header, then tree entries. `CURRENT_SESSION_VERSION = 3` (v1: flat array, no ids; v2: +id/parentId, firstKeptEntryIndex→Id; v3: role "hookMessage"→"custom"). Timestamps are ISO strings.

```typescript
SessionHeader { type:"session"; version?; id; timestamp; cwd; parentSession?: string /* FILE PATH */ }
SessionEntryBase { type; id /* 8 hex */; parentId: string|null; timestamp }
// entry types:
"message"                { message: AgentMessage }
"thinking_level_change"  { thinkingLevel }
"model_change"           { provider; modelId }
"compaction"             { summary; firstKeptEntryId; tokensBefore; details?; usage?; fromHook? }
"branch_summary"         { fromId; summary; details?; usage?; fromHook? }
"custom"                 { customType; data? }            // NOT in LLM context
"custom_message"         { customType; content; display } // IS in LLM context
"label"                  { targetId; label }
"session_info"           { name? }
```

Tree: single file, parent-pointer tree; active leaf = most recently appended entry (recomputed, not stored); `/fork`/`/clone` → NEW file with `parentSession` = source file path.

Messages (from @earendil-works/pi-ai types + coding-agent extensions):
```typescript
Usage { input; output; cacheRead; cacheWrite; cacheWrite1h?; reasoning?; totalTokens;
        cost { input; output; cacheRead; cacheWrite; total } }   // COST PRECOMPUTED
UserMessage { role:"user"; content; timestamp /* unix ms */ }
AssistantMessage { role:"assistant"; content:(text|thinking|toolCall)[]; api; provider; model;
                   usage: Usage; stopReason; errorMessage?; timestamp }
ToolResultMessage { role:"toolResult"; toolCallId; toolName; content; details?; usage?; isError; timestamp }
BashExecutionMessage { role:"bashExecution"; command; output; exitCode?; cancelled; truncated;
                       fullOutputPath?; excludeFromContext?; timestamp }
CustomMessage { role:"custom"; customType; content; display; details?; timestamp }
```
- `compactionSummary`/`branchSummary` ROLES appear only in materialized context at read time — on disk they are the `compaction`/`branch_summary` ENTRY types.
- Compaction context rebuild: walk leaf→root; at a compaction entry substitute summary + entries from `firstKeptEntryId` forward.
- Usage.cost is precomputed → use as `display`-mode cost source.
- NOT recorded: system prompt, AGENTS.md content, tool schemas (names only) → residual approach like Claude Code.

## System B — pi-agent-core harness v4 (DETECT AND SKIP)

Different lineage (SDK `AgentHarness`, not the CLI). JSONL header `{kind:"header", version:4, ...}` then `{kind: "entry"|"record"|"lane"|"fact", seq, ...}` mutations; compaction carries `retainedTail: AgentMessage[]` instead of firstKeptEntryId; timestamps unix ms; also a SQLite backend (@earendil-works/pi-session-backend-sqlite-node). Detection: first line has `kind` field (System A has `type:"session"`). Skip with ParseWarning "pi System B (harness v4) session — unsupported in v1".

## Gotchas

- Legacy npm scope `@mariozechner/pi-*` = pre-rename; current `@earendil-works/pi-*`; repo badlogic/pi-mono → earendil-works/pi.
- If a `retainedTail` field appears in a System-A-looking file, it was produced by non-stock tooling — warn, don't crash.
