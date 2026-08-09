# peek — build log (raw material)

> **Point-in-time snapshot, 2026-08-08 — not maintained as a living document.** Several facts below are superseded: `peek diff` (documented here as unwired/no source file) has since shipped, and `docs/PERF.md`/`docs/PRIVACY-AUDIT.md` (referenced below as pending) now exist and are complete; v2 — the `peek bench` config A/B runner, the `list` totals cache, `cost --all` cross-session merge, pi's System B adapter, and report v2 — shipped complete (docs/PLAN.md and docs/PLAN-V2.md, referenced throughout this file, have since been consolidated into [docs/DESIGN.md](DESIGN.md); see its Measured results ledger for the v2 status numbers). The lint status reported below (red, one import-order error) is this file's own point-in-time reading, not re-verified here; run `npm run lint` for the current state. The historical body below is left as originally written, not corrected in place.

Internal, factual chronicle of how `peek` (npm `peek-agent`) got built. Written as raw
material for a future essay/talk, not for external publication. Every claim below is
either (a) a direct quote/paraphrase of a file in this repo, with its path, or (b)
something I ran myself against the working tree on 2026-08-08 and report the output of.
Where I could not find a repo artifact backing a number I was given, I say so explicitly
instead of including it. No marketing language, no smoothing over hedged claims.

## 1. Timeline skeleton

Single day, 2026-08-08. peek has **no git history** — `git log` returns nothing and
`git status` shows every file as untracked (`??`) — so there is no commit-by-commit
record. The reconstruction below is order-of-appearance in `docs/`, `docs/PLAN.md`'s own
"post-audit-round-2" labeling, and filesystem mtimes (`stat` on every doc/source/fixture
file), which is what a reader can re-run to check this section.

- **Research phase → design docs.** `docs/recon/{claude-code,codex,pi}.md` (three
  harness-format recons) predate `docs/PLAN.md` and `docs/IMPLEMENTATION.md` in content —
  PLAN.md's architecture and accounting rules cite recon findings by name (e.g. the
  streaming-split dedup case, the `toolUseResult`-vs-inline double-count). I did not find
  separate landscape/gap/prior-art research documents in the repo itself — those, if they
  ran, left no artifact under `docs/`; PLAN.md's "Positioning" section (competitor
  comparisons against `ccusage`, `claude-devtools`, `agent-replay`) is the only surviving
  trace of that research, folded into the design doc rather than kept as its own file.
