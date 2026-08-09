# Recon: Claude Code JSONL session format (2026-08-08)

Evidence-based, from real files spanning versions 2.1.42 (Feb 2026) → 2.1.225 (Aug 2026). This is the parser-facing reference for T1.x fixtures/adapters.

## Directory layout

```
~/.claude/projects/<cwd-slug>/            # slug = cwd path with "/" → "-"
  <sessionId>.jsonl                       # main transcript (may be ABSENT — see below)
  <sessionId>/
    subagents/agent-<agentId>.jsonl       # subagent transcript
    subagents/agent-<agentId>.meta.json   # {"agentType": "..."}
    subagents/workflows/wf_<id>/...       # nested workflow subagent trees
    tool-results/*.{pdf,txt}              # OFFLOADED large tool outputs
    workflows/wf_<id>.json
```
- A session may have ONLY `<sessionId>/subagents/` with NO top-level `.jsonl` (team/headless coordinators). Directory structure, not file content, is the reliable subagent signal.

## Record types (top-level `.type`)

`user`, `assistant`, `system`, `attachment`, `file-history-snapshot`, `file-history-delta` (new ~v2.1.22x), `last-prompt`, `ai-title`, `mode`, `permission-mode`, `queue-operation`, `pr-link`, `progress` (subagent files only). `ai-title`/`mode`/`permission-mode`/`queue-operation` absent before ~v2.1.1xx. Parser must be unknown-type tolerant.

Discovered in corpus sweep 2026-08-08 (structure-only — 300 most recent real session files + all `agent-*.jsonl` subagent files under `~/.claude/projects/`, cross-checked against the full ~11k-file discoverable corpus). Pure metadata, no token/cost/content fields observed — added to the parser's known-type list (no warning, no behavior change beyond suppressing the warning):

| Type | Fields (keys only) | First observed version | Notes |
|---|---|---|---|
| `relocated` | `relocatedCwd`, `sessionId` | 2.1.224 | Top-level main-session file; marks the session's cwd was relocated (e.g. moved into a worktree dir). No own `version`/`timestamp` field. |
| `worktree-state` | `worktreeSession` (nested object: `enteredExisting`, `originalCwd`, `preEnterOriginalCwd`, `sessionId`, `worktreeBranch`, `worktreeName`, `worktreePath`), `sessionId` | 2.1.224 | Top-level main-session file; git-worktree entry/exit bookkeeping. |
| `agent-name` | `agentName`, `sessionId` | 2.1.185 | Top-level main-session file. |
| `agent-setting` | `agentSetting`, `sessionId` | 2.1.119 | Top-level main-session file; rare in the sample (8 of ~11k files). |
| `frame-link` | `frameUrl`, `path`, `sessionId`, `timestamp`, optional `title` | 2.1.198 | Top-level main-session file; looks like browser/frame-automation bookkeeping (e.g. claude-in-chrome), not conversation content. |

**RESOLVED (2026-08-08, F1 investigation)** — `fork-context-ref` (`agentId`, `contextLength`, `parentLastUuid`, `parentSessionId`; subagent files only, `agent-*.jsonl`) is now added to the known-type list, 0-warning, and permanently excluded from token/cost accounting. Evidence:

Sample: 129 real `fork-context-ref` records across 4 real `~/.claude/projects` session families (grep `fork-context-ref` over the full local corpus), cross-referenced against their parent sessions' raw records by `parentLastUuid`/`parentSessionId` and against each child agent's own first-turn usage.

- **Ruled out: token count.** `contextLength` vs. the child's own first-turn `contextTotal` (input+cacheRead+cacheWrite): ratio 0.001–0.018 across all 129 samples (2-3 orders of magnitude too small). Same order-of-magnitude mismatch against the parent's `contextTotal` at `parentLastUuid`. No token-usage hypothesis (input, output, cache-write, cache-write+output "new tokens since compaction") fit within even a factor of 10.
- **Ruled out: character count of the forked task's own prompt.** Sibling forks launched from the *same* parent position (same `parentLastUuid`) but with *different* `prompt`/`description` text (e.g. three simultaneous `Agent` calls — "voice-audit", "fact-sweep", "red-team" — with unrelated prompt bodies) all get the **identical** `contextLength` value. This proves `contextLength` is a property of the *parent conversation's position*, not of the individual forked task's content. (An earlier char-count-of-prompt hypothesis looked plausible on a single sample, ratio ~1.0-2.9, but broke down badly — ratio range 0.89-17.3 — once compared across the full sample, consistent with it being coincidental correlation with turn position rather than a real relationship.)
- **Confirmed: a parent-conversation turn-position counter that resets on compaction.** Within one real session (`~/git-collectors` project, 129→117-sample post-compaction subset), `contextLength` is flat/monotonic in parent record order, drops sharply immediately after a `isCompactSummary:true` record, then climbs again. Regressing `contextLength` against the count of raw parent `assistant`-type JSONL records since the last compaction (or session start, if none) gives a **tight linear fit**: for forks spawned after a compaction, `contextLength ≈ 2.32 × (assistant records since that compaction)` — mean ratio 2.316, stddev 0.070 (3% relative) across 117 samples. For forks spawned before any compaction (since session start), the ratio is a different but still tight constant: mean 4.544, stddev 0.285 (12 samples) — the higher constant is consistent with a fixed session-start overhead (e.g. system prompt) folded into the count for that case. The ~2.3x multiplier (vs. a raw 1:1 record count) is consistent with Claude Code's internal SDK-level message-list counting more list entries per raw JSONL assistant record than the JSONL file itself contains (streaming-split fragments, thinking/tool_use/text sub-blocks) — the exact internal unit is not recoverable from file content alone, but the *quantity being counted* (turns/messages since last compaction, not tokens or characters) is established with high confidence.
- **Decision:** because `contextLength` is not expressed in tokens (or any convertible unit we can derive an exact formula for) and is not already reflected in any usage field on any record — parent or child — it cannot be wired into token/cost accounting without violating the exact-totals invariant (no estimated additions). It is catalogued as a known, deliberately-inert record type: parsed without warning, never contributing to `contextTotal`/cost/attribution. Fixture (`test/fixtures/claude-code/v2.1.225/…/agent-abc123.jsonl` line 6) and assertion (`test/unit/claude-parse.test.ts`) updated to expect 0 warnings.

