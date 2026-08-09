# Codex fixtures

Synthetic (fabricated content) JSONL session fixtures, per `docs/recon/codex.md`,
plus one real ground-truth capture. All uuids, timestamps, and text in the
synthetic files are made up; token usage numbers are small but arithmetically
consistent (`total = input + output`, `cached_input < input` on every
`token_count` record, per the recon's measured subset semantics).

Every line in every file is the 3-key `{timestamp, type, payload}` shape
(recon-confirmed at 0.134.0; no `ordinal` field anywhere — that's an
unshipped main-branch addition).

Case numbers below refer to the T4.1 task's required-case list.

## v0.88/ (old vintage — 3-key lines, no `ordinal`, no `dynamic_tools`)

| File | Cases covered |
|---|---|
| `basic-session.jsonl` | 1 — `session_meta` (cli_version 0.88.0, ~500-char synthetic `base_instructions`, flattened git fields, no `dynamic_tools`) → `turn_context` (`user_instructions` carrying AGENTS.md content + `truncation_policy` bytes/10000) → `response_item` messages (developer sandbox text, user AGENTS injection wrapped `<INSTRUCTIONS>`, user `<environment_context>`, user task) → `event_msg` `user_message`. No completed turn (mirrors the recon's real 0.88 observations — trivial run, no token_count/task_complete). |

## v0.134/ (current vintage — alongside the real capture)

| File | Cases covered |
|---|---|
| `real-capture-redacted.jsonl` | **Ground-truth reference** — real `codex exec` run at cli 0.134.0, redacted via `scripts/redact.ts` (T4.2b). Structure-preserving: field names/shapes are real, string content is scrambled. This is the source of truth for exact 0.134.0 field sets (see ambiguities below); do not modify. Trivial run — no function_call/reasoning/compacted examples. |
| `real-capture-tools-redacted.jsonl` | **Ground-truth reference #2** — real `codex exec` run at cli 0.134.0 forced to exercise tool calls (`rg --files` then `cat a.txt` via a plain `function_call` named `exec_command`, NOT `local_shell_call`) plus a real AGENTS.md file in cwd, redacted via `scripts/redact.ts`. 16 lines: `session_meta`, `event_msg`(`task_started`), `response_item`×2 (`message` developer, `message` user — AGENTS.md + `<environment_context>` as two content blocks in one message), `turn_context`, `response_item`(`message` user — task text), `event_msg`(`user_message`), `response_item`×4 (`function_call`×2, `function_call_output`×2), `event_msg`×2 (`token_count`, `agent_message`), `response_item`(`message` assistant), `event_msg`×2 (`token_count`, `task_complete`). Model was `gpt-5.5`. **Resolves the open AGENTS.md-injection question**: at 0.134.0, `turn_context.user_instructions` is absent entirely (confirms it's not how AGENTS.md is delivered here); AGENTS.md content instead arrives as the FIRST of two `input_text` content blocks in a single `user`-role `message` response_item — `"# AGENTS.md instructions for <cwd>\n\n<INSTRUCTIONS>\n<file contents>\n</INSTRUCTIONS>"` — with a second content block in the SAME message holding `<environment_context><cwd>...<shell>...<current_date>...<timezone>...</environment_context>`. The actual task prompt is a separate, later `user`-role message. **Redaction gaps (fixed)**: `scripts/redact.ts` previously only preserved a `STRUCTURAL_PREFIXES` match at the START of a string, so the nested `<INSTRUCTIONS>`/`</INSTRUCTIONS>` wrapper tags (embedded mid-string, not leading) got scrambled away along with the file content. Fixed by adding a `STRUCTURAL_TAGS` token-preserving scan (`scrambleWithTags`) that preserves `<INSTRUCTIONS>`, `</INSTRUCTIONS>`, `<environment_context>`, `</environment_context>`, `<cwd>`, `</cwd>`, `<shell>`, `</shell>`, `<current_date>`, `</current_date>`, `<timezone>`, `</timezone>` wherever they occur as whole tokens, scrambling only the text between them (same-length, deterministic), while preserving total string length. Also: `function_call.name` (`exec_command`) was being scrambled to gibberish since "name" wasn't allowlisted (unlike the synthetic fixtures below, which use plain-text tool names like `read_file`/`search_code` by construction). Fixed with a context-aware allowlist: `redactRecord` now checks whether the CONTAINING object has a `call_id`/`arguments`/`input_schema`/`tool_use_id` sibling key (i.e. it's structurally a tool-call or tool-spec object) before passing through `name`/`toolName` verbatim — a standalone `{"name": "..."}` with no such siblings still scrambles. This fixture was re-redacted with `scripts/redact.ts` after both fixes; `exec_command` and the AGENTS.md instruction tags are now readable in the redacted output. |
| `full-turn.jsonl` | 2 — complete single-turn session: `session_meta` WITH `dynamic_tools` (one plain `Function` spec `read_file` + one namespace spec `github` with 2 nested tools), `turn_context`, user message, `reasoning` (`summary[]` + opaque `encrypted_content`), `function_call` (JSON-*string* `arguments`, `namespace:"github"`) → `function_call_output` (string `output`), a second `function_call` (no namespace, plain tool) → `function_call_output` using the `{"content_items":[...]}` array shape, assistant message, `event_msg` `token_count` (subset semantics, `total = input + output`, `cached_input < input`, no `cache_write_input_tokens`), `event_msg` `task_complete` (wire name for `turn_complete`). |
| `compaction.jsonl` | 3 — session accumulates to a large `token_count` (input 214,300), then a `compacted` record (summary message, `replacement_history` with 2 `ResponseItem`s, `window_number:1`, `window_id`/`previous_window_id`/`first_window_id` uuids — `previous_window_id == first_window_id` since window 1 is the first compaction), immediately adjacent to the zero-field `context_compacted` event marker, followed by a re-emitted `turn_context` (new `turn_id`), a trailing post-compaction assistant `response_item` (added T4.5, so the post-compaction `token_count` below has a turn to attach to — exercises the null→exact `tokensAfterExact` fill on `finalizeCompactions`, not just the orphan-token-count case), and a post-compaction `token_count` showing the input-token drop (214,300 → 26,800 — context shrink). |
| `unknown-variant.jsonl` | 4 — tolerance cases: a `response_item` with unknown `payload.type` (`"future_item"`) and an `event_msg` with unknown `type` (`"agent_status_update"`), both carrying arbitrary/speculative fields a parser must not choke on. |

## Recon ambiguities encountered

- **`base_instructions` wire shape**: `docs/recon/codex.md`'s prose describes
  `base_instructions` as "FULL system prompt verbatim," which reads like a plain
  string. The real capture (`real-capture-redacted.jsonl`) shows it's actually
  `{"text": "..."}` — a nested object, not a bare string (confirmed by reading
  `scripts/redact.ts`, which never adds wrapping — the shape is preserved from
  the source). All fixtures here (both vintages) use the `{text: ...}` shape,
  since it's the only real evidence available and no counter-evidence suggests
  it changed between 0.88 and 0.134. Flagging in case a future 0.88-vintage
  capture shows otherwise.
- **`turn_context` field set differs between the recon's general description
  and the real 0.134.0 capture.** The recon's "## turn_context" section lists
  `{approval_policy, cwd, effort, model, sandbox_policy, summary,
  truncation_policy, user_instructions}` — but the real capture's `turn_context`
  has none of `effort`/`truncation_policy`/`user_instructions` and instead
  carries `current_date`, `timezone`, `permission_profile`, `personality`,
  `collaboration_mode`, `realtime_active`, `turn_id`. Resolved as: the recon's
  listed shape is what was cross-checked against 0.88-vintage local rollouts
  (matches the task's "mirrors the recon's real 0.88 observations" framing for
  `v0.88/basic-session.jsonl`, which uses it verbatim), while the schema
  evidently grew additional fields and dropped/renamed others by 0.134.0. All
  `v0.134/` fixtures here mirror the *real capture's* `turn_context` field set
  instead of the recon's generic list, since the real capture is explicitly the
  "real shapes at cli 0.134.0" reference. Not blocking, but worth confirming
  against another 0.134.x sample if one becomes available — this is the fixture
  set most likely to need a follow-up patch.
- **Flattened git fields naming**: the recon lists `git {commit_hash, branch,
  repository_url}` and separately notes "(flattened)." Interpreted as: no
  nested `git` object, the three fields sit directly on `payload` as
  `commit_hash`, `branch`, `repository_url` (used as-is, no `git_` prefix
  added). Did not invent alternate field names.
- **Namespace-spec nested-tools container key**: the recon says `dynamic_tools`
  entries are either a plain `{name, description, input_schema, defer_loading}`
  or "a namespace-spec with nested tools" but doesn't give the exact key name
  for the nested list. Used `{namespace, description, tools: [...]}` as the
  most natural mapping onto the flat spec's field names. Flagging for
  confirmation against a real MCP-configured capture if one becomes available.