- **Design docs: two authored documents, `docs/PLAN.md` and `docs/IMPLEMENTATION.md`**,
  both self-labeled `v3, post-audit-round-2`. Both cite specific finding IDs inline
  (`R1-C2`, `R2-C1`, `R2-C2`, `R2-F1` through `R2-F4`, `R2-P2`, `R3-F1` through `R3-F3`,
  `R3-P1`, plus un-prefixed `F2`, `F9`, `F10`, `F14`) — evidence of at least three
  labeled audit rounds (R1, R2, R3) against three finding categories: `C` (correctness),
  `F` (feasibility), `P` (product). **I could not independently verify a specific
  round-count or a finding-count trajectory (e.g. "27 → 9 → 6 → 3 → 1 → 0") against any
  file in the repo — no audit-round log survives as a doc — so that sequence is omitted
  here rather than asserted.** What the docs do confirm: the audit loop ran until a
  "clean round" gate before implementation started (`docs/IMPLEMENTATION.md:71`: "Audit
  loop on these docs runs until a clean round before T0.1").
- **Implementation swarm.** `docs/IMPLEMENTATION.md` lays out 27 tasks across 7 phases
  (Foundations → Claude adapter → Engine → First commands → Codex adapter → diff+report →
  pi adapter → Polish), each tagged `[worker]` (objective, runs in-repo tests/build) or
  `[fable]` (needs real local `~/.claude`/`~/.codex` data, `npx ccusage`, or judgment).
  This session's addressable agent roster (visible to me via the team messaging system)
  lists 24 numbered task workers (`worker-t01`…`worker-t03`, `worker-t11`…`worker-t64`,
  `worker-t71a`) that map cleanly onto IMPLEMENTATION.md's T0.1–T7.1 numbering, plus 16
  more named for specific fixes or cross-cutting concerns (`worker-fix-family`,
  `worker-fix-redact`, `worker-fix-remap`, `worker-fix-seed`, `worker-fix-toollink`,
  `worker-capture2`, `worker-cleanroom`, `worker-demos`, `worker-diff-core`,
  `worker-integration`, `worker-perf`, `worker-pi-flake`, `worker-privacy`,
  `worker-review-engine`, `worker-ci`, `worker-taxonomy`) — roughly 40 addressable workers
  total, not ~15; I'm reporting what I can see in this session's roster rather than a
  number I couldn't confirm.
- **Filesystem mtimes** put every doc, source, and fixture file within a single
  ~77-minute window on 2026-08-08: earliest doc `docs/IMPLEMENTATION.md` at 15:26:14,
  earliest `src/*.ts` at 15:27:37, latest fixture `test/fixtures/codex/README.md` at
  16:43:43, latest source file `src/cli.ts` at 16:42:31. Mtimes only show *last* write, not
  authorship order or whether a file was overwritten mid-run, so this establishes
  "compressed, overlapping" rather than a clean sequence.
- **Measurement moments** (see §3) are dated 2026-08-08 in-line in PLAN.md: the Codex
  ground-truth capture, the seeding-fix residual recompute, and the T2.5 ccusage
  reconciliation are all same-day.

## 2. What the audits caught

One line each, from PLAN.md's inline audit citations — what would have shipped broken
without the finding:

- **Tool-result double-count** (PLAN.md rule 5 / `docs/recon/claude-code.md:45`): Claude
  Code logs the same tool result twice — once inline in `user.message.content` as a
  `tool_result` block, once as a sibling `toolUseResult` field, byte-identical in 9/10
  sampled records. Without the "exactly one source, `toolUseResult` preferred" rule,
  every tool-heavy session's token/cost totals would roughly double on that category.
- **Error-record compaction anchoring — the ~844k trap** (`audit R1-C2`, PLAN.md:93,140):
  an `isApiErrorMessage` record with all-zero usage can sit adjacent to a real compaction
  marker. Anchoring `tokensBeforeExact` naively on the nearest prior record reads 0
  instead of the true ~844,000-token prior context — the compaction's entire headline
  number (`shrinkExact`) would report as garbage. `test/unit/compaction-attribution.test.ts`
  and `test/unit/claude-spans.test.ts` both carry a case asserting `tokensBeforeExact`
  skips the zero-usage record and lands on 20000 (the fixture's stand-in for the real
  844k case).
- **Streaming-split as the dominant dedup case, not the edge case** (`docs/recon/claude-code.md:40`):
  one logical turn can be split across multiple assistant records (thinking/text/tool_use
  as separate JSONL lines) sharing one `message.id`. The recon's real measurement: 89
  assistant records collapsed to 35 distinct `message.id`s in one session. A dedup key
  that treated these as distinct turns would inflate every count on every session by
  roughly 2.5x.
- **`discardedEst` formula ambiguity — two different metrics, not one** (PLAN.md:94-99,
  worked example at :140): "how much a compaction shrank context" (`shrinkExact = before −
  after`, exact) and "how much original content was discarded" (`discardedEst = before −
  after + summaryTokensEst`, because the summary itself is new text living inside `after`)
  are different numbers and conflating them would either double-count the summary or
  under-report what was actually thrown away. The worked example fixes both formulas
  against one real session's numbers (844,000 → 54,437, summary ≈30,581 →
  `shrinkExact` 789,563 vs `discardedEst` 820,144).
- **Dedup-index remap bug** (`test/unit/dedup-remap.test.ts`, `test/fixtures/claude-code/v2.1.225/streaming-split-compaction.jsonl`):
  a streaming-split turn (3 raw records, 1 logical turn) immediately preceding a
  compaction marker leaves the adapter's pre-dedup `turnIndex` (3) and the correct
  post-`dedupSession()` index (1) off by 2 — anything anchoring a `CompactionEvent` to a
  `turnIndex` computed before dedup would point at the wrong turn.
