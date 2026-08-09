# peek v1 performance profile

Profiled against real Claude Code logs on this machine (not synthetic fixtures). Two
corpora used:

- **Full corpus**: `~/.claude/projects/**/*.jsonl`, 11,159 files, ~2.68GB, of which 7,518
  are "main" session files (~1.87GB) and the rest are subagent transcripts.
- **The monster family**: session `bab4682f-134a-4353-b194-1552793e11da` (1 main file +
  209 subagent files under `-Users-mark-git-collectors`, 210 files / 153.6MB total).
  28,983 raw assistant turns before dedup, 14,524 after per-file dedup, and a combined
  `contextTotal` sum of ~5.4 billion — that figure is the sum of thousands of turns'
  *cumulative* context sizes (`contextTotal` grows every turn), not real tokens billed;
  the family's actual priced spend is $1,116 (parent session alone) / $2,411 (parent +
  all subagents combined).

Scripts: `/private/tmp/claude-501/-Users-mark-git/236baa2d-7436-4ddf-b67d-bac9896e23b4/scratchpad/perf/*.ts`,
run via `NODE_OPTIONS="--expose-gc" npx tsx <script>.ts`. All numbers below are single-run
wall-clock on this machine (Node v24.13.0, Darwin), not averaged over multiple trials —
treat as order-of-magnitude, not micro-benchmark-grade precision.

## Results table

| Scenario | Stage | Time | Peak RSS |
|---|---|---|---|
| `peek list` (full corpus, no `--subagents`) | discoverAll | 142.8ms | 106MB |
| `peek list` (full corpus, no `--subagents`) | parse+dedupSession+priceSession × 7,518 main sessions | **6,973.3ms** | **3,503MB** |
| `peek list` **end-to-end** | — | **~7,116ms** | **~3.5GB** |
| discover only (`discoverClaudeSessions`) | full corpus scan | 141–153ms | ~106–129MB |
| discover only (`discoverAll`, 3 harnesses) | full corpus scan | 164.0ms | 124MB |
| Single mid-size session (4.49MB, 156 turns) | `peek context` pipeline (parse→dedupTurns→composition→compactions) | 27.8ms | 118MB |
| Single mid-size session (4.49MB, 156 turns) | `peek cost` pipeline (parse→dedupSession→price→attribution) | 29.7ms | 133MB |
| Monster family (210 files, 153.6MB) | discover (full corpus scan, then filter) | 247.6ms | 105MB |
| Monster family | parse × 210 files | 715.9ms | 389MB |
| Monster family | dedupSession × 210 | 19.8ms | 378MB |
| Monster family | dedupFamily (cross-file) | 19.2ms | 381MB |
| Monster family | priceSession × 210 | 12.8ms | 384MB |
| Monster family | computeComposition × 210 | 8.1ms | 383MB |
| Monster family | finalizeCompactions × 210 | 0.2ms | 383MB |
| Monster family | attribution (byModel/byTool/byMcpServer/cacheAnalysis, parent only) | 8.1ms | 385MB |
| Monster family | attribution (bySubagent, full family) | 19.3ms | 386MB |
| Monster family **end-to-end** (incl. discover) | — | **~1,051ms** | **389MB** |

Per-file parse throughput on the monster family: min 24.8 MB/s, median 192.6 MB/s, max
345.4 MB/s (largest single file: 25.7MB main session, parsed in 114.2ms). Aggregate
throughput on the full-corpus `peek list` parse stage: ~1,916MB / 6.97s ≈ 275MB/s —
consistent with a single JS thread doing CPU-bound `JSON.parse` + span-object
construction; the concurrency in `Promise.all` mostly just overlaps I/O wait, not CPU.

## Verdicts against the UX bars

| Bar | Target | Measured | Verdict |
|---|---|---|---|
| `peek list` startup (discover+stat) | <1.5s, "instant" | **7.1s**, 4.7× over budget | **FAIL** |
| Single-session `context`/`cost` | <2s | 28–30ms | **PASS** (70× margin) |
| 210-file monster family, full pipeline | <30s tolerable | ~1.05s | **PASS** (28× margin) |

The monster family and single-session cases are not close to their bars — v1's engine
(parse, dedup, composition, compaction, attribution) is fast. **The one real problem is
`peek list` itself**, and it's not the "discover+stat" step the UX bar was framed
around — bare directory discovery is 143–164ms, comfortably inside budget. The actual
first command a new user runs (`peek list`) is 43× slower than discovery alone because
of what `loadEntries` does with what discovery finds.

## Root cause

`src/commands/list.ts`'s `loadEntries` (per `src/commands/shared.ts`'s documented
pipeline table) does the following for **every main session found**, unconditionally,
before printing a single table row:

