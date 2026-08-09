// `peek report` (T5.2, extended v2 Lane E — docs/DESIGN.md § Other v2 subsystems
// "Report v2") — docs/DESIGN.md § "CLI surface": self-contained shareable
// HTML artifact.
//
// I/O half only. buildReportData is the PURE Session -> ReportData step
// (test/unit/report-command.test.ts exercises it directly against
// fixtures); render/html.ts's renderReportHtml does the actual string
// building and owns the sanitization boundary (see that file's header).
//
// Reuses rather than duplicates: commands/context.ts's resolveSession /
// loadProcessedSession / buildContextReport / buildTurnDetail for session
// resolution + the already-computed per-turn composition rows and
// span-level detail, and engine/accounting.ts + engine/attribution.ts's
// rollups for cost/tokens/model/tool/MCP-server totals.
//
// v2: `peek report --diff <a> <b>` reuses commands/diff.ts's
// loadDiffSession/buildDiffReport (SessionDiff -> DiffReport) and
// commands/shared.ts's resolveSessionRef wholesale — runReportDiffCommand
// below only adds render/html.ts's renderDiffHtml + output-file wiring.

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { priceSession, sessionTotals } from "../engine/accounting.js";
import { byMcpServer, byModel, byTool } from "../engine/attribution.js";
import { diffSessions } from "../engine/diff.js";
import { formatCost, shortenCwd } from "../model/format.js";
import type {
  CompactionEvent,
  HarnessId,
  Session,
  SessionRef,
} from "../model/types.js";
import type {
  DashboardData,
  DashboardModelSeries,
  DashboardPerHarnessRow,
  DashboardPerProjectRow,
  DashboardTokenClass,
  DashboardTokenSeries,
} from "../render/dashboardHtml.js";
import { renderDashboardHtml } from "../render/dashboardHtml.js";
import type {
  ReportCompactionRow,
  ReportCompositionTurn,
  ReportData,
  ReportMcpServerRow,
  ReportModelRow,
  ReportSpanRow,
  ReportToolRow,
} from "../render/html.js";
import { renderDiffHtml, renderReportHtml } from "../render/html.js";
import {
  RESIDUAL_LABEL,
  type ResolveOptions,
  buildContextReport,
  buildTurnDetail,
  loadProcessedSession,
  resolveSession,
} from "./context.js";
import { buildDiffReport, loadDiffSession } from "./diff.js";
import {
  type ListCommandOptions,
  type ListReportEntry,
  loadEntries,
} from "./list.js";
import { parseSinceOption, resolveSessionRef } from "./shared.js";

const HARNESS_IDS: readonly HarnessId[] = ["claude-code", "codex", "pi"];