- **Span-type gap flagged as a shared-surface risk before it caused drift** (PLAN.md:77,
  `audit R2-F1`, annotated in-line "the shared type 4 workers touch"): `Span` is consumed
  by all three adapters plus the composition and diff engines; the audit called this out
  explicitly as a type four separate workers would each touch, which is exactly the kind
  of shared surface where independent workers silently disagree on field semantics if the
  contract isn't pinned in the type itself before they start.

## 3. Measured, not assumed

Every number here traces to a specific file; where I could not find the backing artifact
for a number I was given, I say so and omit it rather than repeat it unverified.

- **Codex residual: 81.6% → 67.4%, from a documented seeding fix.** The comment at
  `src/engine/composition.ts:88-91` states: "on the real codex capture, 30,599 of 37,476
  residual tokens were unexplained, of which ~5.6k is the system prompt — logged verbatim
  in `configSnapshot.systemPrompt` but never folded into the running totals." 30,599 /
  37,476 = **81.6%** (computed here, not asserted in the file). `docs/PLAN.md:37` states
  the fixed number directly: "Composition MEASURED post-Phase-4 (2026-08-08): with
  `base_instructions` + `dynamic_tools` seeded, residual = 25,265 of 37,476 (**67.4%**)."
  25,265 = 30,599 − 5,334 (system prompt + tool schemas now folded in), consistent with
  the comment's ~5.6k estimate. This refutes the design doc's original "near-exact"
  hypothesis for Codex composition as stated — Codex logs strictly more than Claude Code
  (system prompt, AGENTS.md, MCP schemas counted exactly), but a majority of context on
  this trivial capture is still unexplained residual (server-side instruction templates,
  built-in tool schemas, skills preambles — none of which land in the rollout file).
  **A second capture exists** (`test/fixtures/codex/v0.134/real-capture-tools-redacted.jsonl`,
  a real `codex exec` run forced through `exec_command` tool calls with a real AGENTS.md
  present, model `gpt-5.5`, per `test/fixtures/codex/README.md`) — but I could not find a
  test or doc that computes an aggregate residual percentage for it, so the "67.5%"
  figure I was asked to include is **not verifiable against a repo artifact and is
  omitted**.
- **37k-token trivial-prompt observation** (`docs/PLAN.md:37`, `docs/recon/codex.md:31-39`):
  a trivial `codex exec` run (codex-cli 0.134.0) produced `total_tokens: 37,481 = input
  37,476 + output 5`, with `cached_input_tokens: 1,408` confirmed as a subset of
  `input_tokens` (not additive) and `cache_write_input_tokens` absent from the payload
  even at this version — the "default to 0 when absent" rule in `model/normalize.ts` was
  written to match this, not assumed in advance.
- **ccusage reconciliation: exact match at matching scope, quantified drift outside it**
  (`docs/PLAN.md:134`, T2.5, dated 2026-08-08): "peek matches ccusage EXACTLY (0.00% every
  component incl. cost) at matching scope — per-file for simple sessions, family
  (main+subagents) for ccusage's session grouping (34-file session exact)." The named
  residual case — a 210-file orchestrator family where peek reported +1.6–5.9% over
  ccusage — was traced to a specific cause, not left as an unexplained discrepancy: peek
  was dedup-ing per-file while ccusage dedups corpus-wide, and the gap was quantified as
  "319 cross-file replay turns / ~76M tokens." `test/unit/dedup-family.test.ts` (7 tests,
  currently passing) is the shipped fix — family-scope dedup, cited in
  `test/fixtures/claude-code/README.md:32` as covering exactly this case.
