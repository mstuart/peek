# Not yet runnable / known-broken via `npx tsx src/cli.ts ...`

Captured while generating `docs/examples/`. Re-check `src/cli.ts` and
`src/commands/shared.ts` before relying on this file — these may have landed
since.

## `list`/`cost`/`compactions`/`diff`/`report`/`bench`/`pricing` — all wired

`src/cli.ts` registers `registerListCommand`, `registerCostCommand`,
`registerCompactionsCommand`, `registerDiffCommand`, `registerReportCommand`,
`registerBenchCommand`, and (landed after the previous round of this file)
`registerPricingCommand`. All seven top-level commands appear in `--help` and
run. `peek report` also gained a real `--all` flag (cross-session trends
dashboard, `src/render/dashboardHtml.ts`) — timed at 0.223s wall against this
machine's real 11k-file corpus, cache-warm; not captured as a docs/examples
file since, like `list`, it has no way to scope discovery to `test/fixtures/`
from the CLI (same limitation documented below). `peek pricing refresh` does
a real network fetch (models.dev) by design — it is peek's one explicit
opt-in network command — so it is not run here either; its wiring was
confirmed via `--help` and reading `src/commands/pricing.ts` and
`src/pricing/refresh.ts` only.
`peek diff test/fixtures/claude-code/v2.1.104/cache-heavy.jsonl
test/fixtures/claude-code/v2.1.104/compaction.jsonl` was re-run against
`dist/cli.js` while writing this file and byte-matches
`docs/examples/diff-claude-pair.txt` — `diff.ts` is not a stub. There is no
currently-broken command left to document in this section.

## `peek list` — wired, but has no fixture-root override

`list`'s `--cwd` flag filters discovered sessions by their recorded `cwd`
field (`src/commands/shared.ts`'s `applyFilters`); it does **not** redirect
*where* discovery looks. Discovery itself always reads the real default
roots — `~/.claude/projects`, `~/.codex/sessions`, `~/.pi/agent/sessions` (or
`$PI_AGENT_DIR/sessions`) — via each adapter's `discover*Sessions(roots?)`,
and `roots` is documented in `shared.ts` as a "test-only escape hatch" not
exposed through any CLI flag. This is still true as of v2 (checked against
`src/commands/list.ts`'s current option list: `--harness`, `--cwd`, `--since`,
`--subagents`, `--json`, `--no-cache`, `--verbose` — no fixture-root flag
among them). So `peek list` cannot be pointed at `test/fixtures/` from the CLI
without either running it against the real machine's session directories
(which this task's rules forbid) or adding a new flag (out of scope for this
task — another lane owns `cli.ts`/command source). `list-help.txt` is
captured instead of a real run; no `list-*.txt` output exists here beyond
`list-basic.txt` (built via the scratch-`$HOME` reproduction method
documented in `docs/examples/README.md`'s index).

## `cost` / `compactions` direct-path resolution misidentifying non-claude-code fixtures as claude-code — FIXED 2026-08-08

Previously, `src/commands/shared.ts`'s `resolveByPath` (used by `cost` and
`compactions`) resolved a literal file-path argument by directory **shape**,
not file **content**, and any codex fixture passed by path got silently
mis-parsed as claude-code (wrong harness label, all-zero totals instead of an
error). `context.ts` never had this bug — it always used a content-sniffing
`resolveByPath`.

Fixed by moving the content-sniffing resolver (`sniffHarness` +
`resolveByPath`) into `src/commands/shared.ts` as the single canonical
implementation, and updating `context.ts` to delegate to it instead of
keeping its own copy — there is now exactly one direct-file-path resolver for
the whole CLI. `--harness` is now also validated against the sniffed content
for path arguments: a mismatch (e.g. `--harness claude-code` against a codex
file) errors clearly instead of silently proceeding or being silently
ignored. Regression tests: `test/unit/commands.test.ts`'s "resolveSessionRef
— direct-file-path resolution" describe block, including the exact repro
above turned into an assertion (`cost`/`compactions` on the codex fixtures by
path now report `harness: "codex"` with real non-zero totals).

The real demo files this bug previously blocked are captured:
`cost-codex-tools.txt`/`.json` and `compactions-codex.txt` (see
`docs/examples/README.md`'s index). `cost-codex-BROKEN.txt` and
`compactions-codex-BROKEN.txt` are left in this directory as historical
evidence of the pre-fix behavior, not as current demo files.

## `peek diff` — FIXED, now wired (previously: "no source file yet")

An earlier round of this file claimed `src/commands/` had no `diff.ts` and
that `peek diff` fell through to top-level help. That is no longer true:
`src/commands/diff.ts` exists (`registerDiffCommand`, `buildDiffReport`,
`buildDiffLastNReport` for v2's `--last N` generalization), `cli.ts` registers
it, and `diff-claude-pair.txt` in this directory is a real, reproducible
`peek diff` run (see the wired-commands note above). The stale claim in an
earlier draft of this file is corrected here rather than left standing.

## `peek report` — wired and working

`report` is registered and runs cleanly against a claude-code fixture; see
`report-claude-compaction.html` (11,285 bytes) in this directory, generated
from `test/fixtures/claude-code/v2.1.104/compaction.jsonl`. Not opened per
this task's instructions — file size only, spot-checked for `/Users/mark`
(zero occurrences) and the embedded `<title>`/CSS via `Read`. `report --diff
<a> <b>` (v2, Lane E) also exists but is not separately captured here.

## `peek bench` — wired (v2, Lane A)

`src/commands/bench.ts` registers `bench run`, `bench report`, and
`bench clean`. `bench report` was re-run against a real results file from
this repo's self-hosted A/B gate (`docs/DESIGN.md` § Measured results ledger) and its
ANSI-stripped output, checked for zero `/Users/mark` occurrences, is captured
as `docs/examples/bench-report.txt`. `bench run` itself spawns real paid
agent runs and is not re-captured here beyond that one already-recorded gate
result.

## Net effect on the README quickstart

`context`, `list` (modulo the fixture-root limitation above), `cost`,
`compactions`, `diff`, `report` (including `--all`), `bench`, and
`pricing refresh` are all live. `cost`/`compactions` against codex and pi
fixture files by direct path are also correctly harness-identified — see the
fixed misidentification entry above. There is no command left in the README's
quickstart that isn't backed by a
real, wired implementation.
