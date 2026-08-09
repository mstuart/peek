# docs/examples

Real command output, captured against fixture/synthetic sessions only —
never against `~/.claude` or `~/.codex`. Every file here is reproducible by
running the listed command from the repo root. ANSI color codes are stripped
from `.txt` files (`sed -e 's/\x1b\[[0-9;]*m//g'`); `.json` files are raw
`--json` stdout.

`context`, `list`, `cost`, `compactions`, `diff`, `report`, and `bench` are
all wired into `src/cli.ts`. See [BROKEN.md](BROKEN.md) for the one
remaining real limitation: `list` has no CLI-exposed way to point discovery
at fixture roots (so there's no `list-*.txt` output here beyond the real
`list-basic.txt` run, built via the scratch-`$HOME` method noted in the
table below). A previous round's bug — `cost`/`compactions` mis-identifying
codex (and pi) fixture files passed by direct path as claude-code sessions —
is now fixed (BROKEN.md); `cost-codex-tools.txt` and `compactions-codex.txt`
below are the real demo files that bug used to block. `diff` and `bench` were
unwired in an earlier round of this file; both are now live, with real
captured output below (`diff-claude-pair.txt`, `bench-report.txt`).

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
| `list-help.txt` | `peek list --help` | n/a | `list`'s options; no real run captured — see BROKEN.md for why |
| `list-basic.txt` | `peek list` | Claude Code (2 sessions), Codex (1 real redacted capture), pi (5 sessions) | **A real `list` run does exist** — `list` has no positional fixture-path argument, but its adapters already honor discovery-root env vars (`PI_AGENT_DIR`) and `homedir()`-relative defaults, so pointing `HOME` and `PI_AGENT_DIR` at a scratch directory laid out like `~/.claude/projects/`, `~/.codex/sessions/`, `$PI_AGENT_DIR/sessions/` with these fixture files copied in reproduces a real cross-harness inventory table without touching `~/.claude` or `~/.codex`. Not reproducible with a single `npx tsx src/cli.ts list` from the repo root the way the other rows are — reproduce by copying `test/fixtures/{claude-code,codex,pi}/**/*.jsonl` into a scratch `$HOME/.claude/projects/<slug>/`, `$HOME/.codex/sessions/`, and `$PI_AGENT_DIR/sessions/<slug>/`, then running `HOME=<scratch> PI_AGENT_DIR=<scratch-pi> npx tsx src/cli.ts list` |
| `report-basic.txt` | `peek report test/fixtures/claude-code/v2.1.104/normal-turns.jsonl -o report.html` | Claude Code, 2 clean turns | Success-path stdout: just the resolved output path, no `wrote` prefix (that wording in an earlier README draft was illustrative, not the real message). Shown as `<repo>/report.html` since the real command prints the fully resolved absolute path of wherever it's run |
| `cost-claude-tools.txt` | `peek cost test/fixtures/claude-code/v2.1.104/tool-use-names.jsonl` | Claude Code, tool-use session | **The money-shot for tool/MCP attribution** — `by tool` and `by MCP server` tables populated with real `github` and `plugin_acme-tools_linter` rows, not empty |
| `cost-claude-tools.json` | same + `--json` | same | JSON shape of a `CostReport` with non-empty `byTool`/`byMcpServer` |
| `cost-codex-BROKEN.txt` | `peek cost test/fixtures/codex/v0.134/real-capture-tools-redacted.jsonl` (pre-fix) | Codex, real capture (redacted) | Historical evidence of the now-fixed mis-identification bug — labeled `claude-code`, `$0.00 (0 tokens)`, not the real codex totals. See BROKEN.md; superseded by `cost-codex-tools.txt` |
| `cost-codex-tools.txt` | `peek cost test/fixtures/codex/v0.134/real-capture-tools-redacted.jsonl` | Codex, real capture (redacted) | The fixed real demo: correctly labeled `codex`, `by model` shows `gpt-5.5` with real (76,364-token) totals, `by tool` shows `exec_command` |
| `cost-codex-tools.json` | same + `--json` | same | JSON shape of a `CostReport` for a real codex session |
| `compactions-claude.txt` | `peek compactions test/fixtures/claude-code/v2.1.104/compaction.jsonl` | Claude Code, 1 compaction | Before/after/shrink columns (`20,000 → 3,000`, shrink `17,000`) plus `~discarded`/`~summary` estimate columns |
| `compactions-claude.json` | same + `--json` | same | JSON shape of a `CompactionsReport` |
| `compactions-codex-BROKEN.txt` | `peek compactions test/fixtures/codex/v0.134/compaction.jsonl` (pre-fix) | Codex, 1 compaction | Historical evidence of the now-fixed mis-identification bug — reported "no compactions recorded" against a fixture that has one. See BROKEN.md; superseded by `compactions-codex.txt` |
| `compactions-codex.txt` | `peek compactions test/fixtures/codex/v0.134/compaction.jsonl` | Codex, 1 compaction | The fixed real demo: correctly labeled `codex`, one row (`214,300 → 26,800`, shrink `187,500`) |
| `report-claude-compaction.html` | `peek report test/fixtures/claude-code/v2.1.104/compaction.jsonl -o docs/examples/report-claude-compaction.html` | Claude Code, 1 compaction | Self-contained HTML report, 11,285 bytes, inline CSS only. Not opened/screenshotted per this repo's capture rules — size and a `Read`-based spot check (title tag, `/Users/mark` grep) only |
| `diff-claude-pair.txt` | `peek diff test/fixtures/claude-code/v2.1.104/cache-heavy.jsonl test/fixtures/claude-code/v2.1.104/compaction.jsonl` | Claude Code, 2 sessions | Real diff output: totals/composition/cost deltas + compaction/config comparison. Re-run against `dist/cli.js` while writing this file and byte-matched the file already here |
| `bench-report.txt` | `node dist/cli.js bench report <results.jsonl>` | Real self-hosted A/B gate results (`docs/DESIGN.md` § Measured results ledger) | `peek bench`'s A/B comparison table on a real run: 1 task, `current` vs `model=haiku`, both passed `verify`, config-b −93.4% cost ($0.58→$0.04), −19.1% tokens, +1.1s wall. ANSI-stripped, checked for zero `/Users/mark` occurrences before shipping (the source `results.jsonl` itself carries a local session path, but the rendered table output does not) |

