// biome-ignore-all lint/style/useFilenamingConvention: Preserve the existing public module path.
// `peek report --all` — cross-session trends dashboard. Same zero-JS,
// inline-CSS, no-external-URL contract as render/html.ts (this file's
// sibling for the single-session report): a self-contained HTML document
// that renders correctly opened directly via file:// with the network
// disconnected. Kept as a SEPARATE module rather than an extension of
// html.ts — that file is untouched by this task to avoid merge conflicts
// with other in-flight work on it, so this file re-declares the small pieces
// it needs (esc(), the CSS custom-property scaffolding, the categorical
// color hues) rather than importing html.ts's module-private constants.
//
// SANITIZATION BOUNDARY: same posture as html.ts's header. DashboardData's
// only string fields are pre-aggregated short identifiers (harness id, model
// id, a shortened cwd label) or already-formatted number/dollar labels built
// by commands/report.ts's buildDashboardData — never session content. Every
// string is still escaped via esc() before being written, as defense in
// depth for the identifiers that do originate in a session's own log data
// (model id, cwd).
//
// SVG charts: fixed viewBox + `max-width: 100%` on the <svg> (CSS, not a
// chart library) makes them responsive; every bar/segment/point carries a
// <title> tooltip with the exact value. No estimate-flavored values appear
// on this dashboard (cache-cache totals are exact, sourced from usage
// fields via cache/totals.ts) — sections are labeled "(exact)" rather than
// using html.ts's hatch-pattern estimate convention, since there is nothing
// here to hatch.

import { formatCost } from "../model/format.js";
import type { HarnessId } from "../model/types.js";
import { formatCompact, formatNumber } from "./table.js";

// ---------------------------------------------------------------------------
// Data contract — the ONLY input this module accepts. Built by
// commands/report.ts's buildDashboardData (pure ListReportEntry[] ->
// DashboardData).
// ---------------------------------------------------------------------------

export interface DashboardFilters {
  cwd?: string;
  harness?: HarnessId;
  sinceISO?: string;
}

export interface DashboardHeadline {
  activeDays: number;
  totalCostLabel: string; // exact dollar figure summed over priced sessions
  totalSessions: number;
  totalTokens: {
    inputUncached: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
  };
  unpricedSessionCount: number; // honesty note — these contribute $0 above
}

/** One stacked-bar series for the daily-cost chart: a specific model, or the
 * aggregated "other" tail bucket (see buildDashboardData for the top-5+other
 * split). */
export interface DashboardModelSeries {
  costsByDay: number[]; // aligned to DashboardData.days, exact dollars
  model: string;
}

export type DashboardTokenClass =
  | "inputUncached"
  | "cacheRead"
  | "cacheWrite"
  | "output";

export interface DashboardTokenSeries {
  tokenClass: DashboardTokenClass;
  valuesByDay: number[]; // aligned to DashboardData.days, exact tokens
}

export interface DashboardPerProjectRow {
  costLabel: string; // exact
  cwdLabel: string;
  lastActivityISO: string;
  sessions: number;
  tokens: number; // exact
}

export interface DashboardPerHarnessRow {
  costLabel: string; // exact
  harness: HarnessId;
  sessions: number;
  tokens: number; // exact
  unpricedSessionCount: number;
}

export interface DashboardData {
  /** cacheRead / (cacheRead + inputUncached + cacheWrite) per day, aligned
   * to `days`. null on a day with no denominator (no tokens logged). */
  cacheHitRate: (number | null)[];
  compactionCounts: number[]; // aligned to `days`
  dailyCost: DashboardModelSeries[];
  dailyTokens: DashboardTokenSeries[];
  /** UTC day buckets, "YYYY-MM-DD", ascending — shared x-axis for
   * dailyCost/dailyTokens/cacheHitRate/compactionCounts below. Capped to the
   * trailing 30 days unless filters.sinceISO widens it (buildDashboardData's
   * job); headline/perProject/perHarness are NOT limited to this window. */
  days: string[];
  filters: DashboardFilters;
  generatedAtISO: string;
  headline: DashboardHeadline;
  peekVersion: string;
  perHarness: DashboardPerHarnessRow[]; // pre-sorted by cost desc
  perProject: DashboardPerProjectRow[]; // top 15 by cost, pre-sorted
}