function parseHarnessOption(value: string): HarnessId {
  if ((HARNESS_IDS as readonly string[]).includes(value)) {
    return value as HarnessId;
  }
  throw new Error(
    `--harness must be one of ${HARNESS_IDS.join(", ")} (got: ${value})`,
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers local to this command (report-specific presentation —
// render/table.ts's formatNumber/formatCompact are integer-token-oriented
// and reused as-is inside render/html.ts; formatCost is the canonical
// model/format.ts implementation, shared with dashboardHtml.ts).
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"; // em dash
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function isCompactionEvent(
  event: Session["events"][number],
): event is CompactionEvent {
  return event.kind === "compaction";
}

function exactOrUnknown(n: number | null): string {
  return n === null ? "unknown" : n.toLocaleString("en-US");
}

function estOrUnknown(n: number | null): string {
  return n === null ? "unknown" : `~${n.toLocaleString("en-US")}`;
}

// ---------------------------------------------------------------------------
// buildReportData — pure Session -> ReportData.
// ---------------------------------------------------------------------------

/** Window-chain summary for a codex CompactionEvent.lineage (see
 * model/types.ts) — undefined when the event carries no lineage (every
 * harness but codex, and codex's own legacy zero-field marker case). All
 * fields here are short identifiers (window numbers/ids), same class of
 * value as the tool names/model ids this file already writes through esc()
 * at the render layer — never session content. */
function buildLineageLabel(
  lineage: CompactionEvent["lineage"],
): string | undefined {
  if (!lineage) return undefined;
  const parts: string[] = [];
  if (lineage.windowNumber !== undefined) {
    parts.push(`window ${lineage.windowNumber}`);
  }
  if (
    lineage.previousWindowId !== undefined ||
    lineage.windowId !== undefined
  ) {
    parts.push(
      `${lineage.previousWindowId ?? "(none)"} → ${lineage.windowId ?? "unknown"}`,
    );
  }
  if (
    lineage.firstWindowId !== undefined &&
    lineage.firstWindowId !== lineage.windowId
  ) {
    parts.push(`root ${lineage.firstWindowId}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function buildCompactionRows(session: Session): ReportCompactionRow[] {
  return session.events.filter(isCompactionEvent).map((event, index) => {
    const row: ReportCompactionRow = {
      index,
      atISO: event.at.toISOString(),
      beforeTurnNumber: event.turnIndex + 1,
      tokensBeforeLabel: exactOrUnknown(event.tokensBeforeExact),
      tokensAfterLabel: exactOrUnknown(event.tokensAfterExact),
      shrinkLabel: exactOrUnknown(event.shrinkExact),
      discardedLabel: estOrUnknown(event.discardedEst),
    };
    const lineageLabel = buildLineageLabel(event.lineage);
    if (lineageLabel !== undefined) row.lineageLabel = lineageLabel;
    return row;
  });
}

function buildModelRows(session: Session): ReportModelRow[] {
  return byModel(session).map((m) => ({
    model: m.model,
    turnCount: m.turnCount,
    contextTotal: m.tokens.contextTotal,
    costLabel: m.priced ? formatCost(m.cost) : "unpriced",
  }));
}

function buildToolRows(session: Session): ReportToolRow[] {
  return byTool(session).map((t) => {
    const row: ReportToolRow = {
      name: t.toolName,
      totalSpanCount: t.totalSpanCount,
      tokenShareLabel: `~${t.tokenShareEst.toLocaleString("en-US")}`,
    };
    if (t.mcpServer !== undefined) row.mcpServer = t.mcpServer;
    return row;
  });
}

function buildMcpServerRows(session: Session): ReportMcpServerRow[] {
  return byMcpServer(session).map((s) => ({
    mcpServer: s.mcpServer,
    tools: s.tools,
    totalSpanCount: s.totalSpanCount,
    tokenShareLabel: `~${s.tokenShareEst.toLocaleString("en-US")}`,
  }));
}

/** category/toolName/mcpServer/~tokens/truncated ONLY — reuses
 * commands/context.ts's buildTurnDetail (the same `--turn n` span-expansion
 * logic `peek context` already uses) rather than re-deriving it; never a
 * span's `text` (see render/html.ts's ReportSpanRow doc). */
function buildSpanRows(session: Session, turnNumber: number): ReportSpanRow[] {
  const spans = buildTurnDetail(session, turnNumber) ?? [];
  return spans.map((span) => {
    const row: ReportSpanRow = {
      category: span.category,
      tokensLabel: span.tokensLabel,
      truncated: span.truncated,
    };
    if (span.toolName !== undefined) row.toolName = span.toolName;
    if (span.mcpServer !== undefined) row.mcpServer = span.mcpServer;
    return row;
  });
}

/**
 * Pure Session -> ReportData. `session` must already be deduped + composed
 * + finalized (loadProcessedSession's pipeline) AND priced (priceSession) —
 * same precondition accounting.ts/attribution.ts already document; this
 * function does not dedup/compose/price for you.
 */
export function buildReportData(
  session: Session,
  generatedAt: Date,
  peekVersion: string,
): ReportData {
  const totals = sessionTotals(session);
  const contextReport = buildContextReport(session);
  const compositionTurns: ReportCompositionTurn[] = contextReport.turns
    .filter((turn) => turn.contextTotal > 0)
    .map((turn) => {
      const row: ReportCompositionTurn = {
        turnNumber: turn.turnNumber,
        role: turn.role,
        model: turn.model,
        contextTotal: turn.contextTotal,
        categories: turn.categories,
        residual: turn.residual,
        spans: buildSpanRows(session, turn.turnNumber),
      };
      if (turn.truncatedLabel !== undefined) {
        row.truncatedLabel = turn.truncatedLabel;
      }
      return row;
    });

  const modelsUsed = [...new Set(session.turns.map((t) => t.model))].sort();
  const durationMs = session.endedAt.getTime() - session.startedAt.getTime();

  return {
    harness: session.harness,
    harnessVersion: session.harnessVersion,
    sessionId: session.id,
    cwd: session.cwd,
    models: modelsUsed.length > 0 ? modelsUsed : [session.configSnapshot.model],
    startedAtISO: session.startedAt.toISOString(),
    endedAtISO: session.endedAt.toISOString(),
    durationLabel: formatDuration(durationMs),
    headline: {
      costLabel: totals.priced ? formatCost(totals.cost) : "unpriced",
      costPriced: totals.priced,
      tokens: {
        inputUncached: totals.tokens.inputUncached,
        cacheRead: totals.tokens.cacheRead,
        cacheWrite: totals.tokens.cacheWrite5m + totals.tokens.cacheWrite1h,
        output: totals.tokens.output,
      },
      turnCount: session.turns.length,
      compactionCount: session.events.filter(isCompactionEvent).length,
    },
    compositionTurns,
    residualLabel: RESIDUAL_LABEL,
    compactions: buildCompactionRows(session),
    byModel: buildModelRows(session),
    byTool: buildToolRows(session),
    byMcpServer: buildMcpServerRows(session),
    generatedAtISO: generatedAt.toISOString(),
    peekVersion,
  };
}

// ---------------------------------------------------------------------------
// Command entry point — I/O.
// ---------------------------------------------------------------------------

export interface ReportCommandOptions {
  harness?: HarnessId;
  cwd?: string;
  output?: string;
  jsonEmbed?: boolean;
}

function readPeekVersion(): string {
  // Walk up from the module dir: in dev (tsx) this file lives at
  // src/commands/, in the built artifact everything is bundled into
  // dist/cli.js — a fixed "../.." is wrong in exactly one of the two
  // layouts (it crashed the built `peek report` outside the repo).
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === "peek-agent" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // keep walking
    }
    dir = path.dirname(dir);
  }
  return "unknown";
}

/** `raw` sanitized to a filesystem-safe short id (alnum/dash/underscore, up
 * to 8 chars); falls back to a timestamp when that yields nothing usable
 * (e.g. an empty or fully-symbolic session id). */
function shortId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 8);
  return cleaned.length > 0 ? cleaned : String(Date.now());
}

function defaultOutputPath(session: Session): string {
  return `peek-report-${shortId(session.id)}.html`;
}

function defaultDiffOutputPath(refA: SessionRef, refB: SessionRef): string {
  return `peek-diff-${shortId(refA.id)}-${shortId(refB.id)}.html`;
}

export async function runReportCommand(
  sessionIdOrPath: string | undefined,
  options: ReportCommandOptions,
): Promise<void> {
  const resolveOpts: ResolveOptions = {};
  if (options.harness !== undefined) resolveOpts.harness = options.harness;
  if (options.cwd !== undefined) resolveOpts.cwd = options.cwd;
  const ref = await resolveSession(sessionIdOrPath, resolveOpts);
  const { session } = await loadProcessedSession(ref);
  const priced = priceSession(session, { mode: "auto" });

  const data = buildReportData(priced, new Date(), readPeekVersion());
  const html = renderReportHtml(data, {
    jsonEmbed: Boolean(options.jsonEmbed),
  });

  const outputPath = options.output ?? defaultOutputPath(priced);
  await writeFile(outputPath, html, "utf8");
  process.stdout.write(`${path.resolve(outputPath)}\n`);
}

// ---------------------------------------------------------------------------
// `peek report --diff <a> <b>` — renders a SessionDiff as HTML. Reuses
// commands/diff.ts's loadDiffSession (the parse -> dedup -> composition ->
// compaction -> pricing pipeline diffSessions requires) and buildDiffReport
// (SessionDiff -> the same DiffReport `peek diff` itself prints/emits as
// JSON) rather than duplicating either; only the HTML rendering + output-
// file wiring is new here.
// ---------------------------------------------------------------------------

export interface ReportDiffCommandOptions {
  harness?: HarnessId;
  cwd?: string;
  output?: string;
  /** Discovery root overrides — test-only escape hatch, same shape as
   * commands/shared.ts's ResolveOptions.roots. */
  roots?: Partial<Record<HarnessId, string[]>>;
}

export async function runReportDiffCommand(
  a: string,
  b: string,
  options: ReportDiffCommandOptions,
): Promise<void> {
  const resolveOpts: ResolveOptions = {};
  if (options.harness !== undefined) resolveOpts.harness = options.harness;
  if (options.cwd !== undefined) resolveOpts.cwd = options.cwd;
  if (options.roots !== undefined) resolveOpts.roots = options.roots;

  const [refA, refB] = await Promise.all([
    resolveSessionRef(a, resolveOpts),
    resolveSessionRef(b, resolveOpts),
  ]);
  const [sessionA, sessionB] = await Promise.all([
    loadDiffSession(refA),
    loadDiffSession(refB),
  ]);
  const report = buildDiffReport(diffSessions(sessionA, sessionB));
  const html = renderDiffHtml(report, {
    peekVersion: readPeekVersion(),
    generatedAtISO: new Date().toISOString(),
  });

  const outputPath = options.output ?? defaultDiffOutputPath(refA, refB);
  await writeFile(outputPath, html, "utf8");
  process.stdout.write(`${path.resolve(outputPath)}\n`);
}

// ---------------------------------------------------------------------------
// `peek report --all` — cross-session trends dashboard (day-bucketed,
// cache-backed). buildDashboardData is the PURE step (ListReportEntry[] ->
// DashboardData, mirroring buildReportData's own pure-step pattern above);
// runReportAllCommand is the I/O half. Reuses commands/list.ts's loadEntries
// (the totals-cache-backed pipeline list.ts's runListCommand itself uses)
// rather than re-discovering/re-parsing — a ListReportEntry already carries
// every field this dashboard needs (totals/turns/compactions/startedAt/cwd/
// model/harness) without a fresh parse on a cache hit.
// ---------------------------------------------------------------------------

interface DashboardSessionRow {
  harness: HarnessId;
  cwd: string;
  model: string;
  startedAt: Date;
  cost: number;
  priced: boolean;
  tokensTotal: number;
  compactionCount: number;
  tokens: Record<DashboardTokenClass, number>;
}

/** Reads the fields this dashboard needs off a ListReportEntry — the same
 * fresh-parse-vs-cache-hit union commands/list.ts's buildListRow/
 * buildCachedListRow already branch on, since a cache hit never carries a
 * parsed Session. */
function extractDashboardSessionRow(
  entry: ListReportEntry,
): DashboardSessionRow {
  if ("session" in entry) {
    const totals = sessionTotals(entry.session);
    return {
      harness: entry.ref.harness,
      cwd: entry.session.cwd,
      model: entry.session.configSnapshot.model,
      startedAt: entry.session.startedAt,
      cost: totals.cost,
      priced: totals.priced,
      tokensTotal: totals.tokens.contextTotal,
      compactionCount: entry.session.events.filter(
        (e) => e.kind === "compaction",
      ).length,
      tokens: {
        inputUncached: totals.tokens.inputUncached,
        cacheRead: totals.tokens.cacheRead,
        cacheWrite: totals.tokens.cacheWrite5m + totals.tokens.cacheWrite1h,
        output: totals.tokens.output,
      },
    };
  }
  const row = entry.cached;
  return {
    harness: entry.ref.harness,
    cwd: row.cwd,
    model: row.model,
    startedAt: new Date(row.startedAt),
    cost: row.totals.cost,
    priced: row.totals.priced,
    tokensTotal: row.totals.tokens.contextTotal,
    compactionCount: row.compactions,
    tokens: {
      inputUncached: row.totals.tokens.inputUncached,
      cacheRead: row.totals.tokens.cacheRead,
      cacheWrite:
        row.totals.tokens.cacheWrite5m + row.totals.tokens.cacheWrite1h,
      output: row.totals.tokens.output,
    },
  };
}

function dayKeyUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const DASHBOARD_DAY_CAP = 30;
const DASHBOARD_TOP_MODELS = 5;
const DASHBOARD_TOP_PROJECTS = 15;
const DASHBOARD_TOKEN_CLASSES: readonly DashboardTokenClass[] = [
  "inputUncached",
  "cacheRead",
  "cacheWrite",
  "output",
];

export interface BuildDashboardFilters {
  since?: Date;
  harness?: HarnessId;
  cwd?: string;
}

/**
 * Pure ListReportEntry[] -> DashboardData. Buckets sessions by UTC day. The
 * day-bucketed charts (dailyCost/dailyTokens/cacheHitRate/compactionCounts)
 * are capped to the trailing DASHBOARD_DAY_CAP days when `filters.since`
 * wasn't given — an explicit --since widens the window to whatever range the
 * caller asked for (already applied upstream by loadEntries/discoverAll),
 * uncapped. Headline/perProject/perHarness summarize the FULL entry set
 * regardless of the chart window.
 */
export function buildDashboardData(
  entries: readonly ListReportEntry[],
  filters: BuildDashboardFilters,
  generatedAt: Date,
  peekVersion: string,
): DashboardData {
  const rows = entries.map(extractDashboardSessionRow);

  // ---- headline (full entry set) ----
  let totalCost = 0;
  let unpricedSessionCount = 0;
  const totalTokens: Record<DashboardTokenClass, number> = {
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  };
  const activeDaySet = new Set<string>();
  for (const r of rows) {
    totalCost += r.cost;
    if (!r.priced) unpricedSessionCount++;
    for (const tc of DASHBOARD_TOKEN_CLASSES) totalTokens[tc] += r.tokens[tc];
    activeDaySet.add(dayKeyUTC(r.startedAt));
  }

  // ---- day buckets (chart window) ----
  const allDays = [...activeDaySet].sort();
  const days = filters.since ? allDays : allDays.slice(-DASHBOARD_DAY_CAP);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const windowRows = rows.filter((r) => dayIndex.has(dayKeyUTC(r.startedAt)));

  // ---- dailyCost: top-N models by cost within the chart window + "other" ----
  const costByModel = new Map<string, number>();
  for (const r of windowRows) {
    costByModel.set(r.model, (costByModel.get(r.model) ?? 0) + r.cost);
  }
  const topModels = [...costByModel.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, DASHBOARD_TOP_MODELS)
    .map(([m]) => m);
  const topModelSet = new Set(topModels);
  const hasOther = [...costByModel.keys()].some((m) => !topModelSet.has(m));

  const modelSeriesNames = hasOther ? [...topModels, "other"] : topModels;
  const dailyCost: DashboardModelSeries[] = modelSeriesNames.map((model) => ({
    model,
    costsByDay: new Array<number>(days.length).fill(0),
  }));
  const dailyCostByModel = new Map(
    dailyCost.map((s) => [s.model, s.costsByDay]),
  );
  for (const r of windowRows) {
    const idx = dayIndex.get(dayKeyUTC(r.startedAt));
    if (idx === undefined) continue;
    const key = topModelSet.has(r.model) ? r.model : "other";
    const arr = dailyCostByModel.get(key);
    if (arr) arr[idx] = (arr[idx] ?? 0) + r.cost;
  }

  // ---- dailyTokens: fixed 4-class stack ----
  const dailyTokens: DashboardTokenSeries[] = DASHBOARD_TOKEN_CLASSES.map(
    (tokenClass) => ({
      tokenClass,
      valuesByDay: new Array<number>(days.length).fill(0),
    }),
  );
  const dailyTokensByClass = new Map(
    dailyTokens.map((s) => [s.tokenClass, s.valuesByDay]),
  );
  for (const r of windowRows) {
    const idx = dayIndex.get(dayKeyUTC(r.startedAt));
    if (idx === undefined) continue;
    for (const tc of DASHBOARD_TOKEN_CLASSES) {
      const arr = dailyTokensByClass.get(tc);
      if (arr) arr[idx] = (arr[idx] ?? 0) + r.tokens[tc];
    }
  }

  // ---- cache hit-rate trend ----
  const cacheReadByDay = new Array<number>(days.length).fill(0);
  const denomByDay = new Array<number>(days.length).fill(0);
  for (const r of windowRows) {
    const idx = dayIndex.get(dayKeyUTC(r.startedAt));
    if (idx === undefined) continue;
    cacheReadByDay[idx] = (cacheReadByDay[idx] ?? 0) + r.tokens.cacheRead;
    denomByDay[idx] =
      (denomByDay[idx] ?? 0) +
      r.tokens.cacheRead +
      r.tokens.inputUncached +
      r.tokens.cacheWrite;
  }
  const cacheHitRate: Array<number | null> = days.map((_, i) => {
    const denom = denomByDay[i] ?? 0;
    return denom > 0 ? (cacheReadByDay[i] ?? 0) / denom : null;
  });

  // ---- compaction frequency ----
  const compactionCounts = new Array<number>(days.length).fill(0);
  for (const r of windowRows) {
    const idx = dayIndex.get(dayKeyUTC(r.startedAt));
    if (idx === undefined) continue;
    compactionCounts[idx] = (compactionCounts[idx] ?? 0) + r.compactionCount;
  }

  // ---- per-project (full entry set, top 15 by cost) ----
  interface ProjectAgg {
    cwd: string;
    sessions: number;
    tokens: number;
    cost: number;
    lastActivity: Date;
  }
  const projectAggs = new Map<string, ProjectAgg>();
  for (const r of rows) {
    const agg = projectAggs.get(r.cwd) ?? {
      cwd: r.cwd,
      sessions: 0,
      tokens: 0,
      cost: 0,
      lastActivity: r.startedAt,
    };
    agg.sessions++;
    agg.tokens += r.tokensTotal;
    agg.cost += r.cost;
    if (r.startedAt > agg.lastActivity) agg.lastActivity = r.startedAt;
    projectAggs.set(r.cwd, agg);
  }
  const perProject: DashboardPerProjectRow[] = [...projectAggs.values()]
    .sort((a, b) => b.cost - a.cost)
    .slice(0, DASHBOARD_TOP_PROJECTS)
    .map((agg) => ({
      cwdLabel: shortenCwd(agg.cwd),
      sessions: agg.sessions,
      tokens: agg.tokens,
      costLabel: formatCost(agg.cost),
      lastActivityISO: agg.lastActivity.toISOString(),
    }));

  // ---- per-harness (full entry set) ----
  interface HarnessAgg {
    harness: HarnessId;
    sessions: number;
    tokens: number;
    cost: number;
    unpriced: number;
  }
  const harnessAggs = new Map<HarnessId, HarnessAgg>();
  for (const r of rows) {
    const agg = harnessAggs.get(r.harness) ?? {
      harness: r.harness,
      sessions: 0,
      tokens: 0,
      cost: 0,
      unpriced: 0,
    };
    agg.sessions++;
    agg.tokens += r.tokensTotal;
    agg.cost += r.cost;
    if (!r.priced) agg.unpriced++;
    harnessAggs.set(r.harness, agg);
  }
  const perHarness: DashboardPerHarnessRow[] = [...harnessAggs.values()]
    .sort((a, b) => b.cost - a.cost)
    .map((agg) => ({
      harness: agg.harness,
      sessions: agg.sessions,
      tokens: agg.tokens,
      costLabel: formatCost(agg.cost),
      unpricedSessionCount: agg.unpriced,
    }));

  const filtersOut: DashboardData["filters"] = {};
  if (filters.since !== undefined) {
    filtersOut.sinceISO = filters.since.toISOString();
  }
  if (filters.harness !== undefined) filtersOut.harness = filters.harness;
  if (filters.cwd !== undefined) filtersOut.cwd = filters.cwd;

  return {
    generatedAtISO: generatedAt.toISOString(),
    peekVersion,
    filters: filtersOut,
    headline: {
      totalCostLabel: formatCost(totalCost),
      unpricedSessionCount,
      totalSessions: rows.length,
      totalTokens,
      activeDays: activeDaySet.size,
    },
    days,
    dailyCost,
    dailyTokens,
    cacheHitRate,
    compactionCounts,
    perProject,
    perHarness,
  };
}

function defaultDashboardOutputPath(): string {
  return "peek-dashboard.html";
}

export interface ReportAllCommandOptions {
  harness?: HarnessId;
  cwd?: string;
  since?: Date;
  output?: string;
  /** discovery-root test escape hatch, same shape as commands/list.ts's
   * ListCommandOptions.roots. Production callers omit this. */
  roots?: ListCommandOptions["roots"];
}

export async function runReportAllCommand(
  options: ReportAllCommandOptions,
): Promise<void> {
  const listOpts: ListCommandOptions = {};
  if (options.harness !== undefined) listOpts.harness = options.harness;
  if (options.cwd !== undefined) listOpts.cwd = options.cwd;
  if (options.since !== undefined) listOpts.since = options.since;
  if (options.roots !== undefined) listOpts.roots = options.roots;

  const { entries } = await loadEntries(listOpts);

  const filters: BuildDashboardFilters = {};
  if (options.since !== undefined) filters.since = options.since;
  if (options.harness !== undefined) filters.harness = options.harness;
  if (options.cwd !== undefined) filters.cwd = options.cwd;

  const data = buildDashboardData(
    entries,
    filters,
    new Date(),
    readPeekVersion(),
  );
  const html = renderDashboardHtml(data);

  const outputPath = options.output ?? defaultDashboardOutputPath();
  await writeFile(outputPath, html, "utf8");
  process.stdout.write(`${path.resolve(outputPath)}\n`);
}

/** Registers `peek report` on an existing commander Program. Exported
 * separately from cli.ts's own wiring so this command can be tested/reused
 * without importing the whole CLI entry point. */
export function registerReportCommand(program: Command): void {
  program
    // Second positional (`diffB`) is only consumed when --diff is given —
    // `peek report --diff <a> <b> -o out.html` (commander has no single-
    // option way to bind two consecutive values to one flag; a boolean
    // --diff + two positionals is the documented shape, verified against
    // commander's actual parsing behavior for this exact invocation).
    .command("report [sessionIdOrPath] [diffB]")
    .description(
      "Generate a self-contained, shareable HTML report for a session " +
        "(inline CSS only, works offline). " +
        "`--diff <a> <b>` renders a SessionDiff (see `peek diff`) as HTML instead.",
    )
    .option(
      "--diff",
      "render a diff report: `peek report --diff <a> <b>` (sessionIdOrPath becomes <a>, diffB becomes <b>)",
    )
    .option(
      "--all",
      "render a cross-session trends dashboard across ALL discovered sessions instead of a single-session report (ignores [sessionIdOrPath]/[diffB])",
    )
    .option(
      "--since <date>",
      "with --all, restrict to sessions modified on/after this date (YYYY-MM-DD or ISO); widens the dashboard's day-bucket window past the default trailing 30 days",
      parseSinceOption,
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
      "-o, --output <path>",
      "output HTML file path (default: ./peek-report-<shortid>.html, ./peek-diff-<a>-<b>.html with --diff, or ./peek-dashboard.html with --all)",
    )
    .option(
      "--json-embed",
      'embed the full report data as JSON inside the HTML (non-executable <script type="application/json">) — ignored with --diff/--all',
    )
    .action(
      async (
        sessionIdOrPath: string | undefined,
        diffB: string | undefined,
        opts,
      ) => {
        try {
          if (opts.all) {
            const allOpts: ReportAllCommandOptions = {};
            if (opts.harness !== undefined) {
              allOpts.harness = opts.harness as HarnessId;
            }
            if (opts.cwd !== undefined) allOpts.cwd = opts.cwd as string;
            if (opts.since !== undefined) allOpts.since = opts.since as Date;
            if (opts.output !== undefined) {
              allOpts.output = opts.output as string;
            }
            await runReportAllCommand(allOpts);
            return;
          }

          if (opts.diff) {
            if (sessionIdOrPath === undefined || diffB === undefined) {
              throw new Error("--diff requires <a> <b>");
            }
            const diffOpts: ReportDiffCommandOptions = {};
            if (opts.harness !== undefined) {
              diffOpts.harness = opts.harness as HarnessId;
            }
            if (opts.cwd !== undefined) diffOpts.cwd = opts.cwd as string;
            if (opts.output !== undefined) {
              diffOpts.output = opts.output as string;
            }
            await runReportDiffCommand(sessionIdOrPath, diffB, diffOpts);
            return;
          }

          const commandOpts: ReportCommandOptions = {
            jsonEmbed: Boolean(opts.jsonEmbed),
          };
          if (opts.harness !== undefined) {
            commandOpts.harness = opts.harness as HarnessId;
          }
          if (opts.cwd !== undefined) commandOpts.cwd = opts.cwd as string;
          if (opts.output !== undefined) {
            commandOpts.output = opts.output as string;
          }
          await runReportCommand(sessionIdOrPath, commandOpts);
        } catch (err) {
          process.stderr.write(
            `${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exitCode = 1;
        }
      },
    );
}