## Honest read on demo quality

- **The composition table itself demos well**: the residual-bar-plus-percentage
  layout, the `~`-prefixed estimate convention vs. exact totals, and the
  compaction separator are all legible in a terminal and back up the README's
  "residual named honestly" pitch directly.
- **Update on last round's prediction**: last round guessed that once `cost`
  was wired up it might not have a fixture demoing the tool/MCP attribution
  column non-empty. That guess was wrong — `cost-claude-tools.txt` (from
  exactly the `tool-use-names.jsonl` fixture flagged as suspicious last round)
  populates `by tool` and `by MCP server` with real rows (`github`,
  `plugin_acme-tools_linter`). That's the strongest `cost` demo file and
  probably the single best README candidate from this round — it's the one
  output that directly proves the README's "per-tool/MCP server breakdown"
  pitch, not just "cost exists."
- **Previous finding, now fixed**: `cost`/`compactions` used to silently
  mis-identify any codex fixture passed by direct file path as a claude-code
  session (directory-shape resolution instead of content-sniffing). See
  BROKEN.md for the fix — `shared.ts`'s `resolveByPath` is now the single
  canonical content-sniffing resolver, shared by `context.ts` too.
  `cost-codex-tools.txt` and `compactions-codex.txt` are the real demos this
  bug used to block; the old broken output is kept as historical evidence
  (`*-BROKEN.txt`).
- **`context-codex-real.txt` is the strongest evidence file**: it's the one
  output here backed by real (redacted) Codex data rather than synthetic
  fixtures, and its numbers cross-check against the README's own footnote,
  which is exactly the kind of "verify before claiming" grounding this repo's
  README already asks for.
- **pi's `contextTotal 0` turns** (`context-pi.txt`, turns 1/3/4) look odd at a
  glance but reflect the fixture, not a bug — only turn 2 in that fixture
  carries `usage`. Worth a caption if this output goes into the README, so it
  doesn't read as broken.
- **`diff-claude-pair.txt` and `bench-report.txt` are the two examples added
  this round** — `diff` and `bench` were the last two commands documented as
  unwired/undemoed in earlier rounds of this file; both now have real,
  reproduced output in the table above.
