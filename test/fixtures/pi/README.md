# pi fixtures

Synthetic pi coding-agent session files for adapter tests. Schema per
`docs/recon/pi.md` (source-verified against `earendil-works/pi` @ main,
v0.84.1). All content is fabricated — no real session data.

Directory naming follows pi's on-disk convention:
`sessions/--<cwd-with-/-replaced>--/<ISO-ts-colons-dots-to-dashes>_<uuid>.jsonl`.
All files here use `cwd: "/Users/fake/project"` → dir `--Users-fake-project--/`.

## Assumptions (not fully specified by recon — flagged for review)

- **Entry-level `timestamp`** (on `SessionEntryBase`) is written as an ISO
  string, matching `SessionHeader.timestamp`. **Message-level `timestamp`**
  (inside `AgentMessage` variants) is written as unix ms — recon states this
  explicitly only for `UserMessage`; applied consistently to
  `AssistantMessage` / `ToolResultMessage` / `BashExecutionMessage` /
  `CustomMessage` since they share the same `pi-ai` type lineage.
- **`SessionHeader.parentSession`** (case 5) is a filesystem path; recon
  marks it `/* FILE PATH */` but doesn't confirm absolute-vs-relative or the
  root it's relative to. Fixture uses an absolute path under
  `~/.pi/agent/sessions/...`.
- **`branch_summary.fromId`** semantics (which entry a summary originates
  from) inferred as "the entry being summarized" — set to the branch-point
  entry's id.
- Usage `cost` rates are invented-but-plausible (`$3/$15` per M input/output
  tokens, `$0.30`/`$3.75` per M cache read/write); `totalTokens` = sum of
  input + output + cacheRead + cacheWrite throughout.

### System B (harness v4) mutation-log shapes (Lane D, docs/DESIGN.md)

docs/recon/pi.md confirms only the envelope — `{kind: "header"|"entry"|
"record"|"lane"|"fact", seq}`, unix-ms timestamps, and that entries "carry
same AgentMessage lineage" as System A — and explicitly flags System B as
source-derived with less certainty than System A ("different lineage ... no
local data"). Everything below the envelope is this fixture's/
`src/adapters/pi/systemB.ts`'s own documented assumption, not a recon fact:

- **`kind:"entry"`** mirrors System A's tree-entry shape (`type`, `id`,
  `parentId`, `timestamp`, + type-specific fields) inside the `kind`/`seq`
  envelope, since recon says entries share System A's AgentMessage lineage.
  Only `type:"message"` and `type:"compaction"` are exercised/implemented —
  recon does not confirm any of System A's other entry types
  (`thinking_level_change`, `label`, etc.) exist in System B, so this fixture
  doesn't invent them; any entry `type` outside this pair gets a
  "pi-systemb-unrecognized-entry-type" warning and no Turn (forward-compat).
  Entry-level `timestamp` is unix ms (recon-stated); converted to an ISO
  string internally so it fits the same `PiEntry.timestamp: string` field
  System A entries use.
- **`kind:"entry", type:"compaction"`** (`CompactionEntry`) carries
  `retainedTail: AgentMessage[]` (recon-named field) instead of System A's
  `firstKeptEntryId`, plus `summary`/`tokensBefore`/`usage` fields assumed
  identical in shape to System A's compaction entry (unconfirmed by recon,
  but the most direct analogy available). `retainedTail`'s messages are
  **not** replayed as Turns — only their count is noted via a warning — since
  recon doesn't say whether they're also re-emitted as separate `entry`
  mutations later in the log; replaying them risked double-counting context,
  so this was left as a documented stop rather than an invented merge rule.
- **`kind:"record"`** (`UsageRecord`): ASSUMPTION — only records carrying a
  `usage.totalTokens` field are treated as a cumulative token-count sample
  (by direct analogy with codex's `total_token_usage.total_tokens`, since
  "mirroring the codex cumulative pattern" was the task's explicit
  instruction); the LAST such record in the file is cross-checked against
  Σ(turn.contextTotal + turn.usage.output) over the active path, warning
  ("pi-systemb-usage-record-mismatch") on >1% divergence. This fixture's
  compaction is EXPECTED to trigger that warning (a real discontinuity, not a
  parser bug) — mirrors src/adapters/codex/usage.ts's documented
  compaction.jsonl behavior exactly.
