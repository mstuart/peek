# docs/examples

Real command output, captured against fixture/synthetic sessions only —
never against `~/.claude` or `~/.codex`. Every file here is reproducible by
running the listed command from the repo root. ANSI color codes are stripped
from `.txt` files (`sed -e 's/\x1b\[[0-9;]*m//g'`); `.json` files are raw
`--json` stdout.

`context`, `list`, `cost`, `compactions`, `diff`, `report`, and `bench` are
all wired into `src/cli.ts`. `list` has no CLI-exposed way to point discovery
at fixture roots, so there's no `list-*.txt` output here beyond the real
`list-basic.txt` run, built via the scratch-`$HOME` method noted in the
table below.

| File | Command | Fixture | What it shows |
|---|---|---|---|
| `context-basic.txt` | `peek context test/fixtures/claude-code/v2.1.104/normal-turns.jsonl` | Claude Code, 2 clean turns | Baseline per-turn composition table, residual bar |
| `context-basic.json` | same + `--json` | same | JSON shape of a `ContextReport` |
| `context-compaction.txt` | `peek context test/fixtures/claude-code/v2.1.104/compaction.jsonl` | Claude Code, 3 turns w/ 1 compaction | The compaction separator row (`── compaction: shrunk 17,000 tokens (exact) ──`) between turns 2 and 3 |
| `context-truncated.txt` | `peek context "test/fixtures/claude-code/v2.1.225/20000000-2000-4200-8200-200000000003.jsonl"` | Claude Code, 4 turns, offloaded tool-result file | The `(lower bound — truncated sources)` honesty label on turns 2-4 |
| `context-turn-detail.txt` | same + `--turn 2` | same | `--turn n` span-level drill-down, including a `truncated` flag on one span |
| `context-codex-real.txt` | `peek context test/fixtures/codex/v0.134/real-capture-redacted.jsonl` | **Real Codex capture, redacted** (not synthetic) | `gpt-5.5`, `contextTotal 37,476` — matches the measured figure in the README's Codex footnote (`total 37,481 = input 37,476 + output 5`) |
| `context-codex-real.json` | same + `--json` | same | JSON shape for the real-capture case |
| `context-pi.txt` | `peek context "test/fixtures/pi/system-a-v3/--Users-fake-project--/2026-08-01T10-00-00-000Z_cb5b132f-2542-40b3-a7c9-49ffc431e30b.jsonl"` | pi, 4 turns | pi harness rendering (note: turns 1/3/4 show `contextTotal 0` — pi's `usage` isn't always present per-turn in this fixture) |
| `context-error.txt` | `peek context nonexistent-session-id-demo` | n/a | Error-path UX: exits 1, one-line stderr message, no stack trace |
| `list-help.txt` | `peek list --help` | n/a | `list`'s options; not directly reproducible against fixtures (see `list-basic.txt` below for how a real `list` run is captured instead) |
| `list-basic.txt` | `peek list` | Claude Code (2 sessions), Codex (1 real redacted capture), pi (5 sessions) | **A real `list` run** — `list` has no positional fixture-path argument, but its adapters already honor discovery-root env vars (`PI_AGENT_DIR`) and `homedir()`-relative defaults, so pointing `HOME` and `PI_AGENT_DIR` at a scratch directory laid out like `~/.claude/projects/`, `~/.codex/sessions/`, `$PI_AGENT_DIR/sessions/` with these fixture files copied in reproduces a real cross-harness inventory table without touching `~/.claude` or `~/.codex`. Not reproducible with a single `npx tsx src/cli.ts list` from the repo root the way the other rows are — reproduce by copying `test/fixtures/{claude-code,codex,pi}/**/*.jsonl` into a scratch `$HOME/.claude/projects/<slug>/`, `$HOME/.codex/sessions/`, and `$PI_AGENT_DIR/sessions/<slug>/`, then running `HOME=<scratch> PI_AGENT_DIR=<scratch-pi> npx tsx src/cli.ts list` |
| `report-basic.txt` | `peek report test/fixtures/claude-code/v2.1.104/normal-turns.jsonl -o report.html` | Claude Code, 2 clean turns | Success-path stdout: just the resolved output path, no `wrote` prefix. Shown as `<repo>/report.html` since the real command prints the fully resolved absolute path of wherever it's run |
| `cost-claude-tools.txt` | `peek cost test/fixtures/claude-code/v2.1.104/tool-use-names.jsonl` | Claude Code, tool-use session | Tool/MCP attribution: `by tool` and `by MCP server` tables populated with real `github` and `plugin_acme-tools_linter` rows |
| `cost-claude-tools.json` | same + `--json` | same | JSON shape of a `CostReport` with non-empty `byTool`/`byMcpServer` |
| `cost-codex-tools.txt` | `peek cost test/fixtures/codex/v0.134/real-capture-tools-redacted.jsonl` | Codex, real capture (redacted) | Correctly labeled `codex`; `by model` shows `gpt-5.5` with real (76,364-token) totals; `by tool` shows `exec_command` |
| `cost-codex-tools.json` | same + `--json` | same | JSON shape of a `CostReport` for a real codex session |
| `compactions-claude.txt` | `peek compactions test/fixtures/claude-code/v2.1.104/compaction.jsonl` | Claude Code, 1 compaction | Before/after/shrink columns (`20,000 → 3,000`, shrink `17,000`) plus `~discarded`/`~summary` estimate columns |
| `compactions-claude.json` | same + `--json` | same | JSON shape of a `CompactionsReport` |
| `compactions-codex.txt` | `peek compactions test/fixtures/codex/v0.134/compaction.jsonl` | Codex, 1 compaction | Correctly labeled `codex`, one row (`214,300 → 26,800`, shrink `187,500`) |
| `report-claude-compaction.html` | `peek report test/fixtures/claude-code/v2.1.104/compaction.jsonl -o docs/examples/report-claude-compaction.html` | Claude Code, 1 compaction | Self-contained HTML report, 11,285 bytes, inline CSS only |
| `diff-claude-pair.txt` | `peek diff test/fixtures/claude-code/v2.1.104/cache-heavy.jsonl test/fixtures/claude-code/v2.1.104/compaction.jsonl` | Claude Code, 2 sessions | Real diff output: totals/composition/cost deltas + compaction/config comparison |
| `bench-report.txt` | `node dist/cli.js bench report <results.jsonl>` | Real self-hosted A/B gate results (`docs/DESIGN.md` § Measured results ledger) | `peek bench`'s A/B comparison table on a real run: 1 task, `current` vs `model=haiku`, both passed `verify`, config-b −93.4% cost ($0.5833→$0.0383), −19.1% tokens, +1.1s wall. ANSI-stripped, checked for zero `/Users/mark` occurrences before shipping (the source `results.jsonl` itself carries a local session path, but the rendered table output does not) |

The composition table demos the residual-bar-plus-percentage layout, the
`~`-prefixed estimate convention vs. exact totals, and the compaction
separator — all legible in a terminal, backing up the "residual named
honestly" positioning. `cost-claude-tools.txt` is the strongest `cost` demo:
it's the one output that directly proves the per-tool/MCP-server breakdown
pitch, not just "cost exists." `context-codex-real.txt` is the strongest
context demo: it's backed by real (redacted) Codex data rather than
synthetic fixtures, and its numbers cross-check against the README's own
footnote. pi's `contextTotal 0` turns (`context-pi.txt`, turns 1/3/4) reflect
the fixture, not a bug — only turn 2 in that fixture carries `usage`.