- **100%-parse-on-2000-sessions / 67k-turns claim: not found in any repo artifact, and
  the underlying real-corpus run appears not to have been recorded to a doc yet.**
  `test/local.integration.test.ts` is real and does exactly this kind of check — it walks
  real `~/.claude/projects` (capped at 2,000 most-recently-modified refs,
  `CLAUDE_FILE_CAP = 2000` at line 17) and real `~/.codex/sessions`, asserting ≥95% parse
  success for Claude Code and exactly 100% for Codex — but it's gated behind
  `PEEK_LOCAL=1` and skipped in the default `vitest run` (confirmed: my own run of `npm
  test` shows `test/local.integration.test.ts` as the sole skipped file, "2 skipped").
  The 2,000-file cap in the test matches the number I was given, which suggests a real
  `PEEK_LOCAL=1` run did happen at some point, but its console output (turn counts, pass
  rate) isn't captured anywhere in the repo, and this session's own task list still shows
  task #6, "Verify end-to-end on real logs and report," as **pending, not completed**. I'm
  treating the specific 67k-turn/100% figures as **in flight at time of writing** rather
  than confirmed.

## 4. Swarm mechanics

- **Orchestrator/worker split, by design, not improvised.** `docs/IMPLEMENTATION.md:3`:
  "Fable orchestrates, reviews, and runs every gate that touches real local data or
  requires judgment; Sonnet/Haiku workers implement bounded tasks in the repo with no
  chat context." The corollary rule, same line: "workers stop-and-report on spec
  ambiguity or fixture/spec contradiction — never improvise schema guesses." The fixture
  READMEs show this rule being followed in practice, not just stated: both
  `test/fixtures/codex/README.md` and `test/fixtures/pi/README.md` end in "Recon
  ambiguities encountered" / "Assumptions (not fully specified by recon — flagged for
  review)" sections that name the exact ambiguous field (e.g. `base_instructions`'s
  `{text: "..."}` wrapper shape, the namespace-spec nested-tools container key,
  `cache_missed_input_tokens`'s nesting inside vs. alongside `cache_miss_reason`) and say
  explicitly what was assumed and why, rather than silently picking one.
- **Gate ownership is tagged per-task, not implicit.** `docs/IMPLEMENTATION.md:5`: "every
  gate line below is tagged `[worker]` (objective, runs in-repo: tests/build) or `[fable]`
  (needs real local data, external tools, or judgment). Workers never need real local
  data; all `PEEK_LOCAL=1` runs are Fable's." This shows up as a hard boundary in the
  code, not just the plan: `test/local.integration.test.ts`'s own header comment states a
  "PRIVACY RULE: nothing printed here may derive from session CONTENT — only counts,
  error messages (truncated + stack-stripped), warning codes, and rates" — a worker-authored
  test enforcing a fable-only-run boundary on itself.
- **Sequencing had one deliberate cross-lane dependency edge, called out explicitly**
  (`docs/IMPLEMENTATION.md:71`): "T0.* → {Phase 1, Phase 4, Phase 6} proceed in parallel
  lanes — with one cross-lane edge: T4.1 → T4.2b → T1.2 (Phase 4 fixtures need Phase 1's
  redactor; audit R3-F2)." In other words the three adapter lanes (Claude, Codex, pi) ran
  in parallel except that Codex's real-capture redaction needed Claude's `redact.ts`
  first — a dependency the design doc surfaces by name rather than leaving implicit.
- **A dedicated worker (`worker-fix-seed`) exists for exactly the residual-seeding fix
  described in §3**, and its work is traceable to `src/engine/composition.ts`'s dated
  comment ("2026-08-08 fix") plus `test/unit/composition.test.ts`'s
  `describe("computeComposition — configSnapshot seeding (systemPrompt/toolSchemas, fix
  2026-08-08)"` block, which asserts the residual shrinks by exactly the seeded amount and
  nothing else. Similarly, `worker-fix-family` maps to `test/unit/dedup-family.test.ts`,
  `worker-fix-remap` to `test/unit/dedup-remap.test.ts`, and `worker-capture2` to the
  second Codex capture fixture (`real-capture-tools-redacted.jsonl`) — each fix worker's
  name corresponds to a specific, findable test file rather than being an unverifiable
  label.
- **A "mid-run fixture-write collision" finding was mentioned to me as something to
  include here. I could not find any repo artifact — commit, comment, or doc — recording
  such an incident, and there is no git history to check for overwritten/reverted fixture
  files. I'm omitting this rather than asserting it happened**, though the compressed
  ~77-minute mtime window across all fixture files (§1) is at least consistent with heavy
  concurrent writes to the same `test/fixtures/` tree, which is the kind of setup where
  that failure mode becomes possible.
