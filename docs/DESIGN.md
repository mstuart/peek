# peek — Design Reference

Living design reference for `peek` (npm `@mstuart/peek`). This document replaces
`docs/PLAN.md`, `docs/PLAN-V2.md`, and `docs/IMPLEMENTATION.md` (deleted
2026-08-08, consolidated here since both are fully implemented — v1 and v2
are shipped complete). It describes the system **as implemented**, not as
planned; see [Process provenance](#process-provenance) for how it was built
and where the historical planning/audit record lives.

## Positioning

The honest bar is **native tooling** first, competitors second:

- **Claude Code `/context`**: live window itemized into ~10 categories, exactly, free. peek never demos against it; peek's context feature is *historical* composition — ended sessions, cross-session trends, harnesses without `/context`.
- **Claude Code `/usage`**: live attribution to skills/subagents/plugins/MCP servers. peek's cost edge: historical beyond its window, per-session drill-down, cross-harness, `--json`, diff.
- **ccusage (17.8k★)**: cross-harness cost *totals* incl. Codex and pi, incl. weekly history. Conceded; peek's edge on the cost axis is attribution depth (per-tool/MCP/subagent within a session, cache-waste, miss-reason spikes) + composition + compaction + diff.
- **claude-devtools (3.8k★)**: 7 context categories, compaction visualization, per-subagent cost trees, headless Docker mode — Claude-Code-only, GUI-only (no CLI/`--json`), no diff; no code push since 2026-05-13. peek wins on cross-harness + scriptability + diff.
- **agent-replay** (tiny): cross-harness step-level trace diff; no composition/cost. Architecture validation only.
- **Watch item:** codex-rs `rollout-trace` (internal) reconstructs model-visible state from rollouts — OpenAI building this layer for Codex. Monitor.

**Pitch order (README): 1) `peek diff` (headline screenshot, curated session pair; `--last 2` gives it a zero-argument story), 2) compaction timeline + shrink/discard numbers, 3) historical cost attribution with miss-reason spike explanations, 4) historical composition (residual honestly labeled), 5) `report.html` shareable artifact. First documented command for a new user: `npx @mstuart/peek list`. The npm package name is `@mstuart/peek`; `peek` is the CLI binary name only, and this project does not claim the unrelated public npm package `peek`.**

### Non-goals