// ---------------------------------------------------------------------------
// Escaping — every dynamic string funnels through this.
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  "'": "&#39;",
  '"': "&quot;",
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

// ---------------------------------------------------------------------------
// Categorical color palette — the same 8 validated hues render/html.ts's
// CATEGORY_COLORS uses (re-declared here since that map is module-private
// there; see file header). --series-0..7 cover up to 5 top models + a
// dedicated --series-other gray for the aggregated tail bucket.
// ---------------------------------------------------------------------------

const SERIES_HUES: ReadonlyArray<{ light: string; dark: string }> = [
  { dark: "#3987e5", light: "#2a78d6" }, // blue
  { dark: "#d95926", light: "#eb6834" }, // orange
  { dark: "#199e70", light: "#1baf7a" }, // green
  { dark: "#c98500", light: "#eda100" }, // amber
  { dark: "#d55181", light: "#e87ba4" }, // pink
  { dark: "#9085e9", light: "#4a3aa7" }, // purple
  { dark: "#e66767", light: "#e34948" }, // red
  { dark: "#008300", light: "#008300" }, // dark green
];

function seriesColorVar(index: number): string {
  return `var(--series-${index % SERIES_HUES.length})`;
}

const TOKEN_CLASS_LABELS: Record<DashboardTokenClass, string> = {
  cacheRead: "cache read",
  cacheWrite: "cache write",
  inputUncached: "input (uncached)",
  output: "output",
};

// inputUncached/cacheRead/cacheWrite/output map onto fixed hues so the same
// class always reads the same color across the dashboard.
const TOKEN_CLASS_COLOR_INDEX: Record<DashboardTokenClass, number> = {
  cacheRead: 2, // green — the cache-dominance story gets the "efficient" hue
  cacheWrite: 3, // amber
  inputUncached: 0, // blue
  output: 1, // orange
};

// ---------------------------------------------------------------------------
// CSS — inline, no external fonts/URLs. Same token names as html.ts for
// visual consistency across peek's HTML artifacts (duplicated, not shared —
// see file header).
// ---------------------------------------------------------------------------

