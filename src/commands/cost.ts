// `peek cost` (T3.1) — docs/DESIGN.md § "CLI surface": "historical
// attribution: model/tool/MCP server/subagent; cache waste; miss-reason
// spikes".
//
// Pipeline (commands/shared.ts's file header): parse -> dedupSession ->
// priceSession -> engine/attribution.ts's byModel/byTool/byMcpServer/
// cacheAnalysis. Composition is not needed (attribution reads Span fields
// directly off contentSpans).
//
// `--all` aggregation and family dedup: engine/dedup.ts's dedupFamily()
// dedups a parent + its subagent children ACROSS file boundaries (zeroing
// usage/cost/contextTotal on later-seen (message.id, requestId) replays —
// docs/DESIGN.md § Measured results ledger's documented "per-file dedup" gap
// (T2.5 reconciliation result: ~1.6-5.9% inflation on a heavily-forked
// orchestrator family without it). Its documented precondition is a set of
// already-priced sessions (it zeroes CostBreakdown too, not just tokens), so
// `--all` prices each parent+children family BEFORE calling dedupFamily,
// then rolls the result up via attribution.ts's bySubagent().
//
// `--all` byModel/byTool/byMcpServer (docs/DESIGN.md § Other v2 subsystems, Lane C): attribution.ts's
// mergeAttribution() merges these across every family AND across families
// (the cross-harness case) in one pass. It does its OWN replay exclusion
// rather than consuming dedupFamily's output — see its doc comment — so
// `--all` passes each family's pre-dedupFamily [parent, ...children] array
// straight through (buildFamilyForRef below).