- **`kind:"lane"`**: ASSUMPTION — a lane mutation moves that lane's leaf
  pointer to `entryId`. The fixture has two lanes ("main", the one that
  proceeds to the session's end, and "explore", which branches off at
  `h1000002` and never advances further) to exercise "the lane with the
  latest seq leaf move wins; N other lanes ignored" per the task spec.
- **`kind:"fact"`**: ASSUMPTION — recon says "facts = name/label"; per task
  spec, `factType:"name"` facts are read but intentionally dropped (`Session`
  has no name field in `src/model/types.ts`) — silently, since this is a
  recognized-but-ignored kind, not an unrecognized one.
- Any `kind` other than the five recon-confirmed values (e.g. this fixture's
  trailing `{"kind":"telemetry",...}` line) is unrecognized: warned
  ("pi-systemb-unknown-kind") and skipped, never thrown.

## Files

### `system-a-v3/--Users-fake-project--/`

| File | Case | Contents |
|---|---|---|
| `2026-08-01T10-00-00-000Z_cb5b132f-….jsonl` | 1 — main session | header + `message` entries: user → assistant (toolCall, full `Usage` w/ precomputed `cost`) → toolResult → bashExecution (`excludeFromContext:true`) → `thinking_level_change` → `model_change`. Referenced as `parentSession` by the fork fixture (case 5). |
| `2026-08-01T11-30-00-000Z_18351767-….jsonl` | 2 — branched session | user → assistant (`b1000002`), then two assistant entries (`b1000003`, `b1000004`) both with `parentId:"b1000002"` — the branch point — then `b1000005` continues from `b1000004`. Active leaf = `b1000005` (last entry appended), demonstrating parent-pointer tree reconstruction. |
| `2026-08-01T12-45-00-000Z_6d816cb4-….jsonl` | 3 — compaction | 4 message entries, then a `compaction` entry (`c1000005`) mid-tree with `summary`, `firstKeptEntryId:"c1000003"` (a real, earlier entry id), `tokensBefore`, and `usage` (w/ cost) — followed by 2 more message entries continuing the tree past the compaction. |
| `2026-08-01T13-15-00-000Z_26ec89e6-….jsonl` | 4, 7 — misc entry types | user → assistant, then one each of `branch_summary` (w/ `fromId`, `summary`, `usage`), `custom` (`customType`+`data`, not in context), `custom_message` (`display:true`, is in context), `label` (`targetId`+`label`), `session_info` (`name`), and `future_entry` — an entry with an **unknown type**, to exercise forward-compat / unknown-type handling (case 7). |
| `2026-08-01T14-00-00-000Z_700d9363-….jsonl` | 5 — forked session | header has `parentSession` set to the path of the case-1 file (`/fork` semantics: new file, `parentSession` = source file path); own short entry chain. |

### `system-b-v4/`

| File | Case | Contents |
|---|---|---|
| `2026-08-01T16-00-00-000Z_b9f0fc61-….jsonl` | 6 — System B (harness v4), realistic session | header (`{"kind":"header","version":4,...}`, unix-ms timestamps) + a full mutation-log session: 4 `message` entries (2 user, 1 toolResult, 2 assistant — one pre- and one post-compaction — each assistant with full `Usage`+precomputed `cost`), one `compaction` entry (`retainedTail` of 2 `AgentMessage`s, `tokensBefore`, its own `usage`/`cost`), two `lane`s ("main", which reaches the final leaf, and "explore", an abandoned branch off the first assistant entry — exercises "latest-seq lane wins, N others ignored"), two `record`/`UsageRecord` cumulative samples (pre-compaction only — the post-compaction cross-check divergence is intentional, mirrors codex), one `fact` (`factType:"name"`, intentionally ignored), and one unrecognized `kind:"telemetry"` line (forward-compat warning). See the "System B (harness v4) mutation-log shapes" section above for the full assumption list. Parsed by `src/adapters/pi/systemB.ts`; exercised in `test/unit/pi-systemb.test.ts`. |

## Validation

Every `.jsonl` file was checked to parse as one JSON value per line via
`jq -e . <file>` (per-line) and `jq -c . <file> | wc -l` matching the raw
line count (no line contains multiple/partial JSON values).