- **Stop-and-report discipline, concretely observed in the deliverables, not just
  stated as a rule**: `docs/examples/README.md`'s "Honest read on demo quality" section
  flags that no fixture actually populates `toolName`/`mcpServer` on a span despite one
  fixture being named `tool-use-names.jsonl`, and says plainly "Not fixed here — out of
  scope (I didn't touch fixtures or command source)." `docs/examples/BROKEN.md` similarly
  documents that `list`/`cost`/`compactions` were implemented but not registered in
  `src/cli.ts` at the time that worker ran, and that `diff`/`report` had no source file
  yet — again flagged rather than fixed by a worker outside that task's scope. (Note: as
  of this writing, `list`, `cost`, `compactions`, and `report` are all registered in
  `src/cli.ts` — see §5 — so `BROKEN.md` is now partially stale; it correctly predicted
  its own staleness with the line "Re-check `src/cli.ts` before relying on this file —
  these may have landed since.")

## 5. Open threads at time of writing

Checked directly against the current working tree on 2026-08-08 rather than assumed from
the docs, since several docs are already stale relative to the code:

- **`peek diff` — the pitch's headline feature — is not yet reachable from the CLI.**
  `docs/PLAN.md:18` names it explicitly: "Pitch order (README): 1) `peek diff` (headline
  screenshot...)". `src/engine/diff.ts` exists with its own test file
  (`test/unit/diff-core.test.ts`, 9 passing tests), but there is no `src/commands/diff.ts`
  and `src/cli.ts` (checked directly) registers `context`, `list`, `cost`, `compactions`,
  and `report` — not `diff`. `src/commands/index.ts` is still a one-line placeholder
  comment listing `diff` as one of the subcommands that "land here." The diff *engine* is
  built; the diff *command* is not wired.
- **`list`/`cost`/`compactions`/`report` are now wired, contradicting the last written
  record of CLI state.** `docs/examples/README.md` and `docs/examples/BROKEN.md` both
  assert only `context` is registered. Reading `src/cli.ts` directly (2026-08-08) shows
  `registerListCommand`, `registerCostCommand`, `registerCompactionsCommand`, and
  `registerReportCommand` are all called. This is a real gap between those two docs and
  current code, not a contradiction I'm resolving in favor of one or the other — flagging
  it as doc drift.
- **README.md's Codex feature table has not been updated for the Phase-4 measurement.**
  `README.md:116` and `:122` still describe Codex composition as "Near-exact expected"
  and "remain *expected pending Phase 4*." `docs/PLAN.md:31,37` — the more recently
  authored doc, per its "post-audit-round-2" / measured-residual content — already states
  the measured 67.4% residual and explicitly says the near-exact hypothesis is
  "REFUTED as stated." README.md and PLAN.md currently disagree on Codex's status; a
  reader hitting README.md first would come away with the wrong claim.
- **`docs/PERF.md` and `docs/PRIVACY-AUDIT.md` do not exist in the repo as of this
  writing.** Both were requested source material for this build log; I checked
  (`find . -iname "PERF.md" -o -iname "PRIVACY-AUDIT.md"`) and neither is present. In
  flight at time of writing.
- **Lint is red**, independent of and consistent with `docs/CLEANROOM.md`'s finding: I
  ran `npm run lint` myself and it fails on one import-order error, now in `src/cli.ts`
  (the file/line differs from CLEANROOM.md's report against `src/commands/list.ts`,
  which suggests the specific violation moved when the CLI was rewired, not that it was
  fixed). `npm test` (320 passed, 2 skipped, 24 files) and `npm run build` (tsup succeeds,
  `dist/cli.js` ~145KB) both pass cleanly as of this run.