import type { Command } from "commander";
import {
  type SessionTotals,
  priceSession,
  sessionTotals,
} from "../engine/accounting.js";
import {
  type CacheAnalysis,
  type CacheTotals,
  type MergedAttribution,
  type SubagentRollup,
  byMcpServer,
  byModel,
  bySubagent,
  byTool,
  cacheAnalysis,
  mergeAttribution,
} from "../engine/attribution.js";
import type { HarnessId, Session, SessionRef } from "../model/types.js";
import { serializeJSON } from "../render/json.js";
import { formatNumber, renderTable } from "../render/table.js";
import {
  type DiscoverAllOptions,
  type ResolveOptions,
  discoverAll,
  formatCost,
  formatTimestamp,
  loadSession,
  parseAndDedup,
  parseHarnessOption,
  parseSinceOption,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Report structure — single session.
// ---------------------------------------------------------------------------

export interface CostTotalsRow {
  tokens: SessionTotals["tokens"];
  cost: number;
  costLabel: string; // "—" when unpriced — honesty convention
  priced: boolean;
}

export interface CostModelRow {
  model: string;
  turnCount: number;
  tokens: SessionTotals["tokens"];
  costLabel: string;
  priced: boolean;
}

export interface CostToolRow {
  toolName: string;
  mcpServer?: string;
  callCount: number; // exact — toolCallArgs span count
  resultCount: number; // exact — toolResults span count
  tokenShareEst: number;
  tokenShareLabel: string; // "~"-prefixed — char/4 estimate, never a cost figure
}

export interface CostMcpRow {
  mcpServer: string;
  tools: string[];
  callCount: number;
  resultCount: number;
  tokenShareEst: number;
  tokenShareLabel: string;
}

export interface CostCacheMissRow {
  turnIndex: number;
  turnNumber: number; // 1-indexed
  timestampLabel: string;
  type?: string;
  cacheMissedInputTokensLabel?: string; // exact diagnostic figure, unprefixed
}

export interface CostCacheReport {
  hitRatePct: number;
  hitRateLabel: string;
  totals: CacheTotals;
  /** Exact sum of missReasons[].cacheMissedInputTokens — tokens re-billed as
   * full input because of a documented cache miss. Token-denominated (not a
   * dollar figure) so it never needs its own separate pricing pass outside
   * accounting.ts. */
  wasteTokens: number;
  wasteTokensLabel: string;
  missReasons: CostCacheMissRow[];
}

export interface CostReport {
  harness: HarnessId;
  sessionId: string;
  cwd: string;
  model: string;
  totals: CostTotalsRow;
  byModel: CostModelRow[];
  byTool: CostToolRow[];
  byMcpServer: CostMcpRow[];
  cache: CostCacheReport;
}

function buildCacheReport(analysis: CacheAnalysis): CostCacheReport {
  const wasteTokens = analysis.missReasons.reduce(
    (sum, m) => sum + (m.cacheMissedInputTokens ?? 0),
    0,
  );
  return {
    hitRatePct: analysis.hitRate * 100,
    hitRateLabel: `${Math.round(analysis.hitRate * 100)}%`,
    totals: analysis.totals,
    wasteTokens,
    wasteTokensLabel: formatNumber(wasteTokens),
    missReasons: analysis.missReasons.map((m) => ({
      turnIndex: m.turnIndex,
      turnNumber: m.turnIndex + 1,
      timestampLabel: formatTimestamp(m.timestamp),
      ...(m.type !== undefined ? { type: m.type } : {}),
      ...(m.cacheMissedInputTokens !== undefined
        ? {
            cacheMissedInputTokensLabel: formatNumber(m.cacheMissedInputTokens),
          }
        : {}),
    })),
  };
}

/**
 * Builds the full cost-attribution report for an already deduped+priced
 * session (see loadPricedSession). Pure; does no I/O.
 */
export function buildCostReport(session: Session): CostReport {
  const totals = sessionTotals(session);
  return {
    harness: session.harness,
    sessionId: session.id,
    cwd: session.cwd,
    model: session.configSnapshot.model,
    totals: {
      tokens: totals.tokens,
      cost: totals.cost,
      costLabel: totals.priced ? formatCost(totals.cost) : "—",
      priced: totals.priced,
    },
    byModel: byModel(session).map((m) => ({
      model: m.model,
      turnCount: m.turnCount,
      tokens: m.tokens,
      costLabel: m.priced ? formatCost(m.cost) : "—",
      priced: m.priced,
    })),
    byTool: byTool(session).map((t) => ({
      toolName: t.toolName,
      ...(t.mcpServer !== undefined ? { mcpServer: t.mcpServer } : {}),
      callCount: t.toolCallArgs.spanCount,
      resultCount: t.toolResults.spanCount,
      tokenShareEst: t.tokenShareEst,
      tokenShareLabel: `~${formatNumber(t.tokenShareEst)}`,
    })),
    byMcpServer: byMcpServer(session).map((s) => ({
      mcpServer: s.mcpServer,
      tools: s.tools,
      callCount: s.toolCallArgs.spanCount,
      resultCount: s.toolResults.spanCount,
      tokenShareEst: s.tokenShareEst,
      tokenShareLabel: `~${formatNumber(s.tokenShareEst)}`,
    })),
    cache: buildCacheReport(cacheAnalysis(session)),
  };
}

// ---------------------------------------------------------------------------
// Report structure — `--all` aggregate.
// ---------------------------------------------------------------------------

export interface CostAllHarnessRow {
  harness: HarnessId;
  sessionCount: number;
  tokens: SessionTotals["tokens"];
  costLabel: string;
  priced: boolean;
}

export interface CostAllReport {
  sessionCount: number;
  totals: CostTotalsRow;
  byHarness: CostAllHarnessRow[];
  byModel: CostModelRow[];
  byTool: CostToolRow[];
  byMcpServer: CostMcpRow[];
  note: string;
}

export const FAMILY_DEDUP_NOTE =
  "aggregated per-session-family: each main session is combined with its subagent children " +
  "and deduped ACROSS those files (engine/dedup.ts's dedupFamily — catches a session replayed " +
  "verbatim between a parent and a subagent, docs/DESIGN.md § Measured results ledger's measured ~1.6-5.9% overcount case) " +
  "before rolling up via bySubagent. byModel/byTool/byMcpServer below are merged the same way " +
  "(engine/attribution.ts's mergeAttribution) — a cross-file replay turn is excluded from " +
  "those tables entirely, not just zeroed, so its tool-call/tool-result spans don't inflate " +
  "call counts or token-share estimates either. There is still no dedup ACROSS separate " +
  "main-session families (e.g. two independent sessions that happen to share replayed " +
  "content) — each family's own totals are exact; cross-family duplication, if any, is not " +
  "detected.";

export interface CostAllEntry {
  ref: SessionRef;
  rollup: SubagentRollup;
  /** parent + children, per-file deduped (dedupSession) + priced, pre-dedupFamily — the raw
   * material for mergeAttribution, which does its own cross-file replay exclusion (see its doc
   * comment for why it doesn't just consume dedupFamily's already-zeroed output). */
  family: Session[];
}

function zeroTokens(): SessionTotals["tokens"] {
  return {
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    contextTotal: 0,
  };
}

function zeroTotals(): SessionTotals {
  return { tokens: zeroTokens(), cost: 0, priced: true };
}

function mergeTotals(a: SessionTotals, b: SessionTotals): SessionTotals {
  return {
    tokens: {
      inputUncached: a.tokens.inputUncached + b.tokens.inputUncached,
      cacheRead: a.tokens.cacheRead + b.tokens.cacheRead,
      cacheWrite5m: a.tokens.cacheWrite5m + b.tokens.cacheWrite5m,
      cacheWrite1h: a.tokens.cacheWrite1h + b.tokens.cacheWrite1h,
      output: a.tokens.output + b.tokens.output,
      contextTotal: a.tokens.contextTotal + b.tokens.contextTotal,
    },
    cost: a.cost + b.cost,
    priced: a.priced && b.priced,
  };
}

/** Aggregates per-session rollups (see CostAllEntry) into the `--all` report.
 * Pure; does no I/O. */
export function buildCostAllReport(
  entries: readonly CostAllEntry[],
): CostAllReport {
  const byHarnessMap = new Map<
    HarnessId,
    { count: number; totals: SessionTotals }
  >();
  let totals = zeroTotals();

  for (const entry of entries) {
    const combined = entry.rollup.combined;
    totals = mergeTotals(totals, combined);
    const bucket = byHarnessMap.get(entry.ref.harness) ?? {
      count: 0,
      totals: zeroTotals(),
    };
    bucket.count += 1;
    bucket.totals = mergeTotals(bucket.totals, combined);
    byHarnessMap.set(entry.ref.harness, bucket);
  }

  const byHarness: CostAllHarnessRow[] = [...byHarnessMap.entries()]
    .map(([harness, b]) => ({
      harness,
      sessionCount: b.count,
      tokens: b.totals.tokens,
      costLabel: b.totals.priced ? formatCost(b.totals.cost) : "—",
      priced: b.totals.priced,
    }))
    .sort((a, b) => a.harness.localeCompare(b.harness));

  const merged: MergedAttribution = mergeAttribution(
    entries.map((entry) => entry.family),
  );

  return {
    sessionCount: entries.length,
    totals: {
      tokens: totals.tokens,
      cost: totals.cost,
      costLabel: totals.priced ? formatCost(totals.cost) : "—",
      priced: totals.priced,
    },
    byHarness,
    byModel: merged.byModel.map((m) => ({
      model: m.model,
      turnCount: m.turnCount,
      tokens: m.tokens,
      costLabel: m.priced ? formatCost(m.cost) : "—",
      priced: m.priced,
    })),
    byTool: merged.byTool.map((t) => ({
      toolName: t.toolName,
      ...(t.mcpServer !== undefined ? { mcpServer: t.mcpServer } : {}),
      callCount: t.toolCallArgs.spanCount,
      resultCount: t.toolResults.spanCount,
      tokenShareEst: t.tokenShareEst,
      tokenShareLabel: `~${formatNumber(t.tokenShareEst)}`,
    })),
    byMcpServer: merged.byMcpServer.map((s) => ({
      mcpServer: s.mcpServer,
      tools: s.tools,
      callCount: s.toolCallArgs.spanCount,
      resultCount: s.toolResults.spanCount,
      tokenShareEst: s.tokenShareEst,
      tokenShareLabel: `~${formatNumber(s.tokenShareEst)}`,
    })),
    note: FAMILY_DEDUP_NOTE,
  };
}

// ---------------------------------------------------------------------------
// I/O — discovery, parse, pricing, stdout.
// ---------------------------------------------------------------------------

/** parse -> dedupSession -> priceSession for `peek cost <sess>`. */
export async function loadPricedSession(
  idOrPath: string | undefined,
  opts: ResolveOptions = {},
): Promise<Session> {
  const { session } = await loadSession(idOrPath, opts);
  return priceSession(session, { mode: "auto" });
}

async function buildFamilyForRef(
  ref: SessionRef,
): Promise<{ rollup: SubagentRollup; family: Session[] }> {
  const { session } = await parseAndDedup(ref);
  const parent = priceSession(session, { mode: "auto" });
  const children = await Promise.all(
    parent.children.map(async (childRef) => {
      const { session: childSession } = await parseAndDedup(childRef);
      return priceSession(childSession, { mode: "auto" });
    }),
  );
  const family = [parent, ...children];
  // bySubagent (dedupFamily's documented caller) applies dedupFamily itself;
  // mergeAttribution (buildCostAllReport) does its own independent replay
  // exclusion over this same pre-dedupFamily family — see its doc comment.
  return { rollup: bySubagent(family), family };
}

/** `--by tool|mcp|model` — filters `peek cost`/`peek cost --all` human output
 * down to one of the three attribution tables. Undefined (no `--by`) prints
 * all of them, the existing default. JSON output (`--json`) is unaffected —
 * it always emits the full computed structure, per its own help text. */
export type CostByFilter = "tool" | "mcp" | "model";

const COST_BY_FILTERS: readonly CostByFilter[] = ["tool", "mcp", "model"];

/** commander option parser for `--by` — mirrors shared.ts's parseHarnessOption's
 * validate-and-cast shape (that file is off-limits for this task, so this is
 * a local copy rather than a shared export). */
export function parseByOption(value: string): CostByFilter {
  if ((COST_BY_FILTERS as readonly string[]).includes(value)) {
    return value as CostByFilter;
  }
  throw new Error(
    `--by must be one of ${COST_BY_FILTERS.join(", ")} (got: ${value})`,
  );
}

function showsSection(
  by: CostByFilter | undefined,
  section: CostByFilter,
): boolean {
  return by === undefined || by === section;
}

function printCostReport(report: CostReport, by?: CostByFilter): void {
  process.stdout.write(
    `peek cost — ${report.harness} · ${report.sessionId} · ${report.cwd}\n\n`,
  );
  process.stdout.write(
    `total: ${report.totals.costLabel}  (${formatNumber(report.totals.tokens.contextTotal)} tokens)\n\n`,
  );

  if (showsSection(by, "model") && report.byModel.length > 0) {
    process.stdout.write("by model\n");
    process.stdout.write(
      `${renderTable(
        [
          { header: "model" },
          { header: "turns", align: "right" },
          { header: "tokens", align: "right" },
          { header: "cost", align: "right" },
        ],
        report.byModel.map((m) => [
          m.model,
          formatNumber(m.turnCount),
          formatNumber(m.tokens.contextTotal),
          m.costLabel,
        ]),
      )}\n\n`,
    );
  }

  if (showsSection(by, "tool") && report.byTool.length > 0) {
    process.stdout.write("by tool (token share is a char/4 estimate)\n");
    process.stdout.write(
      `${renderTable(
        [
          { header: "tool" },
          { header: "mcp server" },
          { header: "calls", align: "right" },
          { header: "results", align: "right" },
          { header: "~tokens", align: "right" },
        ],
        report.byTool.map((t) => [
          t.toolName,
          t.mcpServer ?? "",
          formatNumber(t.callCount),
          formatNumber(t.resultCount),
          t.tokenShareLabel,
        ]),
      )}\n\n`,
    );
  }

  if (showsSection(by, "mcp") && report.byMcpServer.length > 0) {
    process.stdout.write("by MCP server\n");
    process.stdout.write(
      `${renderTable(
        [
          { header: "server" },
          { header: "tools" },
          { header: "calls", align: "right" },
          { header: "~tokens", align: "right" },
        ],
        report.byMcpServer.map((s) => [
          s.mcpServer,
          s.tools.join(", "),
          formatNumber(s.callCount),
          s.tokenShareLabel,
        ]),
      )}\n\n`,
    );
  }

  process.stdout.write(
    `cache: ${report.cache.hitRateLabel} hit rate, ${report.cache.wasteTokensLabel} tokens re-billed on ${report.cache.missReasons.length} documented miss${report.cache.missReasons.length === 1 ? "" : "es"}\n`,
  );
  if (report.cache.missReasons.length > 0) {
    process.stdout.write(
      `${renderTable(
        [
          { header: "turn", align: "right" },
          { header: "when" },
          { header: "reason" },
          { header: "tokens", align: "right" },
        ],
        report.cache.missReasons.map((m) => [
          formatNumber(m.turnNumber),
          m.timestampLabel,
          m.type ?? "",
          m.cacheMissedInputTokensLabel ?? "",
        ]),
      )}\n`,
    );
  }
}

function printCostAllReport(report: CostAllReport, by?: CostByFilter): void {
  process.stdout.write(
    `peek cost --all — ${report.sessionCount} session${report.sessionCount === 1 ? "" : "s"}\n\n`,
  );
  process.stdout.write(
    `total: ${report.totals.costLabel}  (${formatNumber(report.totals.tokens.contextTotal)} tokens)\n\n`,
  );
  process.stdout.write(
    `${renderTable(
      [
        { header: "harness" },
        { header: "sessions", align: "right" },
        { header: "tokens", align: "right" },
        { header: "cost", align: "right" },
      ],
      report.byHarness.map((h) => [
        h.harness,
        formatNumber(h.sessionCount),
        formatNumber(h.tokens.contextTotal),
        h.costLabel,
      ]),
    )}\n\n`,
  );

  if (showsSection(by, "model") && report.byModel.length > 0) {
    process.stdout.write("by model\n");
    process.stdout.write(
      `${renderTable(
        [
          { header: "model" },
          { header: "turns", align: "right" },
          { header: "tokens", align: "right" },
          { header: "cost", align: "right" },
        ],
        report.byModel.map((m) => [
          m.model,
          formatNumber(m.turnCount),
          formatNumber(m.tokens.contextTotal),
          m.costLabel,
        ]),
      )}\n\n`,
    );
  }

  if (showsSection(by, "tool") && report.byTool.length > 0) {
    process.stdout.write("by tool (token share is a char/4 estimate)\n");
    process.stdout.write(
      `${renderTable(
        [
          { header: "tool" },
          { header: "mcp server" },
          { header: "calls", align: "right" },
          { header: "results", align: "right" },
          { header: "~tokens", align: "right" },
        ],
        report.byTool.map((t) => [
          t.toolName,
          t.mcpServer ?? "",
          formatNumber(t.callCount),
          formatNumber(t.resultCount),
          t.tokenShareLabel,
        ]),
      )}\n\n`,
    );
  }

  if (showsSection(by, "mcp") && report.byMcpServer.length > 0) {
    process.stdout.write("by MCP server\n");
    process.stdout.write(
      `${renderTable(
        [
          { header: "server" },
          { header: "tools" },
          { header: "calls", align: "right" },
          { header: "~tokens", align: "right" },
        ],
        report.byMcpServer.map((s) => [
          s.mcpServer,
          s.tools.join(", "),
          formatNumber(s.callCount),
          s.tokenShareLabel,
        ]),
      )}\n\n`,
    );
  }

  process.stdout.write(`note: ${report.note}\n`);
}

export interface CostCommandOptions {
  harness?: HarnessId;
  cwd?: string;
  since?: Date;
  all?: boolean;
  json?: boolean;
  by?: CostByFilter;
  /** discoverAll's own test-only escape hatch (shared.ts's ResolveOptions.roots),
   * threaded through so `--all` can be integration-tested against fixtures
   * instead of the real discovery roots — same pattern as list.ts's
   * ListCommandOptions.roots. Production callers (the CLI action below)
   * never set this. */
  roots?: DiscoverAllOptions["roots"];
}

export async function runCostCommand(
  sessionArg: string | undefined,
  options: CostCommandOptions,
): Promise<void> {
  if (options.all) {
    const discoverOpts: DiscoverAllOptions = {};
    if (options.harness !== undefined) discoverOpts.harness = options.harness;
    if (options.cwd !== undefined) discoverOpts.cwd = options.cwd;
    if (options.since !== undefined) discoverOpts.since = options.since;
    if (options.roots !== undefined) discoverOpts.roots = options.roots;

    const refs = (await discoverAll(discoverOpts)).filter(
      (r) => r.kind === "main",
    );
    const entries: CostAllEntry[] = await Promise.all(
      refs.map(async (ref) => {
        const { rollup, family } = await buildFamilyForRef(ref);
        return { ref, rollup, family };
      }),
    );
    const report = buildCostAllReport(entries);
    if (options.json) {
      process.stdout.write(`${serializeJSON(report)}\n`);
      return;
    }
    printCostAllReport(report, options.by);
    return;
  }

  const resolveOpts: ResolveOptions = {};
  if (options.harness !== undefined) resolveOpts.harness = options.harness;
  if (options.cwd !== undefined) resolveOpts.cwd = options.cwd;
  const priced = await loadPricedSession(sessionArg, resolveOpts);
  const report = buildCostReport(priced);
  if (options.json) {
    process.stdout.write(`${serializeJSON(report)}\n`);
    return;
  }
  printCostReport(report, options.by);
}

// ---------------------------------------------------------------------------
// Command registration — the orchestrator wires this into cli.ts.
// ---------------------------------------------------------------------------

export function registerCostCommand(program: Command): void {
  program
    .command("cost [sessionIdOrPath]")
    .description(
      "Historical cost attribution: model/tool/MCP server/cache waste/miss-reason spikes. " +
        "With no argument, resolves to the most recently modified session.",
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
      "with --all, restrict to sessions modified on/after this date (YYYY-MM-DD or ISO)",
      parseSinceOption,
    )
    .option(
      "--all",
      "aggregate cost across every discovered main session (see the report's honesty note on family dedup)",
    )
    .option(
      "--by <dimension>",
      "restrict human-readable output to one attribution table: tool | mcp | model",
      parseByOption,
    )
    .option("--json", "emit the full computed structure as JSON")
    .action(
      async (
        sessionIdOrPath: string | undefined,
        opts: {
          harness?: HarnessId;
          cwd?: string;
          since?: Date;
          all?: boolean;
          json?: boolean;
          by?: CostByFilter;
        },
      ) => {
        try {
          const commandOpts: CostCommandOptions = {
            all: Boolean(opts.all),
            json: Boolean(opts.json),
          };
          if (opts.harness !== undefined) commandOpts.harness = opts.harness;
          if (opts.cwd !== undefined) commandOpts.cwd = opts.cwd;
          if (opts.since !== undefined) commandOpts.since = opts.since;
          if (opts.by !== undefined) commandOpts.by = opts.by;
          await runCostCommand(sessionIdOrPath, commandOpts);
        } catch (err) {
          process.stderr.write(
            `${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exitCode = 1;
        }
      },
    );
}
