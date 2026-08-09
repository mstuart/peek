// `peek list` (T3.1) — docs/DESIGN.md § "CLI surface": "documented first
// command: cross-harness inventory (cost/tokens/compactions)". First command
// a new user runs (`npx peek-agent list`, per PLAN's pitch order).
//
// Pipeline (commands/shared.ts's file header): parse -> dedupSession ->
// priceSession -> sessionTotals. Composition is deliberately skipped — see
// that header for why.
//
// Two halves, same separation as commands/context.ts: buildListReport/
// buildListRow are PURE (Session+SessionRef -> report structure, no I/O) —
// what test/unit/commands.test.ts snapshots. loadAllEntries/runListCommand
// are the I/O half (discovery, parse, stdout).

import { homedir } from "node:os";
import type { Command } from "commander";
import { type TotalsCacheRow, loadCache, toCacheRow } from "../cache/totals.js";
import { priceSession } from "../engine/accounting.js";
import { sessionTotals } from "../engine/accounting.js";
import type { HarnessId, Session, SessionRef } from "../model/types.js";
import { serializeJSON } from "../render/json.js";
import { formatCompact, formatNumber, renderTable } from "../render/table.js";
import {
  type DiscoverAllOptions,
  discoverAll,
  formatCost,
  formatTimestamp,
  parseAndDedup,
  parseHarnessOption,
  parseSinceOption,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Report structure — pure, JSON-serializable.
// ---------------------------------------------------------------------------

export interface ListRow {
  harness: HarnessId;
  sessionId: string;
  sessionIdShort: string;
  cwd: string;
  cwdLabel: string; // shortened for table display
  startedAt: Date;
  startedLabel: string;
  turns: number;
  tokensTotal: number; // exact, from usage — never char/4
  tokensLabel: string;
  cost: number;
  costLabel: string; // dollar amount, or "—" when any turn is unpriced (honesty convention)
  priced: boolean;
  compactionCount: number;
  kind: "main" | "subagent";
}

export interface ListReport {
  rows: ListRow[];
}

export interface ListEntry {
  ref: SessionRef;
  /** Deduped AND priced (accounting.ts's priceSession) — sessionTotals needs
   * turn.cost populated. */
  session: Session;
}

/** A row served from cache/totals.ts's TotalsCache instead of a fresh parse
 * — no Session available, just the pre-computed totals. */
export interface CachedListEntry {
  ref: SessionRef;
  cached: TotalsCacheRow;
}

/** buildListReport's filter (ref.kind) and sort (ref.mtime) only ever touch
 * `ref`, never session content, so it accepts either a freshly parsed entry
 * or a cache hit — loadEntries mixes both per-file (cache hit -> row, skip
 * parse; miss -> parse -> upsert, docs/DESIGN.md § Other v2 subsystems (Lane B)). */
export type ListReportEntry = ListEntry | CachedListEntry;

const HOME = homedir();

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** "/Users/me/git/peek" -> "~/git/peek". Long paths keep the first segment
 * and last two, eliding the middle, rather than a hard character truncation
 * that could cut mid-directory-name. */
function shortenCwd(cwd: string, maxLen = 40): string {
  const withHome = cwd.startsWith(HOME) ? `~${cwd.slice(HOME.length)}` : cwd;
  if (withHome.length <= maxLen) return withHome;
  const parts = withHome.split("/");
  if (parts.length <= 3) return withHome;
  return `${parts[0]}/…/${parts.slice(-2).join("/")}`;
}

function countCompactions(session: Session): number {
  return session.events.filter((e) => e.kind === "compaction").length;
}

interface ListRowFields {
  ref: SessionRef;
  cwd: string;
  startedAt: Date;
  turns: number;
  tokensTotal: number;
  cost: number;
  priced: boolean;
  compactionCount: number;
}

/** The one place that shapes a ListRow — shared by the fresh-parse path
 * (buildListRow) and the cache-hit path (buildCachedListRow) so both stay in
 * lockstep. */
function buildListRowFields(fields: ListRowFields): ListRow {
  return {
    harness: fields.ref.harness,
    sessionId: fields.ref.id,
    sessionIdShort: shortId(fields.ref.id),
    cwd: fields.cwd,
    cwdLabel: shortenCwd(fields.cwd),
    startedAt: fields.startedAt,
    startedLabel: formatTimestamp(fields.startedAt),
    turns: fields.turns,
    tokensTotal: fields.tokensTotal,
    tokensLabel: formatCompact(fields.tokensTotal),
    cost: fields.cost,
    costLabel: fields.priced ? formatCost(fields.cost) : "—",
    priced: fields.priced,
    compactionCount: fields.compactionCount,
    kind: fields.ref.kind,
  };
}

/** Builds one table row from an already deduped+priced session and its ref. */
export function buildListRow(entry: ListEntry): ListRow {
  const totals = sessionTotals(entry.session);
  return buildListRowFields({
    ref: entry.ref,
    cwd: entry.session.cwd,
    startedAt: entry.session.startedAt,
    turns: entry.session.turns.length,
    tokensTotal: totals.tokens.contextTotal,
    cost: totals.cost,
    priced: totals.priced,
    compactionCount: countCompactions(entry.session),
  });
}

/** Builds one table row directly from a cache hit — no Session, no parse. */
export function buildCachedListRow(entry: CachedListEntry): ListRow {
  const row = entry.cached;
  return buildListRowFields({
    ref: entry.ref,
    cwd: row.cwd,
    startedAt: new Date(row.startedAt),
    turns: row.turns,
    tokensTotal: row.totals.tokens.contextTotal,
    cost: row.totals.cost,
    priced: row.totals.priced,
    compactionCount: row.compactions,
  });
}

export interface BuildListReportOptions {
  /** Main sessions only by default (PLAN's `list` UX); set true to also
   * include subagent sessions. */
  includeSubagents?: boolean;
}

/** Filters (main-only by default) and sorts (mtime desc) a set of loaded
 * entries into the final report. Pure — does no I/O. Accepts a mix of
 * freshly parsed and cache-hit entries (ListReportEntry); the filter/sort
 * only ever reads `ref`, never session content, so both kinds interleave
 * freely. */
export function buildListReport(
  entries: readonly ListReportEntry[],
  opts: BuildListReportOptions = {},
): ListReport {
  const filtered = opts.includeSubagents
    ? entries
    : entries.filter((e) => e.ref.kind === "main");
  const sorted = [...filtered].sort(
    (a, b) => b.ref.mtime.getTime() - a.ref.mtime.getTime(),
  );
  return {
    rows: sorted.map((e) =>
      "session" in e ? buildListRow(e) : buildCachedListRow(e),
    ),
  };
}

// ---------------------------------------------------------------------------
// I/O — discovery, parse, stdout.
// ---------------------------------------------------------------------------

export interface ListCommandOptions {
  harness?: HarnessId;
  cwd?: string;
  since?: Date;
  subagents?: boolean;
  json?: boolean;
  /** cache/totals.ts's totals cache. Defaults on; `--no-cache` (commander's
   * negated-flag convention) sets this to `false`. */
  cache?: boolean;
  /** Print cache hit/miss counts to stderr. Silent by default — cache
   * hits/misses are an implementation detail, not something every `list`
   * run should narrate. */
  verbose?: boolean;
  /** discoverAll's own test-only escape hatch (shared.ts's ResolveOptions.roots)
   * threaded through so loadEntries can be integration-tested against
   * fixtures instead of the real discovery roots. Production callers (the
   * CLI action below) never set this. */
  roots?: DiscoverAllOptions["roots"];
}

// Chunked-batch concurrency cap (docs/PERF.md fix #2): parsing is CPU-bound
// on a single JS thread (per PERF.md's throughput math), so this doesn't cut
// wall-clock time — it caps peak RSS by never holding more than one batch's
// worth of fully-parsed sessions live at once, instead of all 7.5k+ main
// sessions simultaneously under an unbounded Promise.all.
const LOAD_BATCH_SIZE = 64;

export interface LoadEntriesResult {
  entries: ListReportEntry[];
  refCount: number;
  /** Present only when the cache was consulted (i.e. `--no-cache` wasn't
   * passed) — timing-independent signal for tests/`--verbose`, not derived
   * from wall-clock. */
  cacheStats?: { hits: number; misses: number };
}

/** Exported (not just used by runListCommand) so test/unit/cache.test.ts can
 * assert hit/miss behavior against real fixtures + a tmp XDG_CACHE_HOME
 * without spying on internals. */
export async function loadEntries(
  opts: ListCommandOptions,
): Promise<LoadEntriesResult> {
  const discoverOpts: DiscoverAllOptions = {};
  if (opts.harness !== undefined) discoverOpts.harness = opts.harness;
  if (opts.cwd !== undefined) discoverOpts.cwd = opts.cwd;
  if (opts.since !== undefined) discoverOpts.since = opts.since;
  if (opts.roots !== undefined) discoverOpts.roots = opts.roots;

  const allRefs = await discoverAll(discoverOpts);
  // Parse only what buildListReport could possibly need: skip subagent refs
  // entirely (not just at render time) when --subagents wasn't passed — the
  // whole point of this command is fast cross-session inventory.
  const refs = opts.subagents
    ? allRefs
    : allRefs.filter((r) => r.kind === "main");

  // Totals cache (docs/DESIGN.md § Other v2 subsystems, Lane B / docs/PERF.md fix #3): a hit
  // (path+mtimeMs+size all match) skips the parse entirely; a miss still
  // takes the spans:false lite-parse path below and gets upserted so the
  // NEXT `list` run hits.
  const useCache = opts.cache !== false;
  const cache = useCache ? await loadCache() : undefined;
  let hits = 0;
  let misses = 0;
  const toUpsert: TotalsCacheRow[] = [];

  // spans:false (docs/PERF.md fix #1): list only ever reads sessionTotals
  // (usage/cost/contextTotal), never contentSpans/composition, so the lite
  // parse skips span extraction — the dominant cost of a full parse.
  const entries: ListReportEntry[] = [];
  for (let i = 0; i < refs.length; i += LOAD_BATCH_SIZE) {
    const batch = refs.slice(i, i + LOAD_BATCH_SIZE);
    const batchEntries = await Promise.all(
      batch.map(async (ref): Promise<ListReportEntry> => {
        const cached = cache?.lookup(ref);
        if (cached) {
          hits++;
          return { ref, cached };
        }
        misses++;
        const { session } = await parseAndDedup(ref, { spans: false });
        const priced = priceSession(session, { mode: "auto" });
        if (cache) toUpsert.push(toCacheRow(ref, priced));
        return { ref, session: priced };
      }),
    );
    entries.push(...batchEntries);
  }

  if (cache && toUpsert.length > 0) {
    await cache.upsert(toUpsert);
  }

  return {
    entries,
    refCount: allRefs.length,
    ...(useCache ? { cacheStats: { hits, misses } } : {}),
  };
}

function printListReport(report: ListReport): void {
  if (report.rows.length === 0) {
    process.stdout.write(
      "no sessions found (try --harness/--cwd/--since, or check discovery roots)\n",
    );
    return;
  }
  const rows = report.rows.map((r) => [
    r.harness,
    r.sessionIdShort,
    r.cwdLabel,
    r.startedLabel,
    formatNumber(r.turns),
    r.tokensLabel,
    r.costLabel,
    formatNumber(r.compactionCount),
  ]);
  const table = renderTable(
    [
      { header: "harness" },
      { header: "session" },
      { header: "cwd" },
      { header: "started" },
      { header: "turns", align: "right" },
      { header: "tokens", align: "right" },
      { header: "cost", align: "right" },
      { header: "compactions", align: "right" },
    ],
    rows,
  );
  process.stdout.write(`${table}\n`);
}

export async function runListCommand(
  options: ListCommandOptions,
): Promise<void> {
  const { entries, cacheStats } = await loadEntries(options);
  const report = buildListReport(entries, {
    includeSubagents: Boolean(options.subagents),
  });
  if (options.verbose && cacheStats) {
    process.stderr.write(
      `cache: ${cacheStats.hits} hit${cacheStats.hits === 1 ? "" : "s"}, ${cacheStats.misses} miss${cacheStats.misses === 1 ? "" : "es"}\n`,
    );
  }
  if (options.json) {
    process.stdout.write(`${serializeJSON(report)}\n`);
    return;
  }
  printListReport(report);
}

// ---------------------------------------------------------------------------
// Command registration — the orchestrator wires this into cli.ts.
// ---------------------------------------------------------------------------

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description(
      "Cross-harness inventory of discovered sessions: cost, tokens, compactions.",
    )
    .option(
      "--harness <harness>",
      "restrict to one harness: claude-code | codex | pi",
      parseHarnessOption,
    )
    .option(
      "--cwd <path>",
      "restrict to sessions discovered from this working directory",
    )
    .option(
      "--since <date>",
      "restrict to sessions modified on/after this date (YYYY-MM-DD or ISO)",
      parseSinceOption,
    )
    .option("--subagents", "include subagent sessions (excluded by default)")
    .option("--json", "emit the full computed structure as JSON")
    .option("--no-cache", "bypass the on-disk totals cache; always parse fresh")
    .option("--verbose", "print cache hit/miss counts to stderr")
    .action(
      async (opts: {
        harness?: HarnessId;
        cwd?: string;
        since?: Date;
        subagents?: boolean;
        json?: boolean;
        cache?: boolean;
        verbose?: boolean;
      }) => {
        try {
          const commandOpts: ListCommandOptions = {
            subagents: Boolean(opts.subagents),
            json: Boolean(opts.json),
            cache: opts.cache !== false,
            verbose: Boolean(opts.verbose),
          };
          if (opts.harness !== undefined) commandOpts.harness = opts.harness;
          if (opts.cwd !== undefined) commandOpts.cwd = opts.cwd;
          if (opts.since !== undefined) commandOpts.since = opts.since;
          await runListCommand(commandOpts);
        } catch (err) {
          process.stderr.write(
            `${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exitCode = 1;
        }
      },
    );
}