| Type | Fields (keys only) | First observed version | Notes |
|---|---|---|---|
| `fork-context-ref` | `agentId`, `contextLength`, `parentLastUuid`, `parentSessionId` | 2.1.198 | Subagent files only (`agent-*.jsonl`). `contextLength` = a parent-conversation turn-position counter (turns/messages since the parent's last compaction, ~2.3x the raw assistant-record count in that span; see evidence above) — NOT tokens, NOT characters. No usable exact formula, so excluded from all accounting; known/inert, 0-warning. |

Also swept: `started`/`result` (keys: `agentId`, `key`, optional `result`) live exclusively in `subagents/workflows/wf_<id>/journal.jsonl` — a workflow-orchestration journal, not a session transcript. `discoverClaudeSessions` only matches `agent-*.jsonl` under `subagents/`, so `journal.jsonl` is never read; these two types cannot produce `unknown-record-type` warnings in practice and were left uncataloged.

One more sweep observation, not a new type: a handful of `.type` values in the raw corpus were garbled/doubled fragments (e.g. `"queue-operatioqueue-operation"`, `"assistantlast-prompt"`, a lone `"t"`). These did not reproduce on a second read of the same files/offsets and are consistent with transient torn reads of actively-growing or in-place-rewritten state files (`queue-operation`/`last-prompt` look like frequently-rewritten state, not pure append logs) while a live Claude Code process concurrently wrote to them — not persisted on-disk corruption. Not cataloged as types; the parser's existing `unknown-record-type`/`malformed-line` handling already degrades safely for this case.

Common fields on substantive records: `uuid`, `parentUuid` (linked tree), `timestamp`, `sessionId`, `version`, `cwd`, `gitBranch`, `userType`, `isSidechain`, `promptId` (groups one user turn).

## assistant records

- `message.model` per turn. Observed: claude-fable-5, claude-opus-5, claude-sonnet-5, claude-opus-4-7/4-8, claude-sonnet-4-6, claude-haiku-4-5-20251001, `qwen/qwen3.5-9b`, literal `<synthetic>` — NO model allowlists.
- `message.usage`:
```json
{"input_tokens":N,"cache_creation_input_tokens":N,"cache_read_input_tokens":N,"output_tokens":N,
 "cache_creation":{"ephemeral_1h_input_tokens":N,"ephemeral_5m_input_tokens":N},
 "server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard",
 "inference_geo":"...","iterations":[{...one-or-more usage sub-records, "type":"message"...}],"speed":"standard"}
```
  - `cache_creation` sub-object always summed correctly to `cache_creation_input_tokens` in every sample (0 mismatches).
  - `iterations[]`: exactly 1 element (mirror of top-level) in ALL ~11k local files; multi-element (advisor/fallback) never observed locally — walk defensively per ccusage precedent.
- `message.diagnostics.cache_miss_reason` = `{type, cache_missed_input_tokens}` (nesting confirmed against real data 2026-08-08); `type` ∈ {messages_changed, model_changed, previous_message_not_found, system_changed, tools_changed, unavailable} — tells you WHICH hidden component invalidated cache.
- `message.context_management.applied_edits`: always `[]` in samples; populated shape UNKNOWN — passthrough as ContextEdit event.
- `message.stop_reason`, `stop_details`, `isApiErrorMessage` (assistant records with ALL-ZERO usage exist adjacent to compactions — must be skipped when anchoring token totals).
- STREAMING SPLIT (dominant dedup case): one logical turn = multiple assistant records (thinking/text/tool_use as separate lines), each repeating IDENTICAL usage and the same `message.id`. Real measurement: 89 assistant records → 35 distinct message.id. Dedup key: (`message.id`, top-level `requestId`); both fields confirmed present.

## user records

- `message.content`: string OR array of `text`/`image`/`tool_result` blocks.
- tool_result appears TWICE: inline block `{type:"tool_result", tool_use_id, content, is_error}` AND sibling top-level `toolUseResult` (structured: Bash → {stdout,stderr,interrupted,...}; byte-identical text in 9/10 samples). NEVER count both — prefer `toolUseResult`, inline only as fallback.
- `isCompactSummary: true` → compaction summary record; content starts "This session is being continued from a previous conversation…". Pre-compaction history REMAINS in file. Multiple per file common (15 in one 5MB file).
- `isMeta`, `isSidechain` flags.

## tool_use (in assistant content)

`{type:"tool_use", id:"toolu_...", name, input, caller:{type:"direct"}}`. MCP names fully qualified `mcp__<server>__<tool>` (plugin servers: `mcp__plugin_<marketplace>_<name>__<tool>`). Tool JSON schemas NOT logged.

## Subagents

1. Task/Agent tool spawns → separate file `subagents/agent-<shortHex>.jsonl`, first record `parentUuid:null, isSidechain:true, agentId, slug`. **Join key CONFIRMED-NEGATIVE for `tool_use.id`, but a partial deterministic key exists — studied 2026-08-08, evidence below (PLAN risk 3).**
2. Team/SendMessage-named agents use the *same* code path as (1) — same file convention, `isSidechain:true`, `agentId`/`slug` fields — not a separate mechanism. The only observed difference is the wrapped `<teammate-message ...>` framing of the first user message when the spawning tool call carried a `name` (addressable-teammate) input, vs. plain prompt text otherwise. The earlier "longer hex agentId, no toolu linkage" note does not hold: across the full 2026-08-08 sample, all observed `agentId` hex suffixes were exactly 16 or 17 chars regardless of team/plain framing — no distinct "long hex" format was found.

### Join-key study (2026-08-08, F2)

Sampled 20 real parent sessions with `subagents/agent-*.jsonl` under `~/.claude/projects/` (most-recently-modified, including this machine's own team-heavy sessions). Method: matched each parent's `Task`/`Agent` `tool_use` blocks (id, input key names, `subagent_type`) against every child `agent-<id>.jsonl`'s first-record fields and `fork-context-ref` records. IDs/keys/counts only — no prompt or transcript content inspected.

- **`tool_use.id` never appears anywhere in a child file's bytes** (confirmed by direct grep of a known toolu id against its session's `subagents/` tree) — the parent↔child join via `tool_use.id` does **not exist on disk**. Confirmed absent, not just unconfirmed.
- 4 of the 20 sessions had **zero top-level** `Task`/`Agent` spawns despite having child files — those children live under nested `subagents/workflows/wf_<id>/...` trees, a wholly separate spawn mechanism (the `Workflow` tool) with no `tool_use` correlation surface at all; out of scope for this key (see `journal.jsonl` note above).
- The remaining 16 sessions yielded 306 top-level `Task`/`Agent` `tool_use` spawns, split three ways by `input.subagent_type` and presence of `input.name`:

  | Population | Count | % of 306 | Resolvable? |
  |---|---|---|---|
  | `name` set, `subagent_type != "fork"` | 141 | 46% | **Yes — 141/141 (100%)** via `agentId == "a" + sanitize(name) + "-" + hex` (name lowercased, spaces/underscores→hyphens). 140/141 names were unique within their session (1 duplicate name → ambiguous by name alone, still resolvable to "one of N" candidates). |
  | `subagent_type == "fork"` | 125 | 41% | No — `agentId` is always opaque hex, name never embedded, 0/125 matched. *Partial* signal: every fork child carries a `fork-context-ref` record (see table above; `contextLength` semantics still unverified) with `parentLastUuid` = the parent's last-message uuid at spawn time. This buckets fork children by spawning **turn/batch**, not by individual `tool_use` — parallel forks issued in one assistant message share one `parentLastUuid` (observed up to 6 children sharing a value). |
  | no `name` in input (schema-legal; seen with `subagent_type: general-purpose`) | 40 | 13% | No — opaque hex, zero content signal. |

- **Verdict: no single key resolves ≥95% of all spawns**, so v1's directory-listing fallback (`findChildRefs` in `parse.ts`, sorted by path — not actually timestamp-ordered despite the "directory+timestamp fallback" framing in docs/DESIGN.md) is left unchanged; `parse.ts` was not modified. The name-prefix key is 100% reliable but only covers a defined 46% subset — flagged as a documented, not-yet-implemented follow-up (a hybrid: emit correctly-matched `SubagentSpawn.childRef` for the named+non-fork 46%, leave the rest to the existing flat `Session.children` list).

## NOT in the logs (confirmed absent)

System prompt text; CLAUDE.md contents; MCP tool schemas/descriptions; skill instruction bodies; any running context-total field. → composition residual approach.

## Other ~/.claude stores

`history.jsonl` (all prompts, all sessions), `todos/`, `sessions/<pid>.json` (LIVE process registry), `shell-snapshots/`, `usage-data/`+`stats-cache.json` (uninspected rollups), `statsig/`, `jobs/`.
