# Claude Code fixtures

Synthetic (fabricated content) JSONL session fixtures, per `docs/recon/claude-code.md`.
All uuids, timestamps, and text are made up; usage numbers are small but arithmetically
consistent (TTL splits sum; streaming-split usage is identical across records).

`v2.1.104/` predates `ai-title`/`mode`/`permission-mode`/`queue-operation`/`file-history-delta`,
so none of those record types appear in it. `v2.1.225/` exercises the directory-tree features
(`subagents/`, `tool-results/`) that need a `<sessionId>/` directory alongside (or instead of)
the top-level `.jsonl`.

Case numbers below refer to the T1.1 task's required-case list.

## v2.1.104/

| File | Cases covered |
|---|---|
| `normal-turns.jsonl` | 1 — normal user→assistant turns with realistic usage fields |
| `cache-heavy.jsonl` | 2 — turn WITH `cache_creation` TTL sub-split (1h+5m summing to `cache_creation_input_tokens`), turn WITHOUT the sub-object |
| `streaming-split.jsonl` | 3 — one logical turn as 3 assistant records (thinking/text/tool_use) sharing one `message.id` + `requestId`, identical usage repeated on each |
| `sidechain-replay.jsonl` | 4 — #913 case: duplicate `message.id` with a different `requestId` and `isSidechain:true`, replaying parent usage incl. `cache_read_input_tokens` |
| `iterations-multi.jsonl` | 5 — `usage.iterations[]` with 2 elements, different models (synthetic advisor case; sums to top-level totals) |
| `compaction.jsonl` | 6 — `isCompactSummary:true` record preceded immediately by an `isApiErrorMessage:true` all-zero-usage record, with the last real-usage record two records earlier (audit-F2 anchoring trap) |
| `unknown-type-and-model.jsonl` | 9 — unknown top-level `type` (`"future-record-type"`) and an assistant turn with unknown model id `<synthetic>` |
| `tool-use-names.jsonl` | 10 — `tool_use` blocks incl. MCP name `mcp__github__get_issue` and a plugin-form name `mcp__plugin_acme-tools_linter__run_lint` |
| `cache-miss-reason.jsonl` | 11 — `message.diagnostics.cache_miss_reason` = `{"type":"system_changed","cache_missed_input_tokens":N}` |

## v2.1.225/

| Path | Cases covered |
|---|---|
| `20000000-…0001.jsonl` + `20000000-…0001/subagents/agent-abc123.jsonl` + `.meta.json` | 7 — Task-tool-spawned subagent tree: first subagent record has `parentUuid:null`, `isSidechain:true`, `agentId`, `slug`. `agent-abc123.jsonl`'s trailing record (`s-0005`) is a cross-file replay: same `message.id`/`requestId`/usage as the parent file's `a-0001` — the family-scope dedup case (`test/unit/dedup-family.test.ts`; docs/DESIGN.md's Measured results ledger T2.5 reconciliation follow-up), not covered by any per-file case above. `20000000-…0001.jsonl` also trails 5 corpus-sweep metadata records (`agent-name`, `agent-setting`, `frame-link`, `worktree-state`, `relocated` — all now-known, still 0-warning types; see docs/recon/claude-code.md § Record types, discovered 2026-08-08); `agent-abc123.jsonl` trails 1 `fork-context-ref` record, cataloged known/inert 2026-08-08 (0-warning; asserted in `test/unit/claude-parse.test.ts` — its `contextLength` field measures a parent-conversation turn-position counter, not tokens/chars, see docs/recon/claude-code.md) |
| `20000000-…0002/subagents/agent-def456.jsonl` + `.meta.json` (NO top-level jsonl) | 7 — subagents-only session dir (team/headless coordinator pattern; wrapped `<teammate-message>` first record, longer hex `agentId`) |
| `20000000-…0003.jsonl` + `20000000-…0003/tool-results/toolu-offload-0001.txt` | 8 — offloaded tool-result (short inline reference, full text in `tool-results/`) AND a normal turn where inline `tool_result` content and sibling `toolUseResult` are byte-identical (double-count trap) |
| `streaming-split-compaction.jsonl` | dedup/turnIndex remap regression: a 3-record streaming-split turn (shared `message.id`/`requestId`, identical usage) precedes an `isCompactSummary` marker, followed by a post-compaction turn with real usage. The adapter's pre-dedup `turnIndex` (3) and the correct post-`dedupSession()` index (1) differ by 2 — see `test/unit/dedup-remap.test.ts` |

## Recon ambiguities encountered

- **`cache_missed_input_tokens` nesting**: the recon doc gives the field name but not its exact
  placement relative to `cache_miss_reason`. Fixture nests it inside the `cache_miss_reason`
  object (`diagnostics.cache_miss_reason = {type, cache_missed_input_tokens}`) as the most
  natural single-object grouping. Flagging for confirmation against real samples if available;
  did not invent a different field name.