function buildCss(): string {
  const seriesVarsLight = SERIES_HUES.map(
    (h, i) => `--series-${i}: ${h.light};`
  ).join("\n      ");
  const seriesVarsDark = SERIES_HUES.map(
    (h, i) => `--series-${i}: ${h.dark};`
  ).join("\n      ");

  return `
    :root {
      color-scheme: light;
      --surface: #fcfcfb;
      --surface-2: #f9f9f7;
      --text-primary: #0b0b0b;
      --text-secondary: #52514e;
      --text-muted: #898781;
      --gridline: #e1e0d9;
      --border: rgba(11, 11, 11, 0.12);
      --warn-bg: #fdf6e3;
      --warn-border: #e0b93d;
      --warn-text: #6b5410;
      --series-other: #898781;
      ${seriesVarsLight}
    }
    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --surface: #1a1a19;
        --surface-2: #0d0d0d;
        --text-primary: #ffffff;
        --text-secondary: #c3c2b7;
        --text-muted: #898781;
        --gridline: #2c2c2a;
        --border: rgba(255, 255, 255, 0.12);
        --warn-bg: #332a0d;
        --warn-border: #8a6d1a;
        --warn-text: #f0d878;
        --series-other: #898781;
        ${seriesVarsDark}
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--surface-2);
      color: var(--text-primary);
      font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    main {
      max-width: 960px;
      margin: 0 auto;
      padding: 24px 20px 64px;
    }
    h1, h2 { font-weight: 600; letter-spacing: -0.01em; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    h2 { font-size: 16px; margin: 0 0 4px; }
    .section-note { font-size: 12px; color: var(--text-muted); margin: 0 0 12px; }
    section { margin-top: 36px; }
    dl.meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 8px 24px;
      margin: 16px 0 0;
      padding: 0;
    }
    dl.meta > div { display: flex; gap: 6px; min-width: 0; }
    dl.meta dt { color: var(--text-secondary); flex: none; }
    dl.meta dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
    }
    .tile {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
    }
    .tile-label { font-size: 12px; color: var(--text-secondary); }
    .tile-value { font-size: 20px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
    .tile-note { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
    .warning-banner {
      background: var(--warn-bg);
      border: 1px solid var(--warn-border);
      color: var(--warn-text);
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      margin-bottom: 24px;
    }
    .legend { display: flex; flex-wrap: wrap; gap: 10px 18px; margin: 10px 0 14px; font-size: 13px; }
    .legend-item { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); }
    .swatch { width: 12px; height: 12px; border-radius: 3px; flex: none; }
    .chart-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
    svg.chart { display: block; width: 100%; height: auto; max-width: 100%; }
    .axis-label { font-size: 10px; fill: var(--text-secondary); font-variant-numeric: tabular-nums; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    thead th { text-align: left; color: var(--text-secondary); font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--gridline); }
    tbody td { padding: 6px 10px; border-bottom: 1px solid var(--gridline); font-variant-numeric: tabular-nums; }
    .table-wrap { overflow-x: auto; }
    .empty-note { color: var(--text-secondary); font-size: 13px; }
    footer {
      margin-top: 48px;
      padding-top: 16px;
      border-top: 1px solid var(--gridline);
      color: var(--text-secondary);
      font-size: 12px;
    }
  `;
}

// ---------------------------------------------------------------------------
// Chart primitives — fixed viewBox, no chart library. Every bar/segment/
// point gets a <title> tooltip.
// ---------------------------------------------------------------------------

const CHART_PAD = { bottom: 26, left: 60, right: 12, top: 14 };

function niceMax(value: number): number {
  return value > 0 ? value * 1.08 : 1;
}

/** Picks x-axis tick indices so at most `maxTicks` labels are drawn — dense
 * day axes (up to 30+ buckets) would overlap illegibly if every day were
 * labeled. */
function xTickIndices(count: number, maxTicks = 8): number[] {
  if (count <= maxTicks) {
    return Array.from({ length: count }, (_, i) => i);
  }
  const step = Math.ceil(count / maxTicks);
  const idxs: number[] = [];
  for (let i = 0; i < count; i += step) {
    idxs.push(i);
  }
  const last = count - 1;
  if (idxs.at(-1) !== last) {
    idxs.push(last);
  }
  return idxs;
}

interface StackedSeriesInput {
  colorVar: string;
  label: string;
  values: number[];
}

