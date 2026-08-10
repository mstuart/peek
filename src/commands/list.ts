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
import { loadCache, type TotalsCacheRow, toCacheRow } from "../cache/totals.js";
import { priceSession, sessionTotals } from "../engine/accounting.js";
import type { HarnessId, Session, SessionRef } from "../model/types.js";
import { serializeJSON } from "../render/json.js";
import { formatCompact, formatNumber, renderTable } from "../render/table.js";
import {
  type DiscoverAllOptions,
  describeCheckedRoots,
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
  compactionCount: number;
  cost: number;
  costLabel: string; // dollar amount, or "—" when any turn is unpriced (honesty convention)
  cwd: string;
  cwdLabel: string; // shortened for table display
  harness: HarnessId;
  kind: "main" | "subagent";
  priced: boolean;
  sessionId: string;
  sessionIdShort: string;
  startedAt: Date;
  startedLabel: string;
  tokensLabel: string;
  tokensTotal: number; // exact, from usage — never char/4
  turns: number;
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
  cached: TotalsCacheRow;
  ref: SessionRef;
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
  if (withHome.length <= maxLen) {
    return withHome;
  }
  const parts = withHome.split("/");
  if (parts.length <= 3) {
    return withHome;
  }
  return `${parts[0]}/…/${parts.slice(-2).join("/")}`;
}

function countCompactions(session: Session): number {
  return session.events.filter((e) => e.kind === "compaction").length;
}

interface ListRowFields {
  compactionCount: number;
  cost: number;
  cwd: string;
  priced: boolean;
  ref: SessionRef;
  startedAt: Date;
  tokensTotal: number;
  turns: number;
}

/** The one place that shapes a ListRow — shared by the fresh-parse path
 * (buildListRow) and the cache-hit path (buildCachedListRow) so both stay in
 * lockstep. */
function buildListRowFields(fields: ListRowFields): ListRow {
  return {
    compactionCount: fields.compactionCount,
    cost: fields.cost,
    costLabel: fields.priced ? formatCost(fields.cost) : "—",
    cwd: fields.cwd,
    cwdLabel: shortenCwd(fields.cwd),
    harness: fields.ref.harness,
    kind: fields.ref.kind,
    priced: fields.priced,
    sessionId: fields.ref.id,
    sessionIdShort: shortId(fields.ref.id),
    startedAt: fields.startedAt,
    startedLabel: formatTimestamp(fields.startedAt),
    tokensLabel: formatCompact(fields.tokensTotal),
    tokensTotal: fields.tokensTotal,
    turns: fields.turns,
  };
}

/** Builds one table row from an already deduped+priced session and its ref. */
export function buildListRow(entry: ListEntry): ListRow {
  const totals = sessionTotals(entry.session);
  return buildListRowFields({
    compactionCount: countCompactions(entry.session),
    cost: totals.cost,
    cwd: entry.session.cwd,
    priced: totals.priced,
    ref: entry.ref,
    startedAt: entry.session.startedAt,
    tokensTotal: totals.tokens.contextTotal,
    turns: entry.session.turns.length,
  });
}

