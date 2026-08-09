# Recon: OpenAI Codex CLI local session format (2026-08-08)

From local ~/.codex (rollouts from cli 0.88.0 vintage + a REAL completed-turn capture at 0.134.0) cross-checked against codex-rs main. Parser-facing reference for T4.x.

## Where sessions live

`~/.codex/sessions/{yyyy}/{mm}/{dd}/rollout-{ISO8601-dashes}-{uuidv7}.jsonl` — uuidv7 = thread id.
NOT transcripts: `history.jsonl` (one line per top-level input: `{session_id, ts, text}`), `logs_2.sqlite` (OTel diagnostics), `goals_1.sqlite` (budget feature, empty), `state_5.sqlite` (session INDEX: `threads` table with rollout_path, tokens_used cumulative, model, cli_version, git fields; `thread_dynamic_tools` mirrors MCP schemas; `thread_spawn_edges` parent/child). macOS `sqlite3` CLI cannot open state_5/goals_1 (TCC quirk) — Python sqlite3 works.

## Line format

Every line: exactly `{"timestamp", "type", "payload"}` (3 keys — CONFIRMED at 0.134.0; main-branch `ordinal` field NOT yet shipping). `type` ∈: `session_meta`, `response_item`, `event_msg`, `turn_context`, `compacted`, `inter_agent_communication(_metadata)`, `world_state`. Version-gate on `session_meta.payload.cli_version`; unknown-field/variant tolerant.

## session_meta (line 1)

Keys observed: `id` (= filename uuid), `timestamp`, `cwd`, `originator` ("codex_exec"|...), `cli_version`, `source`, `model_provider`, `git` = a SUB-OBJECT `{commit_hash, branch, repository_url}` on payload (absent entirely when cwd isn't a git repo), **`base_instructions` = `{text: "<full system prompt verbatim, ~22KB>"}`** (object wrapper confirmed in real capture), `dynamic_tools` (when MCP configured): `[{name, description, input_schema, defer_loading} | {name, description, tools: [...]}]` (namespace spec's key is `name` per codex-rs DynamicToolNamespaceSpec) — **MCP schemas logged verbatim**. Newer fields (forked_from_id, parent_thread_id, context_window etc.) exist on main.

## turn_context (per turn; re-emitted after mid-turn compaction)

0.88-vintage shape: `{approval_policy, cwd, effort, model, sandbox_policy, summary, truncation_policy {mode:"bytes", limit:10000}, user_instructions}`. Real 0.134 capture shape: `{approval_policy, cwd, current_date, timezone, sandbox_policy, permission_profile, model, personality, collaboration_mode, realtime_active, summary, turn_id}` — significant drift; parse tolerant, all fields optional. **RESOLVED (capture #2, 2026-08-08, 0.134 exec mode WITH an AGENTS.md present): `user_instructions` is NOT the delivery path at 0.134 — AGENTS.md arrives as block 1 of a two-content-block user-role `message` response_item ("# AGENTS.md instructions for <cwd>\n\n<INSTRUCTIONS>…" + block 2 `<environment_context>` incl. current_date/timezone), with the actual task prompt as a separate later user message.** Keep `user_instructions` handling for 0.88-vintage files.
Also measured (capture #2): shell tool calls arrive as plain `function_call` named **`exec_command`** (args JSON-string {cmd, workdir, yield_time_ms, max_output_tokens}; output a formatted "Chunk ID/Wall time/exit code/Output:" block) — `local_shell_call` never observed; adapters must not special-case on it.

## response_item variants (`payload.type`, snake_case)

`message` (roles: `developer` = sandbox/permission text; `user` = AGENTS.md injection "# AGENTS.md instructions for <cwd>" wrapped `<INSTRUCTIONS>`, `<environment_context>` synthetic, actual task text; `assistant` = model output), `reasoning` (summary[] + content?; `encrypted_content` = opaque CoT — only summary readable), `function_call` (`arguments` is a JSON STRING — parse it), `function_call_output` (`output` is string OR `{content_items:[...]}` — dual wire shape, custom deserializer), `local_shell_call`, `custom_tool_call(_output)`, `tool_search_call/output`. `namespace` field routes MCP-server tools.

## event_msg variants (payload.type)

`user_message`, `agent_message`, `agent_reasoning`, `token_count`, `context_compacted` (MARKER ONLY, zero fields), `turn_started`/`turn_complete` (wire names `task_started`/`task_complete` with v2 aliases — don't assume variant name = tag).

### token_count (REAL example, 0.134.0 capture)
```json
{"info":{"total_token_usage":{"input_tokens":37476,"cached_input_tokens":1408,"output_tokens":5,
 "reasoning_output_tokens":0,"total_tokens":37481},
 "last_token_usage":{...same shape, per-turn...},"model_context_window":258400},"rate_limits":{...}}
```
- **SUBSET semantics: `cached_input_tokens` ⊂ `input_tokens`; `total = input + output`.** MEASURED.
- `cache_write_input_tokens`: `#[serde(default)]` on main; **ABSENT even at 0.134.0** → default 0.
- Per-turn = `last_token_usage`; cumulative = `total_token_usage`.

## compacted records (source-verified; no local example)

`{message: summary-text, replacement_history: ResponseItem[]?, window_number?, first_window_id?, previous_window_id?, window_id?}` — expect fresh `turn_context` right after. Legacy consumers see it converted to an assistant message.

## Recorded vs not

RECORDED (unlike Claude Code): full system prompt, AGENTS.md content, MCP tool schemas → near-exact composition possible. NOT recorded: raw HTTP bodies; encrypted reasoning plaintext.

## Real capture (ground truth fixture source)

`~/.codex/sessions/2026/08/08/rollout-2026-08-08T15-13-23-019fe370-1c75-7323-a8c7-3db2a673d0ce.jsonl` — 11 lines: session_meta, turn_context, response_item×4 (all `message`), event_msg×5 (incl. the token_count above). cli 0.134.0. Redact via scripts/redact.ts → `test/fixtures/codex/v0.134/real-capture-redacted.jsonl` (T4.2b). Trivial run — no function_call/reasoning/compacted examples; those fixture cases stay synthetic from the schemas above.