function buildStackedBarSvg(params: {
  days: readonly string[];
  series: readonly StackedSeriesInput[];
  formatValue: (v: number) => string;
  ariaLabel: string;
  width?: number;
  height?: number;
}): string {
  const width = params.width ?? 800;
  const height = params.height ?? 280;
  const { left, right, top, bottom } = CHART_PAD;
  const chartW = width - left - right;
  const chartH = height - top - bottom;
  const { days } = params;
  const n = days.length;

  if (n === 0) {
    return `<p class="empty-note">No data in the selected window.</p>`;
  }

  const totals = days.map((_, i) =>
    params.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)
  );
  const yMax = niceMax(Math.max(0, ...totals));

  const slotW = chartW / n;
  const barGap = Math.min(slotW * 0.25, 6);
  const barW = Math.max(1, slotW - barGap);

  const gridLines: string[] = [];
  const yLabels: string[] = [];
  for (let g = 0; g <= 4; g += 1) {
    const frac = g / 4;
    const y = top + chartH * (1 - frac);
    gridLines.push(
      `<line x1="${left}" y1="${y.toFixed(1)}" x2="${(left + chartW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--gridline)" stroke-width="1"/>`
    );
    yLabels.push(
      `<text x="${(left - 6).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" class="axis-label">${esc(params.formatValue(yMax * frac))}</text>`
    );
  }

  const xLabels = xTickIndices(n).map((i) => {
    const x = left + i * slotW + barW / 2;
    return `<text x="${x.toFixed(1)}" y="${(height - bottom + 16).toFixed(1)}" text-anchor="middle" class="axis-label">${esc(days[i] ?? "")}</text>`;
  });

  const bars: string[] = [];
  for (let i = 0; i < n; i += 1) {
    let cumulative = 0;
    const x = left + i * slotW + barGap / 2;
    for (const s of params.series) {
      const v = s.values[i] ?? 0;
      if (v <= 0) {
        continue;
      }
      const segH = (v / yMax) * chartH;
      const y = top + chartH - cumulative - segH;
      const title = `${esc(days[i] ?? "")} · ${esc(s.label)}: ${esc(params.formatValue(v))} (exact)`;
      bars.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${segH.toFixed(1)}" fill="${s.colorVar}"><title>${title}</title></rect>`
      );
      cumulative += segH;
    }
  }

  return `
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(params.ariaLabel)}" preserveAspectRatio="xMinYMin meet">
      ${gridLines.join("")}
      ${yLabels.join("")}
      ${bars.join("")}
      ${xLabels.join("")}
    </svg>
  `;
}

function buildLineChartSvg(params: {
  days: readonly string[];
  values: ReadonlyArray<number | null>;
  ariaLabel: string;
  width?: number;
  height?: number;
}): string {
  const width = params.width ?? 800;
  const height = params.height ?? 160;
  const { left, right, top, bottom } = CHART_PAD;
  const chartW = width - left - right;
  const chartH = height - top - bottom;
  const n = params.days.length;

  if (n === 0) {
    return `<p class="empty-note">No data in the selected window.</p>`;
  }

  const slotW = n > 1 ? chartW / (n - 1) : 0;

  const gridLines: string[] = [];
  const yLabels: string[] = [];
  for (let g = 0; g <= 4; g += 1) {
    const frac = g / 4;
    const y = top + chartH * (1 - frac);
    gridLines.push(
      `<line x1="${left}" y1="${y.toFixed(1)}" x2="${(left + chartW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--gridline)" stroke-width="1"/>`
    );
    yLabels.push(
      `<text x="${(left - 6).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" class="axis-label">${Math.round(frac * 100)}%</text>`
    );
  }

  const xLabels = xTickIndices(n).map((i) => {
    const x = left + i * slotW;
    return `<text x="${x.toFixed(1)}" y="${(height - bottom + 16).toFixed(1)}" text-anchor="middle" class="axis-label">${esc(params.days[i] ?? "")}</text>`;
  });

  const points = params.values.map((v, i) => {
    if (v === null) {
      return null;
    }
    const x = left + i * slotW;
    const y = top + chartH * (1 - Math.max(0, Math.min(1, v)));
    return { v, x, y };
  });

  const segments: string[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a && b) {
      segments.push(
        `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${seriesColorVar(2)}" stroke-width="2"/>`
      );
    }
  }
  const dots = points
    .map((p, i) => {
      if (!p) {
        return "";
      }
      const title = `${esc(params.days[i] ?? "")}: ${(p.v * 100).toFixed(1)}% (exact)`;
      return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${seriesColorVar(2)}"><title>${title}</title></circle>`;
    })
    .join("");

  return `
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(params.ariaLabel)}" preserveAspectRatio="xMinYMin meet">
      ${gridLines.join("")}
      ${yLabels.join("")}
      ${segments.join("")}
      ${dots}
      ${xLabels.join("")}
    </svg>
  `;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildHeader(data: DashboardData): string {
  const f = data.filters;
  const filterParts: string[] = [];
  if (f.sinceISO) {
    filterParts.push(`since ${esc(f.sinceISO.slice(0, 10))}`);
  }
  if (f.harness) {
    filterParts.push(`harness ${esc(f.harness)}`);
  }
  if (f.cwd) {
    filterParts.push(`cwd ${esc(f.cwd)}`);
  }
  const filterLine =
    filterParts.length > 0
      ? `<div><dt>Filters</dt><dd>${filterParts.join(", ")}</dd></div>`
      : "";
  return `
    <header>
      <h1>peek dashboard — cross-session trends</h1>
      <dl class="meta">
        <div><dt>Generated</dt><dd>${esc(data.generatedAtISO)}</dd></div>
        <div><dt>Sessions</dt><dd>${formatNumber(data.headline.totalSessions)}</dd></div>
        ${filterLine}
      </dl>
    </header>
  `;
}