```
refs.map(async (ref) => {
  const { session } = await parseAndDedup(ref);       // full parse: every record,
  const priced = priceSession(session, {mode:"auto"}); // every turn, every content span
  return { ref, session: priced };
})
```

wrapped in an unbounded `Promise.all` — all 7,518 main sessions are parsed **fully
concurrently**, with no batching or backpressure.

Two compounding costs, evidenced by the numbers above:

1. **CPU: full parse is done even though `list` only needs `sessionTotals`.**
   `sessionTotals` (`src/engine/accounting.ts`) only reads
   `turn.usage.*`/`turn.cost.*`/`turn.contextTotal` — it never touches
   `turn.contentSpans`. But `parseClaudeSession` unconditionally builds every span via
   `extractAssistantContentSpans`/`extractUserContentSpans`
   (`src/adapters/claude/spans.ts`), including up to 2,000 characters of retained `text`
   per span (`makeSpan`'s `SPAN_TEXT_CAP`). `shared.ts`'s file header already documents
   that `list` deliberately skips `computeComposition` for this reason — but composition
   was never the expensive part; span *extraction*, which happens unconditionally inside
   `parseClaudeSession` itself and is not currently skippable, is.
2. **Memory: unbounded concurrency holds all 7,518 fully-parsed sessions (with their
   retained span text) in memory simultaneously** until the single `Promise.all`
   resolves. Peak RSS hits 3.5GB for this one command. Given the corpus keeps growing
   (this same machine's logs grew from an unknown baseline to 2.68GB / 11,159 files), this
   number gets worse over time, not better, and a 3.5GB peak is uncomfortably close to
   OOM territory on a memory-constrained machine or CI runner.

## Recommended fixes, ranked

1. **Skip span extraction for the `list` pipeline (highest leverage).** Add a cheap/lite
   parse variant (or a flag threaded into `parseClaudeSession`/`buildAssistantTurn`) that
   omits `extractAssistantContentSpans`/`extractUserContentSpans` when the caller only
   needs `usage`/`cost`/`contextTotal`. This is the one that actually cuts the dominant
   cost (CPU time spent building spans, and the memory retained in `span.text`) rather
   than just capping the blast radius. Moderate risk: touches the parse code path shared
   with `context`/`cost`, so it needs a flag rather than deleting the behavior outright.
2. **Bound concurrency in `list.ts`'s `loadEntries` (lowest risk, memory-only win).**
   Replace the unbounded `Promise.all(refs.map(...))` with batches (e.g. 50–100 at a
   time) or a semaphore. Because parsing is CPU-bound on a single JS thread (see the
   throughput math above), this will **not** meaningfully reduce the ~7s wall-clock time,
   but it caps peak RSS well below 3.5GB and prevents the number from scaling linearly
   with corpus size as more sessions accumulate. Trivial, self-contained change.
3. **Persistent cache of per-session totals, keyed by (path, mtime, size), invalidated on
   change (bigger, not "obvious/low-risk" — flagged for later).** `peek list` is a command
   users are expected to run repeatedly; caching `sessionTotals` per session would make
   every run after the first near-instant. This is a real feature, not a one-line fix —
   noted here as the actual long-term answer, not proposed for immediate implementation.

Fix 1 is necessary to meet the <1.5s bar at today's corpus size; fix 2 is cheap insurance
against the memory ceiling regardless of whether fix 1 lands; fix 3 is the durable
answer once the corpus keeps growing past what even a lite parse can do in under 1.5s.

## Privacy note

This report contains only timings, file counts, byte sizes, and turn/cost totals — no
prompt text, tool output, or other session content.

## Post-fix measurement + v1 decision (orchestrator, 2026-08-08)

Fixes #1 (spans:false in the list pipeline) and #2 (batched concurrency) landed and
verified: full suite green, peak RSS capped by batching, `peek list` wall-clock
7.8s → 5.5s on the 11k-file corpus. The remaining time is the predicted floor:
single-threaded JSON.parse over ~2.7GB of transcripts. The 1.5s bar is unreachable
without fix #3 (persistent per-session totals cache keyed by path+mtime+size).

**Decision: v1 ships at ~5.5s cold `list`, documented honestly (no "instant" claims
anywhere). Fix #3 is the top post-v1 performance item.** Mitigations available today:
`--cwd`/`--since`/`--harness` filters cut the parse set proportionally.

## v2 Lane B result (2026-08-09): totals cache shipped

Fix #3 (persistent per-session totals cache, path+mtime+size keyed, schema-versioned
JSONL under XDG_CACHE_HOME) landed. Measured on the real corpus (7,526 main sessions):
cold `peek list` 6.18s (all-miss, unchanged floor), **warm 0.21s** (7,526 hits, 0
re-parses) — 26x under the 1.5s bar. `--no-cache` bypass verified (5.9s full reparse).
The v1 "ships at ~5.5s" decision is superseded for every run after the first.