- No live instrumentation/capture/proxying; no orchestration; no GUI; no telemetry. Local-first; network only for opt-in pricing refresh.
- No sub-division of the hidden residual on harnesses that don't log it.
- Config A/B runner (`peek bench`) shipped in v2; v1 shipped `diff` as its primitive.
- pi adapter is best-effort (source-verified only; no real-session validation to date — see [Deferred / limitations ledger](#deferred--limitations-ledger)).

### Feature support by harness

| Feature | Claude Code | Codex † | pi ‡ |
|---|---|---|---|
| 1. Historical context composition | Partial: visible categories (char/4) + exact residual + cache_miss_reason signals | Partial-plus, **measured**: system prompt/AGENTS.md/MCP schemas logged & counted; residual 67.4% on the trivial real capture (server-side templates, built-in tool schemas, skills preambles are NOT in rollouts)† | Partial (like Claude Code, minus cache_miss_reason) |
| 2. Historical cost attribution | Full depth (usage fields, TTL split, dedup, subagents) | Usage-math semantics **measured** 2026-08-08†; per-tool attribution measured on a real multi-tool capture 2026-08-08; per-SUBAGENT depth n/a until a codex multi-agent capture exists | Full (Usage incl. precomputed cost) |
| 3. Compaction timeline | Yes (isCompactSummary; history retained) | Yes (compacted records + window lineage) | Yes (tokensBefore + summarization cost) |
| 4. Session diff | Yes | Yes | Yes |
| 5. Config A/B runner (`peek bench`) | Yes — self-hosted A/B gate passed with real agents | Partial — runner verified with a real trial; no orchestrated A/B yet | Not yet — deferred to v2.1 |

† **Codex footnote (applies to every Codex cell):** claims were originally source-derived with zero completed-turn local examples at recon time. A real ground-truth capture was taken 2026-08-08 (codex-cli 0.134.0, trivial `codex exec` run): usage semantics are **measured** — `total 37,481 = input 37,476 + output 5` with `cached_input 1,408` a subset of input (subset semantics confirmed); `cache_write_input_tokens` absent (default-0 rule required in practice); no `ordinal` field (3-key line format current). Composition is **measured** (2026-08-08): with base_instructions + dynamic_tools seeded, residual = 25,265 of 37,476 (67.4%) on the trivial capture — the original "near-exact" design hypothesis is **refuted** as stated: Codex rollouts omit server-side instruction templates, built-in tool schemas, and skills preambles. Honest claim: Codex logs strictly more than Claude Code (system prompt + AGENTS.md + MCP schemas → counted exactly), but a majority residual remains and is labeled as such. Attribution is also measured on a second real capture (`test/fixtures/codex/v0.134/real-capture-tools-redacted.jsonl`, two real `exec_command` tool calls): `peek cost` by-tool table attributes exec_command (2 calls, 2 results, ~153 tokens char/4 estimate); per-SUBAGENT attribution depth remains unmeasured — no Codex multi-agent capture exists yet. Compaction behavior is source-verified + fixture-proven; a real compaction capture is still pending.

‡ **pi footnote:** all pi cells are source-verified only; no real session data has been validated (see Deferred / limitations ledger). peek parses both of pi's session formats — System A and System B (harness v4) — but neither has been validated against real pi session data yet.

## Architecture

```
adapters/{claude,codex,pi}/  → parse native logs → Unified Session Model
model/                       types + invariants (the moat)
engine/                      dedup → accounting → composition → compaction → attribution
commands/                    list | cost | compactions | context | diff | report | bench | --json
pricing/                     vendored LiteLLM snapshot + models.dev fallback + opt-in refresh
```

### Unified Session Model (USM) — canonical types

These ship in `model/types.ts`. Do not add fields without updating this section first.

```ts
type HarnessId = "claude-code" | "codex" | "pi";

interface Adapter {
  harness: HarnessId;
  discover(roots?: string[]): Promise<SessionRef[]>;
  parse(ref: SessionRef): Promise<ParseResult>;
}
interface SessionRef { harness: HarnessId; id: string; path: string; cwd?: string;
                       sizeBytes: number; mtime: Date; kind: "main" | "subagent"; parentId?: string }
interface ParseResult { session: Session; warnings: ParseWarning[] }
interface ParseWarning { code: string; message: string; line?: number; recordType?: string }
// RULE: adapters NEVER throw on malformed/unknown records — warn and continue. Only unreadable files reject.

type CompositionCategory =
  | "userText" | "assistantText" | "thinking" | "toolResults" | "toolCallArgs"
  | "instructionInjection"   // CLAUDE.md/@-mentions on claude; AGENTS.md/user_instructions on codex
  | "systemPrompt"           // codex only (logged verbatim); empty elsewhere
  | "toolSchemas"            // codex only (dynamic_tools); empty elsewhere
  | "compactionSummaries" | "coordination";

interface Span {
  category: CompositionCategory;
  charCount: number;                         // over the SINGLE canonical source (see Accounting rules rule 5)
  text?: string;                              // omitted for large/offloaded content
  truncated: boolean;                         // source was capped/offloaded → estimate is a lower bound
  toolName?: string; mcpServer?: string;      // set for toolResults/toolCallArgs spans
  turnRole: "user" | "assistant" | "system";
}

interface CostBreakdown { input: number; output: number; cacheRead: number;
                          cacheWrite5m: number; cacheWrite1h: number; total: number;
                          mode: "display" | "auto" | "calculate"; priced: boolean } // priced=false → unknown model, token-only

interface CompactionEvent {
  kind: "compaction"; at: Date; turnIndex: number;
  tokensBeforeExact: number | null;   // last REAL usage total before the marker — skip zero-usage and
                                      // isApiErrorMessage records when anchoring
  tokensAfterExact: number | null;    // first real usage total after (INCLUDES the summary — it's cached as fresh input)
  shrinkExact: number | null;         // before − after. EXACT net context reduction; the headline number
  discardedEst: number | null;        // before − after + summaryTokensEst. Estimated original content discarded
                                      // (summary is NEW text inside `after`, so it adds back). Labeled estimate.
  summaryTokensEst: number; cost?: CostBreakdown | null;
  lineage?: unknown;                  // v2: codex window-lineage chain, when the log records it
}
interface SubagentSpawn { kind: "subagentSpawn"; at: Date; childRef: SessionRef; agentType?: string }
interface ContextEdit   { kind: "contextEdit"; at: Date; raw: unknown }   // applied_edits passthrough; populated shape unknown
interface ModeChange    { kind: "modeChange"; at: Date; field: string; from?: string; to: string }
interface ErrorEvent    { kind: "error"; at: Date; message: string; raw?: unknown }
type SessionEvent = CompactionEvent | SubagentSpawn | ContextEdit | ModeChange | ErrorEvent;

interface NormalizedUsage {           // ADDITIVE convention (Anthropic-style)
  inputUncached: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number;
  output: number; reasoningOutput?: number;
  raw: unknown;
}
// Codex conversion (MEASURED 2026-08-08): inputUncached = input_tokens − cached_input_tokens;
// cache_write_input_tokens absent → 0 (absent even on codex-cli 0.134.0).

Session { harness: HarnessId; harnessVersion: string; id; cwd; gitBranch?; startedAt; endedAt;
          configSnapshot { systemPrompt?; projectInstructions?; toolSchemas?; model; modelChanges: ModeChange[] };
          turns: Turn[]; events: SessionEvent[]; children: SessionRef[]; warnings: ParseWarning[] }
Turn { role; model; timestamp; contentSpans: Span[]; usage: NormalizedUsage;
       contextTotal: number; composition: Composition; cacheMissReason?: unknown; cost: CostBreakdown }
interface Composition { categories: Record<CompositionCategory, number>; residual: number;
                        residualShare: number; truncated: boolean }
```

**Invariants** (property-tested): `contextTotal = inputUncached + cacheRead + cacheWrite5m + cacheWrite1h` (exact, never tokenized); `Σ categories + residual = contextTotal` (negative residual reported as measured estimation error, never clamped); dedup precedes all aggregation.

## CLI surface

```
peek list                  # documented first command: cross-harness inventory (cost/tokens/compactions)
peek cost [sess|--all]     # historical attribution: model/tool/MCP server/subagent; cache waste; miss-reason spikes
peek compactions [sess]    # timeline: shrinkExact (headline), discardedEst (labeled), per-compaction cost
peek context [sess]        # historical per-turn composition (residual honestly labeled)
peek diff <a> <b>          # totals/composition/cost/compactions/config deltas
peek diff --last N         # N in 2..5. Selection algorithm:
                           #   candidates = sessions with same project scope (current cwd's slug /
                           #   git repo root; --cwd <path> overrides; --all-projects widens) AND
                           #   same harness, excluding kind:"subagent", ordered startedAt desc; take N.
                           #   N=2 renders the full two-way table; N>2 renders a compact pairwise-vs-first
                           #   table instead. Emits a comparability warning when sessions diverge strongly
                           #   on turn count, duration, or git branch.
peek report [sess] -o x.html  # self-contained shareable artifact; --diff <a> <b> renders a SessionDiff;
                               # --all renders a cross-session trends dashboard
peek bench run --suite <dir> --config-a <dir|current> --config-b <dir>  # config A/B regression runner
peek bench report -o bench.html
peek bench clean           # sweeps orphaned worktrees
peek pricing refresh       # opt-in network fetch of models.dev pricing snapshot
```

Global: `--json` everywhere, `--harness`, `--since`, `--cwd`, `--no-cache` (list).

## Accounting rules

1. **Totals exact** from usage fields. Anthropic additive; Codex subset (measured); pi additive per source.
2. **Dedup, pre-aggregation, two required fixture cases:** streaming split (dominant: 89 records → 35 message ids in one real session; key `message.id`+`requestId`) and sidechain replay (ccusage #913; fallback key, sidechain-loses, higher-total-wins). v2 adds **family-scope dedup** (dedup across a main session + its subagent files, not just per-file) to close the ccusage reconciliation gap — see [Measured results ledger](#measured-results-ledger).
3. **`usage.iterations[]` walked defensively** (zero multi-element instances in ~11k local files; ccusage-derived rule, cheap insurance).
4. **Cost:** vendored LiteLLM snapshot (verified: carries `cache_creation_input_token_cost`, `..._above_1hr`, `cache_read_input_token_cost` for Claude) → models.dev fallback → 2×-input hardcode only when the 1h field is absent → long-context tiering (Anthropic marginal >200k; OpenAI whole-request) → modes `display`/`auto`/`calculate` → unknown models degrade to token-only (`priced: false`). The models.dev fallback is cached-at-price-time, not live: `peek pricing refresh` (`src/commands/pricing.ts`, network opt-in) fetches models.dev and writes `${XDG_CACHE_HOME}/peek/models-dev.json`; `priceTurn` (`engine/accounting.ts`) does a lazy, synchronous, memoized read of that cache (silently ignored when absent, corrupt, or older than 30 days) before falling through to the 2×-input hardcode — zero network at price time, network only via the explicit refresh command (`src/pricing/modelsDev.ts`, `src/pricing/refresh.ts`).
5. **Composition spans:**
   - **Tool results: exactly one source** — `toolUseResult` preferred, inline `tool_result` only when absent (byte-identical in 9/10 sampled records; both = double-count).
   - **Thinking:** see [Composition semantics](#composition-semantics) below.
   - Residual = exact total − Σ estimates, labeled "system prompt + tool schemas + framing (not logged by this harness)". Codex: measured residual is the published accuracy metric. Claude: `cache_miss_reason` annotates when hidden components changed and the cost.
   - Truncated sources (Codex 10KB `user_instructions` cap, offloaded `tool-results/`) → `truncated: true`, lower-bound estimates.

## Composition semantics

`CompositionCategory` (see USM block above) partitions each turn's context into
labeled spans plus an honestly-named residual. Two rules govern the split:

- **`thinking` is forced to 0 for claude-code and pi** — prior-turn thinking is stripped on resend (per Anthropic's documented behavior) and current-turn thinking is output, not input. On codex, reasoning items ARE resent (Responses API): plaintext reasoning-summary spans count toward `thinking`; `encrypted_content` is unmeasurable and lands in residual. This was checked empirically against a real thinking-heavy session (T2.5, 2026-08-08): the local check was **confounded** by char/4 drift (residual growth exceeded total thinking mass in 2 of 3 probed sessions, so resend cannot be the sole driver) — the exclusion rule stands on Anthropic's documentary evidence, "consistent-but-not-proven locally."
- **Reset/accumulator rule:** composition is computed per-turn from that turn's `Span[]`, never accumulated across turns — each turn's `Composition` is self-contained (`Σ categories + residual = contextTotal` for that turn). Composition consumes **deduped** turns only, never raw parse output (dedup precedes all aggregation, per the pipeline order in Architecture).

## Compaction detection

Claude Code: `isCompactSummary` records; anchoring per `CompactionEvent` (real failure case: adjacent `isApiErrorMessage` all-zero record vs true ~844k prior context — anchoring skips zero-usage/error records). Codex: `compacted` records (+`replacement_history`, window lineage) + re-emitted `turn_context`. pi: `CompactionEntry` (tokensBefore + usage). `applied_edits` → `ContextEdit` passthrough.

**Worked example** (real session, used by the compaction engine's unit tests): `tokensBeforeExact = 844,000`, `tokensAfterExact = 54,437` (= 30,581 cache-write of the fresh summary + 23,856 cache-read retained), `summaryTokensEst ≈ 30,581` → `shrinkExact = 844,000 − 54,437 = 789,563`; `discardedEst = 844,000 − 54,437 + 30,581 = 820,144`. Degenerate check: summary exactly replacing everything → `shrinkExact = 0`, `discardedEst` = full original size.

## Bench design (`peek bench`)

Config A/B regression runner: re-runs a task suite against two config variants and diffs the results using peek's own accounting engine.

### Task suite

`.peek/bench/*.json` (JSON, not YAML — zero new runtime deps), one task per file:
```json
{ "name": "fix-flaky-test",
  "prompt": "Fix the failing test in tests/date.test.ts",
  "setup": ["git checkout -- ."],
  "verify": "npm test",
  "timeoutS": 600 }
```
`verify` exit 0 = success; no LLM-judge. Process-spawn contract shared by all runners (`src/bench/proc.ts`): `spawnDetached(cmd, args, {cwd, env, timeoutMs}): Promise<{exitCode: number|null, timedOut: boolean, stdout: string, stderrTail: string}>` — `detached:true` fresh process group, timeout kill via `process.kill(-pid, SIGTERM)` then SIGKILL after 10s.

### Config variants

`peek bench run --suite .peek/bench --config-a <dir> --config-b <dir>`; a config dir contains any of: `CLAUDE.md`, `AGENTS.md`, `.claude/settings.json` (**a COMPLETE file, not a fragment** — Claude Code never merges within one file, and silently ignores invalid settings files in headless mode, so partial overlays silently drop keys and malformed ones silently no-op), `model` (one-line file). Baseline (`--config-a current`) = whatever the repo has. Application is FILE OVERLAY into the trial workspace only (the user's real config is never touched). The runner **JSON-validates every written settings file and hard-fails the trial loudly on parse failure**. Global (`~/.claude`) config is **not** varied — repo-level only; this is a documented limitation, not a bug. Worktree isolation is a filesystem convention, not a sandbox — bench runs agents with your user's OS permissions; only run trusted task suites.

### Trial isolation

Each trial runs in a fresh `git worktree` of the target repo (or a tmp copy when not a git repo; `--skip-git-repo-check` is load-bearing only for that fallback) under the scratch area; trials are **serialized** (one at a time — removes all transcript races); agent child processes are spawned `detached: true` (fresh process group) and killed on timeout via `process.kill(-pid, "SIGTERM")` then SIGKILL after 10s — never bare `kill(pid)` (claude spawns MCP-server children in the inherited group; bare kill leaks them, and group-killing an inherited group risks killing the caller too).

- **claude-code**: `claude -p "<prompt>" --output-format json --permission-mode acceptEdits --max-budget-usd <per-trial-cap>` (+ `--model` when the variant specifies). Transcript path is **constructed, never discovered**: stdout JSON carries `session_id` → `~/.claude/projects/<slugify(cwd)>/<session_id>.jsonl` (the slug is not collision-free — `/foo-bar/baz` and `/foo/bar-baz` collide — so directory discovery is forbidden; the session-id path is exact). `permission_denials` from the result JSON are recorded per trial.
- **codex**: `codex exec --skip-git-repo-check -s workspace-write <non-interactive-approval-flag> "<prompt>"` (model via `-m`). Rollout matched by parsing candidate files' line-1 `session_meta.payload.cwd` == the trial worktree path (exact, race-free even if serialization is ever relaxed) — never newest-file recency.
- **pi**: deferred to v2.1 (the `BenchRunner` interface below is harness-agnostic; a pi stub errors clearly).

### Canonical runner interface

```ts
interface BenchRunner {
  harness: HarnessId;
  run(trial: TrialSpec): Promise<TrialOutcome>;   // spawns, waits, kills on timeout
}
interface TrialSpec { task: BenchTask; configName: string; workspaceDir: string;
                      model?: string; timeoutS: number; perTrialBudgetUsd?: number }
interface TrialOutcome { exitCode: number | null; timedOut: boolean; wallMs: number;
                         sessionPath?: string;    // resolved transcript/rollout path
                         stderrTail: string;      // last 2KB verbatim (version-drift forensics)
                         raw?: unknown }          // harness result JSON (claude) when available
interface TrialResult extends TrialOutcome {      // written to results.jsonl, one per trial
  taskName: string; configName: string; harness: HarnessId; trialIndex: number;
  verify: { exitCode: number | null; passed: boolean };
  totals?: SessionTotalsLike;                     // from parsing sessionPath with peek's adapters
  startedAt: string }
```

### Metrics & output

Success (verify exit code), wall-clock, then the core idea: parse the trial's own session log with peek's adapters → tokens (exact), cost, compactions, composition. `N` trials per config per task (`--trials N`, default 1). `peek bench run` writes `bench-results/<timestamp>/results.jsonl` (one row per trial) + prints an A/B table (per task: success a/b, median tokens, median cost, compaction counts, deltas). `peek bench report -o bench.html` renders the comparison. Config deltas surface via the diff engine's config-hash approach.

### Safety/cost rails

Every run prints an upfront estimate line ("N tasks × M trials × 2 configs = K agent runs"); `--yes` to skip the confirm prompt; per-trial timeout kills the detached process group (see Trial isolation); per-trial hard cap via claude's native `--max-budget-usd` (codex has no equivalent flag — codex trials rely on timeout + the cross-trial ceiling); cross-trial ceiling `--max-cost <usd>` aborts between trials when the running parsed spend crosses it (best-effort, from completed trials' logs). Cleanup: `git worktree remove --force` in finally; `peek bench clean` sweeps orphans.

## Other v2 subsystems

Shipped alongside `peek bench`; each closes a specific gap left by v1.

### Totals cache (list performance)

`~/.cache/peek/totals-v1.jsonl` (schema-versioned filename): one row per session file — `{path, mtime_ms, size, harness, totals, turns, compactions, startedAt, cwd, model}` — exactly what `list` renders. On `list`: stat every discovered file, parse only rows with an mtime/size mismatch or absent from the cache, rewrite the cache append-only with periodic compaction (rewrite when >2x live rows). `--no-cache` bypasses it; cache misses print nothing (silent). Corruption-safe: an unreadable cache is ignored and rebuilt. See `docs/PERF.md` for the measured warm/cold numbers and `docs/DESIGN.md`'s Measured results ledger above for the headline figures.

### `cost --all` cross-session attribution merge

Merges `byTool`/`byMcpServer`/`byModel` across sessions (post family-dedup): span-level accumulation keyed on `(toolName, mcpServer)`. Adds `--by tool|mcp|model` selector to narrow output to one table. Honesty rules (estimates labeled `~`) are unchanged from the single-session case.

### pi System B (harness v4) adapter

Per `docs/recon/pi.md`, System B is a JSONL mutation log: `{kind: header|entry|record|fact|lane, seq}`; entries carry the same `AgentMessage` lineage as System A; compaction happens via `retainedTail`. Mapped to the USM as: entries → turns/spans (reusing System A span logic where messages align), the `UsageRecord` stream → per-turn usage cross-check, lanes → branches (the active lane's leaf is the path), `facts(name)` → session name. The SQLite backend described in some pi documentation is **not** implemented — JSONL only. This replaced the earlier detect-and-skip warning for System B files.

### Report v2

`report.html` gained per-turn expandable span tables (`<details>`/`<summary>` — still zero JS), a cost-attribution section (byTool/byMcpServer tables), a compaction-lineage strip for Codex, and `peek report --diff <a> <b> -o` rendering a `SessionDiff` as HTML (reusing the diff engine + HTML renderer). `peek report --all` (the cross-session trends dashboard) shipped after v2's lane work, covered under Measured results ledger.

## Measured results ledger

Every entry below is a real, reproducible measurement, dated.

- **T2.5 ccusage reconciliation (2026-08-08):** peek matches ccusage EXACTLY (0.00% every component incl. cost) at matching scope — per-file for simple sessions, family (main+subagents) for ccusage's session grouping (34-file session exact). Named residual on the 210-file multi-subagent family: peek +1.6–5.9% because peek deduped per-file while ccusage dedups corpus-wide — quantified as 319 cross-file replay turns / ~76M tokens → family-scope dedup shipped as an engine refinement (Accounting rule 2) to close this gap.
- **Codex composition residual (2026-08-08):** measured at 67.4% (25,265 of 37,476 tokens) on the trivial real capture, post-seeding of `base_instructions` + `dynamic_tools`. Refutes the original "near-exact" hypothesis as stated — see the Codex footnote in Positioning.
- **Codex usage semantics (2026-08-08):** `total 37,481 = input 37,476 + output 5`, `cached_input 1,408` confirmed a subset of input; `cache_write_input_tokens` absent even on codex-cli 0.134.0.
- **`peek bench` self-hosted A/B gate (2026-08-09):** 1 task × 2 configs (`current` vs `model=haiku`), real claude-code agents, serialized worktree trials, run against this repo — both passed `verify`; config-b **−93.4% cost** ($0.5833 → $0.0383), **−19.1% tokens**, **+1.1s wall**. The gate also caught and fixed one real bug (`slugify` must map ALL non-alphanumerics, not just `/` — regression-tested) and surfaced that worktree trials require a repo with ≥1 commit.
- **Real-corpus parse gate:** **100%** parse success — 2,000 most-recently-modified Claude Code sessions (of 11,065 discovered, 2.8GB corpus) plus all 4 real Codex rollouts on disk; 67,458 turns, zero parse failures (`test/local.integration.test.ts`, `PEEK_LOCAL=1`).
- **Performance (against 11,159 real local files, 2.68GB):** single-session `context`/`cost` runs 28–30ms (70× inside budget); a 210-file multi-subagent family finishes in ~1.05s (28× inside budget). `peek list` cold (all-miss, single-threaded JSON parse floor) stays at 6.18s; the v2 persistent totals cache (path+mtime+size keyed, under `XDG_CACHE_HOME`) makes every run after the first **warm: 0.21s** on the full 7,526-session corpus (26× inside the 1.5s bar, 0 re-parses); `--no-cache` forces a full re-parse (~5.9s). `peek report --all` (cross-session dashboard) measured at 0.223s wall, cache-warm, on the same corpus.
- **Privacy audit (2026-08-08):** 0 leaks across everything that would ship, 0 network calls anywhere in `src/`. 3 high-severity redactor gaps found and fixed same day (depth-unaware key allowlist, 8-char passthrough, missed Codex `branch` field); regression tests now lock the fix in. See `docs/PRIVACY-AUDIT.md`.
- **Claude parent↔subagent join-key study (2026-08-08, 20-session/306-spawn sample):** `tool_use.id` confirmed absent from child files. A partial key — `agentId == "a" + sanitize(input.name) + "-" + hex"` — is 100% reliable (141/141) but covers only 46% of spawns (fork spawns 41%, unnamed spawns 13% unresolvable by content). Below the ≥95% bar for a general fix; directory-fallback ships unchanged. See [Deferred / limitations ledger](#deferred--limitations-ledger).

## Deferred / limitations ledger

Numbered items below are the original design-time risk register; status is updated in place rather than renumbered, so citations like "risk 3" or "risk 6" continue to resolve to the same item.

1. **Schema drift.** Both directions → unknown-tolerance + version-gating + per-vintage golden fixtures. Continuous by nature (live example: codex-cli 0.134.0 choked on a models-API `max` variant added server-side).
2. **Codex composition/compaction claims.** RESOLVED — measured (see Measured results ledger). Real compaction capture is still pending (a naturally long Codex session hasn't been captured yet); compaction detection itself is source-verified and fixture-proven.
3. **Claude parent↔subagent join key.** RESOLVED as a negative result — studied 2026-08-08 (306-spawn sample): no key clears the ≥95% bar for a general fix; directory-structure + path-sort fallback ships as-is (not timestamp-ordered, despite earlier wording implying otherwise). The 46% named-subset key (100% reliable within that subset) is a documented, **not-yet-implemented** follow-up: wiring correctly-matched `SubagentSpawn.childRef` for the named+non-fork 46% while leaving the rest to the existing flat `Session.children` list.
4. **pi is source-verified only.** No real pi session data has been validated against either adapter format (System A or System B) to date. System B's SQLite backend is explicitly **not** implemented — JSONL-only.
5. **char/4 error material on code-heavy spans.** Published as a measured per-turn aggregate error rather than hidden.
6. **Privacy.** Real logs never leave the machine; synthetic fixtures only in the repo (plus two redacted real captures, audited — see Measured results ledger); `PEEK_LOCAL=1` integration opt-in, excluded from CI.

Additional deferred items from the v2 lane plan:

- **pi bench runner** — deferred to v2.1; the `BenchRunner` interface is harness-agnostic so it slots in without redesign.
- **Codex bench A/B** — the codex runner is verified with one real trial (A3) but hasn't been exercised through a full orchestrated A/B comparison yet.
- **Per-subagent Codex cost attribution** — n/a until a Codex multi-agent capture exists.
- **Global (`~/.claude`) config is not varied by `peek bench`** — repo-level overlay only, by design (v2.0 scope).
- **`peek diff --last N` is capped at N=5** — N>2 renders a compact pairwise-vs-first table rather than the full two-way report; no further generalization planned.
- **`fork-context-ref.contextLength` semantics** — unverified: whether it should count toward context totals for fork-spawned subagents remains an open empirical question (needs a larger 2.1.198+ corpus sample).

## Process provenance

This document is the living reference; it describes the system as
implemented. `peek` was developed with multi-round adversarial design and
correctness review — successive rounds drove the open finding count from 27
down to 0 before v1 shipped, with each round's findings addressed before the
next began.