function buildStats(data: DashboardData): string {
  const h = data.headline;
  const tiles: [string, string, string | undefined][] = [
    [
      "Total cost",
      esc(h.totalCostLabel),
      h.unpricedSessionCount > 0
        ? `${formatNumber(h.unpricedSessionCount)} session${h.unpricedSessionCount === 1 ? "" : "s"} unpriced`
        : undefined,
    ],
    ["Sessions", formatNumber(h.totalSessions), undefined],
    ["Input tokens", formatCompact(h.totalTokens.inputUncached), undefined],
    ["Cache read", formatCompact(h.totalTokens.cacheRead), undefined],
    ["Cache write", formatCompact(h.totalTokens.cacheWrite), undefined],
    ["Output tokens", formatCompact(h.totalTokens.output), undefined],
    ["Active days", formatNumber(h.activeDays), undefined],
  ];
  const tileHtml = tiles
    .map(
      ([label, value, note]) => `
        <div class="tile">
          <div class="tile-label">${label}</div>
          <div class="tile-value">${value}</div>
          ${note ? `<div class="tile-note">${note}</div>` : ""}
        </div>`
    )
    .join("");
  return `<section class="stats">${tileHtml}</section>`;
}

function buildDailyCost(data: DashboardData): string {
  const series = data.dailyCost;
  const legend = series
    .map((s, i) => {
      const colorVar =
        s.model === "other" ? "var(--series-other)" : seriesColorVar(i);
      return `
        <div class="legend-item">
          <span class="swatch" style="background:${colorVar}"></span>
          ${esc(s.model)}
        </div>`;
    })
    .join("");
  const chart = buildStackedBarSvg({
    ariaLabel: "Daily cost by model",
    days: data.days,
    formatValue: (v) => formatCost(v),
    series: series.map((s, i) => ({
      colorVar: s.model === "other" ? "var(--series-other)" : seriesColorVar(i),
      label: s.model,
      values: s.costsByDay,
    })),
  });
  return `
    <section>
      <h2>Daily cost by model</h2>
      <p class="section-note">exact — top ${Math.min(5, series.filter((s) => s.model !== "other").length)} models by cost${series.some((s) => s.model === "other") ? ", remaining models grouped as “other”" : ""}</p>
      ${series.length > 0 ? `<div class="legend">${legend}</div>` : ""}
      <div class="chart-wrap">${chart}</div>
    </section>
  `;
}

function buildDailyTokens(data: DashboardData): string {
  const series = data.dailyTokens;
  const legend = series
    .map(
      (s) => `
        <div class="legend-item">
          <span class="swatch" style="background:${seriesColorVar(TOKEN_CLASS_COLOR_INDEX[s.tokenClass])}"></span>
          ${esc(TOKEN_CLASS_LABELS[s.tokenClass])}
        </div>`
    )
    .join("");
  const chart = buildStackedBarSvg({
    ariaLabel: "Daily tokens by class",
    days: data.days,
    formatValue: (v) => formatCompact(v),
    series: series.map((s) => ({
      colorVar: seriesColorVar(TOKEN_CLASS_COLOR_INDEX[s.tokenClass]),
      label: TOKEN_CLASS_LABELS[s.tokenClass],
      values: s.valuesByDay,
    })),
  });
  return `
    <section>
      <h2>Daily tokens by class</h2>
      <p class="section-note">exact — from usage fields, cache-dominance at a glance</p>
      <div class="legend">${legend}</div>
      <div class="chart-wrap">${chart}</div>
    </section>
  `;
}