- **CLEANROOM.md's publish-blocker #1 (pricing snapshot packaging) appears fixed since
  that doc was written, but the doc itself hasn't been updated to say so.** CLEANROOM.md
  describes `package.json`'s `files` field as `["dist", "pricing/data"]` with a
  non-resolving glob, and the compiled `lookup.ts` expecting `dist/data/...` with nothing
  to put it there. Current `package.json` has `"files": ["dist"]` only, and
  `tsup.config.ts` now has an explicit `onSuccess` hook that copies `src/pricing/data` →
  `dist/data`, with an inline comment naming it: "The pricing snapshot is a static asset
  the compiled lookup resolves at `dist/data/<snapshot>.json` (cleanroom blocker #1) —
  tsup never copies it." CLEANROOM.md's other findings (`"private": true` blocking
  publish, the sourcemap-in-tarball note) — sourcemaps are now off entirely
  (`sourcemap: false` in `tsup.config.ts`, vs. CLEANROOM.md's report of a 244.6KB
  `cli.js.map` shipping) — so that finding is also resolved, undocumented as such.
- **pi remains fully synthetic — no real pi session has ever been parsed by this
  adapter.** Confirmed in three places: `docs/PLAN.md`'s non-goals ("pi adapter is
  best-effort... no local data"), `docs/recon/pi.md`'s header ("Source-verified against
  github.com/earendil-works/pi @ main... NO local data"), and `test/fixtures/pi/README.md`
  itself has no real-capture file analogous to Codex's `real-capture-redacted.jsonl` — every
  pi fixture is fabricated content.
- **This session's own task list** (visible to me directly, not inferred) shows task #6,
  "Verify end-to-end on real logs and report," as **pending** — the last item not yet
  marked complete, consistent with the missing real-corpus parse numbers in §3 and the
  missing PERF.md/PRIVACY-AUDIT.md above.

---

**What I could not verify and therefore omitted or flagged rather than including as
fact:** the specific 5-round / 27→9→6→3→1→0 audit finding-count trajectory; the "~15
worker agents" figure (observed roster is closer to 40); the second Codex capture's
aggregate residual percentage ("67.5%"); the "2000 real sessions / 67k turns / 100% parse"
claim as a completed, recorded result; and the "mid-run fixture-write collision" finding.

## Appendix: orchestrator-attested session facts (2026-08-08)

The following numbers have no repo artifact because they occurred in the orchestrating
session before/around the repo's creation. Attested directly by the orchestrator; the
BUILDLOG author correctly declined to state them unsourced. This appendix is the source.

- **Research fleet, pre-design:** 3 landscape agents (pi SDK deep-dive; OpenCode/Codex
  architecture; build-vs-buy landscape) → 3 gap agents (pi-ecosystem whitespace;
  user pain-point mining; niche-occupancy matrix) → 1 adversarial prior-art sweep →
  4 format-recon agents (Claude Code JSONL from real logs; Codex from real ~/.codex +
  codex-rs source; pi from source; token-math/context-reconstruction feasibility).
- **Design audit loop:** 3 adversarial lenses (correctness, feasibility, product) ran
  5 rounds against PLAN.md+IMPLEMENTATION.md before any code. Finding counts per round:
  **27 → 9 → 6 → 3 → 1 → 0.** Every finding fixed and re-verified by its finder; the
  loop's finding IDs (R1-C2, R2-F1, R3-F3, …) are the ones cited throughout PLAN.md
  (since consolidated into docs/DESIGN.md — see its Process provenance section).
- **Real-corpus parse gate:** 2,000 most-recent real Claude Code sessions (of 11,065
  discovered; 2.8GB corpus) + all 4 real Codex rollouts parsed at **100%** success,
  67,458 turns, zero failures (test/local.integration.test.ts, PEEK_LOCAL=1 run).
- **ccusage reconciliation (T2.5):** exact match (0.00% delta, every token class + cost)
  at matched scope on small and 34-file-family sessions; the 210-file family's residual
  delta was root-caused to cross-file replay scope (319 duplicate turns, ~76M tokens)
  and fixed via dedupFamily.
- **Implementation swarm:** ~30 worker tasks executed by Sonnet/Haiku subagents (peak
  concurrency 10–11) with the orchestrator running [fable] gates; 3 post-implementation
  read-only audits (engine review, privacy, perf) produced 2+4+1 verified findings, all
  fixed same-session.
