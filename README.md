<div align="center">
  <img src="docs/assets/logo.svg" alt="peek — devtools for coding agent sessions" width="720">
</div>

<p align="center"><strong>See inside your coding agent's sessions — composition, cost, compactions, and config A/B — across Claude Code, Codex, and pi.</strong></p>

<p align="center">
  <a href="https://github.com/mstuart/peek/actions/workflows/ci.yml"><img src="https://github.com/mstuart/peek/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933.svg" alt="Node >=20">
  <!-- BADGES: deepwiki + socket to be inserted (verified URLs pending research-badges) -->
</p>

<p align="center">
  <a href="#get-started-60-seconds">Install</a> ·
  <a href="#proof">Proof</a> ·
  <a href="#compared-to">Compared to</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#bench">Bench</a> ·
  <a href="#status--limitations">Status</a>
</p>

---

peek parses the session logs your coding agent already writes to disk — Claude Code, Codex, pi — no live instrumentation, no proxying, no telemetry. Three properties make it different:

- **Exact totals, never re-tokenized** — every number comes straight from each harness's own usage fields; peek's totals reconcile against [ccusage](https://github.com/ccusage/ccusage) at 0.00% delta on every component, including cost, at matched scope.
- **Honest composition, not vibes** — categories are labeled `~` when estimated and exact when not, the residual is named ("system prompt + tool schemas + framing (not logged by this harness)") instead of hidden, and hypotheses that don't hold up — Codex's original "near-exact" composition claim — get published as refuted, not quietly dropped.
- **Config A/B with real agents** — `peek bench` re-runs your own task suite under two config variants and diffs the results using peek's own accounting; the self-hosted demo below is a real run, not a projection.

## What you get

- **`peek list`** — cross-harness inventory of every discovered session: cost, tokens, compactions, warm in 0.21s via the totals cache.
- **`peek context`** — per-turn context composition for an ended session, residual named honestly.
- **`peek cost`** — cost attribution down to model/tool/MCP server, with `--all` merging across every session.
- **`peek compactions`** — the compaction timeline: what shrank, what was discarded, codex window lineage when present.
- **`peek diff`** — composition/cost/config diff between two sessions, or `--last N` (2 to 5) across recent runs.
- **`peek report`** — a self-contained, shareable HTML artifact (also renders a diff with `--diff <a> <b>`).
- **`peek report --all`** — a cross-session trends dashboard: day-bucketed cost/tokens, per-project and per-harness breakdowns, ≈0.2s cache-warm.
- **`peek bench`** — re-run your own task suite under two config variants and diff the results with real agents.

## Proof

<p align="center"><img src="docs/assets/proof.svg" alt="peek list cold vs warm, and peek bench cost A/B, both measured on real runs" width="680"></p>

Every number below is measured, not estimated — reproduce with the pointer in each row.

| Claim | Measured | Reproduce |
|---|---|---|
| Totals reconcile against ccusage | 0.00% delta, every token class + cost, at matched scope | `docs/DESIGN.md` § Measured results ledger |
| Real-corpus parse success | 100% — 2,000 most-recently-modified Claude Code sessions (of 11,065 discovered), 67,458 turns, 0 parse failures (point-in-time; the corpus grows) | Verify methodology: `test/local.integration.test.ts` (`PEEK_LOCAL=1`) |
| `peek bench` self-hosted A/B gate | `current` vs `model=haiku`: both passed `verify`; config-b −93.4% cost ($0.5833→$0.0383), −19.1% tokens, +1.1s wall | `docs/DESIGN.md` § Measured results ledger; `docs/examples/bench-report.txt` |
| `peek list`, cold vs warm | 6.18s cold (all-miss) → 0.21s warm (totals cache, 7,526 hits, 0 re-parses) | `docs/PERF.md` § "v2 Lane B result" |
| Codex "near-exact" composition hypothesis | Refuted, published as a correction: residual measured at 67.4% on a real capture, not hidden or restated as success | README's Codex footnote below; `docs/BUILDLOG.md` |

## Compared to

The honest bar is native tooling — Claude Code's own [`/context`](https://code.claude.com/docs/en/context-window) and [`/usage`](https://code.claude.com/docs/en/costs#track-your-costs) already do live composition and attribution for free, and peek never demos against them; its edge is *historical* analysis (sessions that already ended) across three harnesses `/context` doesn't reach at all.¹

| | Live context view | Historical composition | Cross-harness | Compaction analysis | Cost attribution depth | Session diff | CLI + JSON |
|---|---|---|---|---|---|---|---|
| Native `/context` + `/usage` | Yes — exact, free | No | No | No | Live only (skills/subagents/plugins/MCP) | No | No — slash commands, not scriptable |
| [ccusage](https://github.com/ccusage/ccusage) (17.8k★) | No | No | Yes — cost totals | No | Totals only; no per-tool/MCP/subagent depth | No | Yes — `-j/--json` |
| [claude-devtools](https://github.com/matt1398/claude-devtools) (3.8k★) | No | Yes — 7 categories | No — Claude Code only | Yes — visualization | Yes — per-subagent cost trees; Claude Code only | No | No — GUI only |
| [agent-replay](https://github.com/clay-good/agent-replay) | No | No | Yes — step-level trace | No | No | Yes² — step-level trace diff | Yes — `--json` on `list`/`show`/`diff` |
| **peek** | No — historical only, by design | Yes | Yes — Claude Code, Codex, pi | Yes — shrink/discard timeline | Yes — per-tool/MCP/subagent, cache-waste, miss-reason spikes | Yes² — headline feature | Yes — `--json` everywhere |

¹ Two concessions, stated plainly: ccusage (17.8k★) already does cross-harness cost *totals*, including weekly history — peek's edge there is attribution *depth* (per-tool/MCP/subagent, cache-waste, miss-reason spikes), not totals themselves. claude-devtools (3.8k★) already does 7-category composition and per-subagent cost trees with a headless Docker mode — but Claude-Code-only, GUI-only (no CLI/`--json`/diff), and hasn't had a code push since 2026-05-13; peek's edge is cross-harness support, scriptability, and diff.

² *Session diff* isn't apples-to-apples between the two "Yes" rows: agent-replay diffs at the step level (individual actions in a trace); peek diffs at the whole-session level (composition/cost/token/compaction/config) — a different granularity, not a superset or subset of the other.

## When to use · When to skip

**Great fit if you…**
- run Claude Code, Codex, or pi and want historical composition/cost/compaction analysis after a session ends, not a live dashboard
- want to A/B a `CLAUDE.md`/`AGENTS.md`/config change against real agent runs before committing to it
- want cross-harness cost attribution deeper than totals — per-tool, per-MCP-server, per-model, per-subagent

**Skip it if you…**
- want live, in-session monitoring — Claude Code's own `/context` and `/usage` already do that, for free, and peek never demos against them
- only need cross-harness cost totals — ccusage already does that well
- only use Claude Code and want a GUI — claude-devtools has 7-category composition and per-subagent cost trees in a headless-Docker GUI

## Get started (60 seconds)

Requires Node 20+.

peek isn't published to npm yet, so `npx peek-agent list` won't resolve. Install from source instead:

```sh
git clone https://github.com/mstuart/peek.git && cd peek
npm install && npm run build
node dist/cli.js list
```

Prefer a global `peek` command? `npm install -g github:mstuart/peek` works too (builds automatically via the `prepare` script). (Once published to npm, `npx peek-agent list` will work directly.)

```
# real output: peek list, run against fixture sessions (docs/examples/list-basic.txt)
harness      session   cwd                          started           turns  tokens     cost  compactions
pi           cb5b132f  /Users/fake/project          2026-08-01 10:00      4    1.6k        —            0
pi           18351767  /Users/fake/project          2026-08-01 11:30      4    2.3k        —            0
pi           6d816cb4  /Users/fake/project          2026-08-01 12:45      6    5.5k        —            1
pi           26ec89e6  /Users/fake/project          2026-08-01 13:15      2     900        —            0
pi           700d9363  /Users/fake/project          2026-08-01 14:00      2     500        —            0
codex        real-cap  /…/5DuD7LDKZU/FRd8m1Q7N8L07  2026-08-08 22:13      4   37.5k        —            0
claude-code  sess-com  /Users/fixture/project       2026-08-01 15:00      3   23.0k    $0.04            1
claude-code  sess-nor  /Users/fixture/project       2026-08-01 10:00      2    3.4k  $0.0086            0
```

Every other command below (`context`, `cost`, `compactions`, `diff`, `report`, `bench`) works the same way: point it at a session id or path, or let it resolve to the most recently modified session.

## Commands

**1. `peek diff` — composition/cost diff between two sessions.**

```sh
peek diff <session-a> <session-b>
```

```
# real output: peek diff test/fixtures/claude-code/v2.1.104/cache-heavy.jsonl test/fixtures/claude-code/v2.1.104/compaction.jsonl
# (docs/examples/diff-claude-pair.txt)
peek diff

field     a              b              
id        cache-heavy    compaction     
harness   claude-code    claude-code    
version   2.1.104        2.1.104        
model     claude-opus-5  claude-sonnet-5
turns     2              3              
duration  1m4s           25s            

totals
class                 a       b        Δ         %
input (uncached)    350  15,200  +14,850  +4242.9%
cache read          200   5,800   +5,600  +2800.0%
cache write (5m)  1,400   2,000     +600    +42.9%
cache write (1h)  1,000       0   -1,000   -100.0%
output              200     750     +550   +275.0%

cost
  $0.03 → $0.04   Δ +$0.02 (+72.1%)

composition (final turn)
category                  a      b       Δ
user text               ~19     ~0     -19
assistant text          ~24    ~15      -9
compaction summaries     ~0    ~40     +40
residual              1,157  2,945  +1,788
  system prompt + tool schemas + framing (not logged by this harness)

compactions
  a: 0 compaction(s), shrink 0, discarded ~0
  b: 1 compaction(s), shrink 17,000, discarded ~17,040

config
  model: changed (claude-opus-5 → claude-sonnet-5)
  harness version: unchanged (2.1.104)
  system prompt: unknown
  project instructions: unknown
…
```

No session ids handy? `peek diff --last N` (N from 2 to 5) diffs your most recently modified sessions instead — N=2 renders the same full table shown above; N>2 renders a compact pairwise-vs-first comparison.

**2. `peek compactions` — the compaction timeline: what shrank, what was discarded.**

```sh
peek compactions sess-a1b2c3
```

```
# real output: peek compactions test/fixtures/claude-code/v2.1.104/compaction.jsonl
# (docs/examples/compactions-claude.txt)
peek compactions — claude-code · compaction · /Users/fixture/project

turn  when              before  after  shrink  ~discarded  ~summary  cost
   3  2026-08-01 15:00  20,000  3,000  17,000     ~17,040       ~40     —
```

Codex compactions also carry window lineage (the chain of window ids across a session's compaction history) when the log records it.

**3. `peek cost` — historical cost attribution, down to tool and MCP server.**

```sh
peek cost sess-a1b2c3
```

```
# real output: peek cost test/fixtures/claude-code/v2.1.104/tool-use-names.jsonl
# (docs/examples/cost-claude-tools.txt; also breaks out `by MCP server`, omitted here)
peek cost — claude-code · tool-use-names · /Users/fixture/project

total: $0.0067  (3,000 tokens)

by model
model            turns  tokens     cost
claude-sonnet-5      2   3,000  $0.0067

by tool (token share is a char/4 estimate)
tool       mcp server                calls  results  ~tokens
get_issue  github                        1        1      ~39
run_lint   plugin_acme-tools_linter      1        1      ~19

cache: 33% hit rate, 0 tokens re-billed on 0 documented misses
```

`--all` merges cost across every discovered session — including the per-tool/MCP/model tables, dedup-safe across subagent families — and `--by tool|mcp|model` narrows human-readable output to one table.

**4. `peek context` — per-turn context composition for an ended session.**

```sh
peek context sess-a1b2c3
```

```
# real output: peek context test/fixtures/claude-code/v2.1.104/normal-turns.jsonl
# (docs/examples/context-basic.txt; a second turn follows the same shape)
peek context — claude-code · normal-turns · /Users/fixture/project

Turn 1  assistant  claude-sonnet-5  contextTotal 1,500
  category       tokens  share
  userText           ~9  ░░░░░░░░ 1%
  assistantText      ~8  ░░░░░░░░ 1%
  toolCallArgs      ~13  ░░░░░░░░ 1%
  residual        1,470  ████████ 98%  system prompt + tool schemas + framing (not logged by this harness)
```

**5. `peek report` — a self-contained, shareable HTML artifact.**

```sh
peek report sess-a1b2c3 -o report.html
```

```
# real output: peek report test/fixtures/claude-code/v2.1.104/normal-turns.jsonl -o report.html
# (docs/examples/report-basic.txt): prints the resolved output path, nothing else
<repo>/report.html
```

The file contains only aggregated numbers, model/tool names, and a shortened working-directory path (home directory swapped for `~`, long paths mid-truncated) — never message content — so "shareable" is a claim you can check by opening it.

`--all` renders a cross-session trends dashboard instead (day-bucketed cost/tokens, per-project and per-harness breakdowns; default window is the trailing 30 days, widened with `--since`) — measured at 0.223s wall against this machine's real 11k-file/7,526-session corpus, cache-warm (same corpus as the `list` cold/warm numbers in [Proof](#proof)).

## Bench

Every command above is read-only, historical analysis. `peek bench` is the one command that runs agents: it re-runs your own task suite under two config variants — a `CLAUDE.md`/`AGENTS.md`/`.claude/settings.json`/`model` overlay, or `current` for the repo's own config, unmodified — and diffs the results (success rate, tokens, cost, compactions) using peek's own accounting, not a second cost model. Each trial gets a real agent run in its own isolated `git worktree`, verified by *your* test command (an exit-0/non-zero `verify` step per task file — no LLM-judge in v2.0), then peek parses that trial's own session log for exact tokens, cost, and compaction counts. Trials call the real Claude/Codex APIs and cost real money — this repo ships the exact suite used for the gate below at `.peek/bench/` so you can try it yourself, but budget for it first (the run below spent $0.58 + $0.04 on one trial per config).

```sh
peek bench run --suite .peek/bench --config-a current --config-b .peek/bench/configs/haiku
```

```
# real self-hosted gate: 1 task × 2 configs (current vs model=haiku), real claude-code
# agents, serialized worktree trials (docs/DESIGN.md § Measured results ledger; full output: docs/examples/bench-report.txt)
peek bench — current (a) vs config-b (b)

task        success a   success b  Δ      wall a  wall b  Δ               tokens a  tokens b  Δ                 cost a  cost b  Δ                compactions a  compactions b  Δ
hello-file  1/1 (100%)  1/1 (100%)  0.0pp    8.3s    9.4s  +1.1s (+13.5%)    82,902    67,038  -15,864 (-19.1%)   $0.58   $0.04  -$0.54 (-93.4%)              0              0  0
```

Both configs passed `verify`; switching the model to haiku cut cost 93.4% ($0.5833 → $0.0383) and tokens 19.1%, for +1.1s wall. That's a real run, not a projection — the same gate also caught and fixed a real bug (a `slugify` collision) and surfaced a real constraint: worktree trials need a repo with at least one commit.

**Safety, by design:** every run prints an upfront estimate (`N tasks × M trials × 2 configs = K agent runs`) and asks for confirmation (`--yes` skips it); each trial is killed on timeout by signaling its whole detached process group, never a bare `kill(pid)` (which can leak or kill the wrong process); a per-trial hard cost cap rides on claude's own `--max-budget-usd` flag (codex has no equivalent, so codex trials rely on the timeout plus a best-effort cross-trial `--max-cost` ceiling). One thing `peek bench` does **not** do: sandbox the agent. A git worktree is a filesystem convention, not a security boundary — trial agents run with your OS user's permissions, so only point it at task suites you trust. A first-run or changed suite also requires an explicit trust confirmation (every setup/verify command shown verbatim, direnv-style) before anything runs — `--yes` never bypasses it, only an interactive yes or `--trust-suite` does.

Per harness: **claude-code** is fully gated — the self-hosted result above is real, not projected. **codex** has a working runner, verified with one real trial, but not yet exercised through a full orchestrated A/B. **pi** is deferred to v2.1; the runner interface is harness-agnostic so a pi runner slots in without redesign, but it doesn't exist yet.

## Feature support by harness

| Feature | Claude Code | Codex † | pi ‡ |
|---|---|---|---|
| 1. Historical context composition | Partial: visible categories (char/4) + exact residual + cache_miss_reason signals | Partial-plus, **measured**: system prompt, AGENTS.md, and MCP schemas are logged and counted; residual came in at 67.4% on the one real capture with an aggregate figure computed (server-side templates, built-in tool schemas, and skills preambles are not in rollouts)† | Partial (like Claude Code, minus cache_miss_reason) |
| 2. Historical cost attribution | Full depth (usage fields, TTL split, dedup, subagents) | Usage-math semantics **measured** 2026-08-08†; per-tool attribution measured on a real multi-tool capture 2026-08-08; per-SUBAGENT depth n/a until a codex multi-agent capture exists | Full (Usage incl. precomputed cost) |
| 3. Compaction timeline | Yes (isCompactSummary; history retained) | Yes expected (compacted records + window lineage) | Yes (tokensBefore + summarization cost) |
| 4. Session diff | ✅ | ✅ expected | ✅ |
| 5. Config A/B runner (`peek bench`) | Yes — self-hosted A/B gate passed with real agents (see [Bench](#bench)) | Partial — runner verified with a real trial; no orchestrated A/B yet | Not yet — deferred to v2.1 |

† **Codex footnote (applies to every Codex cell):** claims were source-derived with zero completed-turn local examples at recon time. A real ground-truth capture was taken 2026-08-08 (codex-cli 0.134.0, trivial `codex exec` run): usage semantics are now **measured**: `total 37,481 = input 37,476 + output 5`, with `cached_input 1,408` confirmed as a subset of input (not additive); `cache_write_input_tokens` is absent (the default-to-0 rule is required in practice, not assumed); no `ordinal` field (3-key line format, current as of this version). Composition is also **measured**, post-Phase-4 (2026-08-08): with `base_instructions` and `dynamic_tools` seeded, residual came to 25,265 of 37,476 tokens (67.4%) on the trivial capture. That refutes the original "near-exact" hypothesis as stated: Codex rollouts omit server-side instruction templates, built-in tool schemas, and skills preambles. The honest claim is narrower: Codex logs strictly more than Claude Code (system prompt, AGENTS.md, and MCP schemas counted exactly), but a majority residual remains and is labeled as such. A second real capture exists (`test/fixtures/codex/v0.134/real-capture-tools-redacted.jsonl`, forced through `exec_command` tool calls with a real AGENTS.md present) showing the same pattern; no aggregate residual percentage has been computed for it yet, so none is quoted here. That second capture also grounds row 2 (attribution): the `peek cost` by-tool table attributes exec_command (2 calls, 2 results, ~153 tokens char/4 estimate); per-subagent attribution depth remains unmeasured — no Codex multi-agent capture exists yet. Compaction behavior is source-verified and fixture-proven; a real compaction capture is still pending.

‡ **pi footnote:** all pi cells are source-verified only; no real session data validated (Non-goals). peek now parses both of pi's session formats — the original System A and the newer System B (harness v4) JSONL mutation log (`{kind: header|entry|record|fact|lane, seq}`, v2 Lane D) — but that widened parse coverage doesn't change the hedge above: neither format has been validated against real pi session data yet.

## How it works

peek reads the session logs your coding agent already writes to disk — no live instrumentation, no proxying, no telemetry. It normalizes them into a Unified Session Model, then computes:

- **Exact totals**, straight from each harness's usage fields, never re-tokenized.
- **Estimates**, always labeled `~`, for anything not logged verbatim (e.g. how much a compaction summary is worth).
- **A residual**, named honestly as "system prompt + tool schemas + framing (not logged by this harness)" rather than hidden or silently dropped.

peek's totals are cross-checked against ccusage: identical to the token (0.00% delta on every component, including cost) at matched scope. The one scope difference found, corpus-wide dedup vs. peek's per-file dedup on multi-subagent sessions, is documented and fixed.

Everything runs locally. Session logs never leave your machine, there is no telemetry, and network access is limited to the explicit opt-in `peek pricing refresh` command (fetches a fresh [models.dev](https://models.dev) pricing snapshot for the offline fallback lookup — see `src/pricing/refresh.ts`; nothing else in peek touches the network). Only synthetic fixtures ship in this repo.

## Status & limitations

peek shipped v1 pre-release, then v2 complete on top of it — `peek bench`, the `list` totals cache, `cost --all`, pi System B, report v2 (see [docs/DESIGN.md](docs/DESIGN.md) for the full lane list). Two more capabilities have landed since: the `peek report --all` cross-session dashboard and the `peek pricing refresh` opt-in network command. v1's own design went through a five-round, three-lens adversarial audit loop (correctness, feasibility, product) before implementation, with finding counts of 27, 9, 6, 3, 1, then 0 across the five rounds. See [docs/DESIGN.md](docs/DESIGN.md) for the full positioning, architecture, and accounting rules, and [docs/BUILDLOG.md](docs/BUILDLOG.md) for the audit-round trajectory.

Verified, not just designed:

- **100% parse success** on a real-corpus run: 2,000 most-recently-modified Claude Code sessions (of 11,065 discovered, 2.8GB corpus) plus all 4 real Codex rollouts on disk. 67,458 turns, zero parse failures. (`test/local.integration.test.ts`, `PEEK_LOCAL=1`; see [docs/BUILDLOG.md](docs/BUILDLOG.md).)
- **Clean-room packaging validated**: a fresh `npm ci`, build, `npm pack`, global install from the tarball, and a `peek context` run against a fixture, all outside the working tree. See [docs/CLEANROOM.md](docs/CLEANROOM.md).
- **Privacy audit**: 0 leaks; the audit's original 0-network-calls finding predates the opt-in pricing-refresh command — see the audit's dated addendum. The audit also found 3 high-severity blind spots in the redaction script used to scrub real-capture fixtures (a depth-unaware key allowlist, an 8-character passthrough on short strings, and a missed Codex branch-name field); all 3 were fixed the same day, with the audit's exact probe inputs now shipped as regression tests. Of the two shipped real-capture fixtures, one was already byte-identical under the hardened rules and one was regenerated to match them; a dedicated regression test now locks both in (re-running the redactor on them reproduces them exactly). See [docs/PRIVACY-AUDIT.md](docs/PRIVACY-AUDIT.md).
- **Performance profiled** against real local logs (11,159 files, 2.68GB). Single-session `context`/`cost` runs in 28 to 30ms, 70× inside its budget; a 210-file multi-subagent family finishes in about 1.05s, 28× inside its budget. `peek list`'s floor is still single-threaded JSON parsing of ~2.7GB — cold (all-miss) stays at 6.18s — but v2's persistent totals cache (path+mtime+size keyed, under `XDG_CACHE_HOME`) makes every run after the first warm: **0.21s** on the full 7,526-session corpus, 26× inside the 1.5s bar, with 0 re-parses. `--no-cache` forces a full re-parse when you want one (verified, ~5.9s). `--cwd`/`--since`/`--harness` filters still cut the cold case proportionally. See [docs/PERF.md](docs/PERF.md).

**Known limitations:**

- **pi is source-verified only.** No real pi session data has been validated against the adapter yet.
- **Codex composition is measured, not near-exact.** Codex logs strictly more than Claude Code (system prompt, AGENTS.md, and MCP schemas counted exactly), but the one real capture with an aggregate residual figure computed came in at 67.4%. The original "near-exact" design hypothesis is refuted as stated. Compaction behavior is source-verified and fixture-proven; no real compaction capture has been measured yet.

## License

MIT — see [LICENSE](LICENSE).