function buildCacheHitRate(data: DashboardData): string {
  const chart = buildLineChartSvg({
    ariaLabel: "Cache hit-rate trend",
    days: data.days,
    values: data.cacheHitRate,
  });
  return `
    <section>
      <h2>Cache hit-rate trend</h2>
      <p class="section-note">exact — cacheRead / (cacheRead + inputUncached + cacheWrite) per day</p>
      <div class="chart-wrap">${chart}</div>
    </section>
  `;
}

function buildCompactionFrequency(data: DashboardData): string {
  const chart = buildStackedBarSvg({
    ariaLabel: "Compaction frequency",
    days: data.days,
    formatValue: (v) => formatNumber(v),
    series: [
      {
        colorVar: seriesColorVar(6),
        label: "compactions",
        values: data.compactionCounts,
      },
    ],
  });
  return `
    <section>
      <h2>Compaction frequency</h2>
      <p class="section-note">exact — compaction events per day</p>
      <div class="chart-wrap">${chart}</div>
    </section>
  `;
}

function buildPerProjectTable(data: DashboardData): string {
  if (data.perProject.length === 0) {
    return `
      <section>
        <h2>Per-project totals</h2>
        <p class="empty-note">No sessions found.</p>
      </section>
    `;
  }
  const body = data.perProject
    .map(
      (r) => `
        <tr>
          <td>${esc(r.cwdLabel)}</td>
          <td>${formatNumber(r.sessions)}</td>
          <td>${formatCompact(r.tokens)}</td>
          <td>${esc(r.costLabel)}</td>
          <td>${esc(r.lastActivityISO.slice(0, 10))}</td>
        </tr>`
    )
    .join("");
  return `
    <section>
      <h2>Per-project totals</h2>
      <p class="section-note">top ${data.perProject.length} by cost (exact)</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>cwd</th><th>Sessions</th><th>Tokens</th><th>Cost</th><th>Last activity</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>
  `;
}

function buildPerHarnessTable(data: DashboardData): string {
  if (data.perHarness.length === 0) {
    return `
      <section>
        <h2>Per-harness totals</h2>
        <p class="empty-note">No sessions found.</p>
      </section>
    `;
  }
  const body = data.perHarness
    .map(
      (r) => `
        <tr>
          <td>${esc(r.harness)}</td>
          <td>${formatNumber(r.sessions)}</td>
          <td>${formatCompact(r.tokens)}</td>
          <td>${esc(r.costLabel)}</td>
          <td>${r.unpricedSessionCount > 0 ? `${formatNumber(r.unpricedSessionCount)} unpriced` : "—"}</td>
        </tr>`
    )
    .join("");
  return `
    <section>
      <h2>Per-harness totals</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Harness</th><th>Sessions</th><th>Tokens</th><th>Cost</th><th>Honesty note</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>
  `;
}

function buildFooter(data: DashboardData): string {
  return `
    <footer>
      generated by peek-agent v${esc(data.peekVersion)} · local-only, zero telemetry<br>
      Generated ${esc(data.generatedAtISO)}
    </footer>
  `;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Renders one self-contained HTML document for `peek report --all` — inline
 * CSS only, zero external URLs, works offline via file://, light/dark via
 * prefers-color-scheme. Pure: no I/O.
 */
export function renderDashboardHtml(data: DashboardData): string {
  const title = "peek dashboard — cross-session trends";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${buildCss()}</style>
</head>
<body>
<main>
${buildHeader(data)}
${buildStats(data)}
${buildDailyCost(data)}
${buildDailyTokens(data)}
${buildCacheHitRate(data)}
${buildCompactionFrequency(data)}
${buildPerProjectTable(data)}
${buildPerHarnessTable(data)}
${buildFooter(data)}
</main>
</body>
</html>
`;
}