/** Builds one table row directly from a cache hit — no Session, no parse. */
export function buildCachedListRow(entry: CachedListEntry): ListRow {
  const row = entry.cached;
  return buildListRowFields({
    compactionCount: row.compactions,
    cost: row.totals.cost,
    cwd: row.cwd,
    priced: row.totals.priced,
    ref: entry.ref,
    startedAt: new Date(row.startedAt),
    tokensTotal: row.totals.tokens.contextTotal,
    turns: row.turns,
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
  opts: BuildListReportOptions = {}
): ListReport {
  const filtered = opts.includeSubagents
    ? entries
    : entries.filter((e) => e.ref.kind === "main");
  const sorted = [...filtered].sort(
    (a, b) => b.ref.mtime.getTime() - a.ref.mtime.getTime()
  );
  return {
    rows: sorted.map((e) =>
      "session" in e ? buildListRow(e) : buildCachedListRow(e)
    ),
  };
}

// ---------------------------------------------------------------------------
// I/O — discovery, parse, stdout.
// ---------------------------------------------------------------------------

export interface ListCommandOptions {
  /** cache/totals.ts's totals cache. Defaults on; `--no-cache` (commander's
   * negated-flag convention) sets this to `false`. */
  cache?: boolean;
  cwd?: string;
  harness?: HarnessId;
  json?: boolean;
  /** Max rows the TEXT table prints; undefined -> DEFAULT_LIST_LIMIT.
   * `0` = unlimited. Display truncation only — does NOT affect what
   * loadEntries loads or what --json emits: --json is the scripting
   * surface and always serializes the full report regardless of --limit. */
  limit?: number;
  /** discoverAll's own test-only escape hatch (shared.ts's ResolveOptions.roots)
   * threaded through so loadEntries can be integration-tested against
   * fixtures instead of the real discovery roots. Production callers (the
   * CLI action below) never set this. */
  roots?: DiscoverAllOptions["roots"];
  since?: Date;
  subagents?: boolean;
  /** Print cache hit/miss counts to stderr. Silent by default — cache
   * hits/misses are an implementation detail, not something every `list`
   * run should narrate. */
  verbose?: boolean;
}

/** `peek list`'s default text-table row cap — large discovery trees
 * (docs/PERF.md: 7.5k+ main sessions is a real corpus size) produce a table
 * too long to be useful without one. `--limit 0` opts out entirely. */
export const DEFAULT_LIST_LIMIT = 50;

// Chunked-batch concurrency cap (docs/PERF.md fix #2): parsing is CPU-bound
// on a single JS thread (per PERF.md's throughput math), so this doesn't cut
// wall-clock time — it caps peak RSS by never holding more than one batch's
// worth of fully-parsed sessions live at once, instead of all 7.5k+ main
// sessions simultaneously under an unbounded Promise.all.
const LOAD_BATCH_SIZE = 64;

export interface LoadEntriesResult {
  /** Present only when the cache was consulted (i.e. `--no-cache` wasn't
   * passed) — timing-independent signal for tests/`--verbose`, not derived
   * from wall-clock. */
  cacheStats?: { hits: number; misses: number };
  entries: ListReportEntry[];
  refCount: number;
}

/** Exported (not just used by runListCommand) so test/unit/cache.test.ts can
 * assert hit/miss behavior against real fixtures + a tmp XDG_CACHE_HOME
 * without spying on internals. */
export async function loadEntries(
  opts: ListCommandOptions
): Promise<LoadEntriesResult> {
  const discoverOpts: DiscoverAllOptions = {};
  if (opts.harness !== undefined) {
    discoverOpts.harness = opts.harness;
  }
  if (opts.cwd !== undefined) {
    discoverOpts.cwd = opts.cwd;
  }
  if (opts.since !== undefined) {
    discoverOpts.since = opts.since;
  }
  if (opts.roots !== undefined) {
    discoverOpts.roots = opts.roots;
  }

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
    // biome-ignore lint/performance/noAwaitInLoops: Batches deliberately cap concurrent transcript parsing.
    const batchEntries = await Promise.all(
      batch.map(async (ref): Promise<ListReportEntry> => {
        const cached = cache?.lookup(ref);
        if (cached) {
          hits += 1;
          return { cached, ref };
        }
        misses += 1;
        const { session } = await parseAndDedup(ref, { spans: false });
        const priced = priceSession(session, { mode: "auto" });
        if (cache) {
          toUpsert.push(toCacheRow(ref, priced));
        }
        return { ref, session: priced };
      })
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

/** `checkedRoots`: shared.ts's describeCheckedRoots(options), precomputed by
 * the caller (runListCommand) since this function stays a plain sync
 * renderer otherwise. `limit`: 0 = unlimited, matching DEFAULT_LIST_LIMIT's
 * own `--limit 0` contract. */
function printListReport(
  report: ListReport,
  opts: { limit: number; checkedRoots: string }
): void {
  if (report.rows.length === 0) {
    process.stdout.write(
      `no sessions found — checked ${opts.checkedRoots} (try --harness/--cwd/--since to narrow or widen the search)\n`
    );
    return;
  }
  const shown =
    opts.limit === 0 ? report.rows : report.rows.slice(0, opts.limit);
  const rows = shown.map((r) => [
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
      { align: "right", header: "turns" },
      { align: "right", header: "tokens" },
      { align: "right", header: "cost" },
      { align: "right", header: "compactions" },
    ],
    rows
  );
  process.stdout.write(`${table}\n`);
  const remaining = report.rows.length - shown.length;
  if (remaining > 0) {
    process.stdout.write(
      `…and ${formatNumber(remaining)} more session${remaining === 1 ? "" : "s"} (use --limit <n> or --limit 0 for all)\n`
    );
  }
}

export async function runListCommand(
  options: ListCommandOptions
): Promise<void> {
  const { entries, cacheStats } = await loadEntries(options);
  const report = buildListReport(entries, {
    includeSubagents: Boolean(options.subagents),
  });
  if (options.verbose && cacheStats) {
    process.stderr.write(
      `cache: ${cacheStats.hits} hit${cacheStats.hits === 1 ? "" : "s"}, ${cacheStats.misses} miss${cacheStats.misses === 1 ? "" : "es"}\n`
    );
  }
  if (options.json) {
    process.stdout.write(`${serializeJSON(report)}\n`);
    return;
  }
  const rootsOpts: Parameters<typeof describeCheckedRoots>[0] = {};
  if (options.harness !== undefined) {
    rootsOpts.harness = options.harness;
  }
  if (options.roots !== undefined) {
    rootsOpts.roots = options.roots;
  }
  printListReport(report, {
    checkedRoots: describeCheckedRoots(rootsOpts),
    limit: options.limit ?? DEFAULT_LIST_LIMIT,
  });
}

// ---------------------------------------------------------------------------
// Command registration — the orchestrator wires this into cli.ts.
// ---------------------------------------------------------------------------

function parseLimit(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--limit must be a non-negative integer (got: ${value})`);
  }
  return n;
}

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description(
      "Cross-harness inventory of discovered sessions: cost, tokens, compactions."
    )
    .option(
      "--harness <harness>",
      "restrict to one harness: claude-code | codex | pi",
      parseHarnessOption
    )
    .option(
      "--cwd <path>",
      "restrict to sessions discovered from this working directory"
    )
    .option(
      "--since <date>",
      "restrict to sessions modified on/after this date (YYYY-MM-DD or ISO)",
      parseSinceOption
    )
    .option("--subagents", "include subagent sessions (excluded by default)")
    .option("--json", "emit the full computed structure as JSON")
    .option("--no-cache", "bypass the on-disk totals cache; always parse fresh")
    .option("--verbose", "print cache hit/miss counts to stderr")
    .option(
      "--limit <n>",
      "max rows to print (0 = unlimited); does not affect --json, which is always the full report",
      parseLimit,
      DEFAULT_LIST_LIMIT
    )
    .action(
      async (opts: {
        harness?: HarnessId;
        cwd?: string;
        since?: Date;
        subagents?: boolean;
        json?: boolean;
        cache?: boolean;
        verbose?: boolean;
        limit: number;
      }) => {
        try {
          const commandOpts: ListCommandOptions = {
            cache: opts.cache !== false,
            json: Boolean(opts.json),
            limit: opts.limit,
            subagents: Boolean(opts.subagents),
            verbose: Boolean(opts.verbose),
          };
          if (opts.harness !== undefined) {
            commandOpts.harness = opts.harness;
          }
          if (opts.cwd !== undefined) {
            commandOpts.cwd = opts.cwd;
          }
          if (opts.since !== undefined) {
            commandOpts.since = opts.since;
          }
          await runListCommand(commandOpts);
        } catch (err) {
          process.stderr.write(
            `${err instanceof Error ? err.message : String(err)}\n`
          );
          process.exitCode = 1;
        }
      }
    );
}
