// `peek report` (T5.2) — docs/DESIGN.md § "CLI surface": self-contained
// shareable HTML artifact. Pure string-building only: renderReportHtml takes
// a fully-computed ReportData and returns one HTML document. No I/O, no
// network, no external URLs (fonts/CDN/scripts) — the file must render
// correctly opened directly via file:// with the network disconnected.
//
// SANITIZATION BOUNDARY (enforced by construction, not by a filter): every
// string this module writes into the page comes from one of a fixed set of
// short, pre-aggregated fields — harness id, session id, cwd, model id,
// tool name, MCP server name, category name (a frozen enum), and numbers.
// ReportData intentionally has NO field carrying a Span's `text`, a raw
// message body, or any other free-form session content — see
// commands/report.ts's buildReportData, which builds this structure from
// commands/context.ts's already-aggregated report shapes (ContextTurnRow /
// ContextCategoryRow) and engine/attribution.ts's rollups, never from
// Session.turns[].contentSpans directly. Every string that IS written here
// still goes through escapeHtml — defense in depth for the short identifiers
// (cwd, tool names, model ids) that do originate in the session's own log
// data, even though they were never intended to carry arbitrary content.
//
// Category color mapping (dataviz skill's validated 8-hue categorical
// order, references/palette.md): CompositionCategory has 10 members, two
// more than the palette's validated adjacent-pairlist run of 8. The two
// rarest categories (compactionSummaries, coordination) reuse slot 1/2's
// hue with a diagonal hatch overlay rather than stepping outside the
// validated set — documented tradeoff, not an oversight.
//
// v2 additions (Lane E, docs/DESIGN.md § Other v2 subsystems "Report v2"):
//   - ReportCompositionTurn.spans: per-turn span-level rows (category/
//     toolName/mcpServer/~tokens/truncated ONLY — same sanitization
//     boundary as everything else in this file; Span.text never reaches
//     ReportSpanRow). Sourced from commands/context.ts's buildTurnDetail,
//     not re-derived here.
//   - ReportCompactionRow.lineageLabel: codex-only window-chain label
//     (CompactionEvent.lineage, model/types.ts) — undefined elsewhere.
//   - renderDiffHtml: a second entry point rendering `peek report --diff`'s
//     DiffReport (commands/diff.ts) with this file's shared CSS/esc()
//     boundary. DiffReport's own file header documents the same "labels +
//     raw values, honesty convention" sanitization posture as ReportData
//     above — no session content, only short identifiers/labels/numbers —
//     so importing its TYPE here (no runtime dependency; commands/diff.ts
//     does not import this module, so there is no cycle) does not weaken
//     the boundary this file enforces.

import type { DiffReport } from "../commands/diff.js";
import { shortenCwd } from "../model/format.js";
import type { CompositionCategory, HarnessId } from "../model/types.js";
import { formatNumber } from "./table.js";

// ---------------------------------------------------------------------------
// Report data contract — the ONLY input this module accepts. See file header.
// ---------------------------------------------------------------------------

export interface ReportCategorySegment {
  category: CompositionCategory;
  pct: number; // 0..1, share of turn.contextTotal
  tokens: number; // char/4 estimate
  tokensLabel: string; // "~"-prefixed
}

export interface ReportResidualSegment {
  label: string; // RESIDUAL_LABEL, verbatim
  pct: number;
  tokens: number; // exact
  tokensLabel: string; // unprefixed
}

/** One content span, aggregated down to display-safe fields only — no
 * `text`, mirroring commands/context.ts's ContextSpanRow minus its
 * tokensEst/turnRole (not needed by the report's per-turn table). */
export interface ReportSpanRow {
  category: CompositionCategory;
  mcpServer?: string;
  tokensLabel: string; // "~"-prefixed — spans are always char/4 estimates
  toolName?: string;
  truncated: boolean;
}

export interface ReportCompositionTurn {
  categories: ReportCategorySegment[];
  contextTotal: number; // exact
  model: string;
  residual: ReportResidualSegment;
  role: string;
  spans: ReportSpanRow[];
  truncatedLabel?: string;
  turnNumber: number;
}

export interface ReportCompactionRow {
  atISO: string;
  beforeTurnNumber: number;
  discardedLabel: string; // "~"-prefixed estimate, or "unknown"
  index: number;
  /** codex-only window-chain summary (CompactionEvent.lineage) — undefined
   * when the harness doesn't log window lineage. */
  lineageLabel?: string;
  shrinkLabel: string; // exact, or "unknown"
  tokensAfterLabel: string; // exact, or "unknown"
  tokensBeforeLabel: string; // exact, or "unknown"
}

export interface ReportModelRow {
  contextTotal: number; // exact
  costLabel: string; // exact dollar figure, or "unpriced"
  model: string;
  turnCount: number;
}

export interface ReportToolRow {
  mcpServer?: string;
  name: string;
  tokenShareLabel: string; // "~"-prefixed estimate
  totalSpanCount: number; // exact
}

export interface ReportMcpServerRow {
  mcpServer: string;
  tokenShareLabel: string; // "~"-prefixed estimate
  tools: string[];
  totalSpanCount: number; // exact
}

export interface ReportHeadline {
  compactionCount: number;
  costLabel: string; // exact dollar figure, or "unpriced"
  costPriced: boolean;
  tokens: {
    inputUncached: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
  };
  turnCount: number;
}

export interface ReportData {
  byMcpServer: ReportMcpServerRow[];
  byModel: ReportModelRow[];
  byTool: ReportToolRow[];
  compactions: ReportCompactionRow[];
  compositionTurns: ReportCompositionTurn[];
  cwd: string;
  durationLabel: string;
  endedAtISO: string;
  generatedAtISO: string;
  harness: HarnessId;
  harnessVersion: string;
  headline: ReportHeadline;
  models: string[];
  peekVersion: string;
  residualLabel: string;
  sessionId: string;
  startedAtISO: string;
}

export interface RenderReportOptions {
  /** Embeds the full ReportData as a non-executable
   * `<script type="application/json">` block — opt-in, off by default. */
  jsonEmbed?: boolean;
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
// Category → color mapping — fixed order, both themes (see file header).
// ---------------------------------------------------------------------------

interface CategoryColor {
  dark: string;
  hatch?: boolean;
  light: string;
}

const CATEGORY_COLORS: Record<CompositionCategory, CategoryColor> = {
  assistantText: { dark: "#d95926", light: "#eb6834" },
  compactionSummaries: { dark: "#3987e5", hatch: true, light: "#2a78d6" },
  coordination: { dark: "#d95926", hatch: true, light: "#eb6834" },
  instructionInjection: { dark: "#008300", light: "#008300" },
  systemPrompt: { dark: "#9085e9", light: "#4a3aa7" },
  thinking: { dark: "#199e70", light: "#1baf7a" },
  toolCallArgs: { dark: "#d55181", light: "#e87ba4" },
  toolResults: { dark: "#c98500", light: "#eda100" },
  toolSchemas: { dark: "#e66767", light: "#e34948" },
  userText: { dark: "#3987e5", light: "#2a78d6" },
};

// CompositionCategory's declared order (model/types.ts) — re-declared here
// for the same reason commands/context.ts re-declares it: not exported from
// engine/composition.ts, small and frozen per PLAN.
const COMPOSITION_CATEGORY_ORDER: readonly CompositionCategory[] = [
  "userText",
  "assistantText",
  "thinking",
  "toolResults",
  "toolCallArgs",
  "instructionInjection",
  "systemPrompt",
  "toolSchemas",
  "compactionSummaries",
  "coordination",
];

function categoryCssVar(category: CompositionCategory): string {
  return `var(--cat-${category})`;
}

// ---------------------------------------------------------------------------
// CSS — inline, no external fonts/URLs. Light palette default, dark via
// prefers-color-scheme (per task brief — this file has no theme toggle,
// it's a static artifact opened directly in a browser).
// ---------------------------------------------------------------------------

function buildCss(): string {
  const catVarsLight = COMPOSITION_CATEGORY_ORDER.map(
    (c) => `--cat-${c}: ${CATEGORY_COLORS[c].light};`
  ).join("\n      ");
  const catVarsDark = COMPOSITION_CATEGORY_ORDER.map(
    (c) => `--cat-${c}: ${CATEGORY_COLORS[c].dark};`
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
      ${catVarsLight}
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
        ${catVarsDark}
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
    h2 { font-size: 16px; margin: 0 0 12px; }
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
    dl.meta dd {
      margin: 0;
      overflow-wrap: anywhere;
      font-variant-numeric: tabular-nums;
    }
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
    .tile-value {
      font-size: 20px;
      font-weight: 600;
      margin-top: 2px;
      font-variant-numeric: tabular-nums;
    }
    .legend { display: flex; flex-wrap: wrap; gap: 10px 18px; margin-bottom: 14px; font-size: 13px; }
    .legend-item { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); }
    .swatch { width: 12px; height: 12px; border-radius: 3px; flex: none; }
    .swatch-residual {
      background-image: repeating-linear-gradient(
        45deg,
        var(--text-muted) 0,
        var(--text-muted) 2px,
        transparent 2px,
        transparent 5px
      );
      background-color: var(--surface-2);
      border: 1px solid var(--border);
    }
    .turn-row { margin-bottom: 14px; }
    .turn-head {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      color: var(--text-secondary);
      margin-bottom: 4px;
    }
    .turn-head .turn-total { font-variant-numeric: tabular-nums; color: var(--text-primary); }
    .bar {
      display: flex;
      height: 20px;
      width: 100%;
      border-radius: 4px;
      overflow: hidden;
      background: var(--gridline);
    }
    .segment {
      height: 100%;
      box-sizing: border-box;
      border-right: 2px solid var(--surface-2);
      min-width: 1px;
    }
    .segment:last-child { border-right: none; }
    .segment-residual {
      background-image: repeating-linear-gradient(
        45deg,
        var(--text-muted) 0,
        var(--text-muted) 3px,
        transparent 3px,
        transparent 7px
      );
      background-color: var(--surface-2);
    }
    details.breakdown, details.spans { margin-top: 4px; font-size: 12px; color: var(--text-secondary); }
    details.breakdown summary, details.spans summary { cursor: pointer; }
    details.breakdown ul { margin: 6px 0 0; padding-left: 18px; }
    details.breakdown li { font-variant-numeric: tabular-nums; }
    details.spans .table-wrap { margin-top: 6px; }
    .compaction-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .compaction-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 13px;
      flex: 1 1 260px;
    }
    .compaction-card .compaction-marker { font-weight: 600; margin-bottom: 4px; }
    .compaction-card .compaction-detail { font-variant-numeric: tabular-nums; }
    .compaction-card .compaction-lineage { margin-top: 4px; font-size: 12px; overflow-wrap: anywhere; }
    .compaction-card .compaction-time { color: var(--text-secondary); margin-top: 4px; font-size: 12px; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    thead th { text-align: left; color: var(--text-secondary); font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--gridline); }
    tbody td { padding: 6px 10px; border-bottom: 1px solid var(--gridline); font-variant-numeric: tabular-nums; }
    .table-wrap { overflow-x: auto; }
    .empty-note { color: var(--text-secondary); font-size: 13px; }
    .warning-banner {
      background: var(--warn-bg);
      border: 1px solid var(--warn-border);
      color: var(--warn-text);
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      margin-bottom: 24px;
    }
    .warning-banner .warning-title { font-weight: 600; margin-bottom: 4px; }
    .warning-banner ul { margin: 0; padding-left: 18px; }
    .diff-meta-columns { font-weight: 600; }
    .config-list { margin: 0; padding-left: 18px; font-size: 13px; }
    .config-list li { margin-bottom: 4px; }
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
// Section builders
// ---------------------------------------------------------------------------

function buildHeader(data: ReportData): string {
  return `
    <header>
      <h1>peek report</h1>
      <dl class="meta">
        <div><dt>Harness</dt><dd>${esc(data.harness)} (${esc(data.harnessVersion)})</dd></div>
        <div><dt>Session</dt><dd>${esc(data.sessionId)}</dd></div>
        <div><dt>Working directory</dt><dd>${esc(shortenCwd(data.cwd))}</dd></div>
        <div><dt>Model(s)</dt><dd>${esc(data.models.join(", "))}</dd></div>
        <div><dt>Started</dt><dd>${esc(data.startedAtISO)}</dd></div>
        <div><dt>Duration</dt><dd>${esc(data.durationLabel)}</dd></div>
      </dl>
    </header>
  `;
}

function buildStats(data: ReportData): string {
  const h = data.headline;
  const tiles: [string, string][] = [
    ["Total cost", esc(h.costLabel)],
    ["Input tokens", formatNumber(h.tokens.inputUncached)],
    ["Cache read", formatNumber(h.tokens.cacheRead)],
    ["Cache write", formatNumber(h.tokens.cacheWrite)],
    ["Output tokens", formatNumber(h.tokens.output)],
    ["Turns", formatNumber(h.turnCount)],
    ["Compactions", formatNumber(h.compactionCount)],
  ];
  const tileHtml = tiles
    .map(
      ([label, value]) => `
        <div class="tile">
          <div class="tile-label">${label}</div>
          <div class="tile-value">${value}</div>
        </div>`
    )
    .join("");
  return `
    <section class="stats">${tileHtml}
    </section>
  `;
}

function categoriesUsed(
  turns: readonly ReportCompositionTurn[]
): CompositionCategory[] {
  const seen = new Set<CompositionCategory>();
  for (const turn of turns) {
    for (const c of turn.categories) {
      seen.add(c.category);
    }
  }
  return COMPOSITION_CATEGORY_ORDER.filter((c) => seen.has(c));
}

function buildLegend(data: ReportData): string {
  const used = categoriesUsed(data.compositionTurns);
  const categoryItems = used
    .map(
      (c) => `
        <div class="legend-item">
          <span class="swatch" style="background:${categoryCssVar(c)}"></span>
          ${esc(c)}
        </div>`
    )
    .join("");
  const residualItem = `
    <div class="legend-item">
      <span class="swatch swatch-residual"></span>
      residual — ${esc(data.residualLabel)}
    </div>`;
  return `<div class="legend">${categoryItems}${residualItem}</div>`;
}

function buildSegment(segment: ReportCategorySegment): string {
  const widthPct = Math.max(0, Math.min(100, segment.pct * 100));
  const title = `${segment.category} ${segment.tokensLabel} (${(segment.pct * 100).toFixed(1)}%)`;
  return `<div class="segment" style="width:${widthPct.toFixed(3)}%;background:${categoryCssVar(segment.category)}" title="${esc(title)}"></div>`;
}

function buildResidualSegment(residual: ReportResidualSegment): string {
  const widthPct = Math.max(0, Math.min(100, residual.pct * 100));
  const title = `residual ${residual.tokensLabel} (${(residual.pct * 100).toFixed(1)}%) — ${residual.label}`;
  return `<div class="segment segment-residual" style="width:${widthPct.toFixed(3)}%" title="${esc(title)}"></div>`;
}

function buildTurnBreakdownList(turn: ReportCompositionTurn): string {
  const items = turn.categories.map(
    (c) =>
      `<li>${esc(c.category)}: ${esc(c.tokensLabel)} (${(c.pct * 100).toFixed(1)}%)</li>`
  );
  items.push(
    `<li>residual: ${esc(turn.residual.tokensLabel)} (${(turn.residual.pct * 100).toFixed(1)}%) — ${esc(turn.residual.label)}</li>`
  );
  return items.join("");
}

function buildSpanRow(span: ReportSpanRow): string {
  return `
    <tr>
      <td>${esc(span.category)}</td>
      <td>${span.toolName === undefined ? "—" : esc(span.toolName)}</td>
      <td>${span.mcpServer === undefined ? "—" : esc(span.mcpServer)}</td>
      <td>${esc(span.tokensLabel)}</td>
      <td>${span.truncated ? "yes" : "no"}</td>
    </tr>`;
}

/** category/toolName/mcpServer/~tokens/truncated ONLY — see file header's
 * sanitization boundary note. Never a span's `text`. */
function buildSpanTable(spans: readonly ReportSpanRow[]): string {
  if (spans.length === 0) {
    return `<p class="empty-note">No spans recorded.</p>`;
  }
  const body = spans.map(buildSpanRow).join("");
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Category</th><th>Tool</th><th>MCP server</th><th>Tokens (estimate)</th><th>Truncated</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function buildCompositionTurnRow(turn: ReportCompositionTurn): string {
  const segments = turn.categories.map(buildSegment).join("");
  const residualSegment = buildResidualSegment(turn.residual);
  const truncated = turn.truncatedLabel
    ? ` <span class="truncated-flag">${esc(turn.truncatedLabel)}</span>`
    : "";
  return `
    <div class="turn-row">
      <div class="turn-head">
        <span>Turn ${turn.turnNumber} · ${esc(turn.role)} · ${esc(turn.model)}${truncated}</span>
        <span class="turn-total">${formatNumber(turn.contextTotal)}</span>
      </div>
      <div class="bar" role="img" aria-label="Turn ${turn.turnNumber} context composition">${segments}${residualSegment}</div>
      <details class="breakdown">
        <summary>breakdown</summary>
        <ul>${buildTurnBreakdownList(turn)}</ul>
      </details>
      <details class="spans">
        <summary>spans (${formatNumber(turn.spans.length)})</summary>
        ${buildSpanTable(turn.spans)}
      </details>
    </div>
  `;
}

function buildComposition(data: ReportData): string {
  if (data.compositionTurns.length === 0) {
    return `
      <section>
        <h2>Context composition over time</h2>
        <p class="empty-note">No usage-carrying turns in this session.</p>
      </section>
    `;
  }
  const rows = data.compositionTurns.map(buildCompositionTurnRow).join("");
  return `
    <section>
      <h2>Context composition over time</h2>
      ${buildLegend(data)}
      ${rows}
    </section>
  `;
}

function buildCompactionCard(row: ReportCompactionRow): string {
  const lineageLine =
    row.lineageLabel === undefined
      ? ""
      : `<div class="compaction-lineage">chain: ${esc(row.lineageLabel)}</div>`;
  return `
    <div class="compaction-card">
      <div class="compaction-marker">Compaction #${row.index + 1} — before turn ${row.beforeTurnNumber}</div>
      <div class="compaction-detail">before ${esc(row.tokensBeforeLabel)} &rarr; after ${esc(row.tokensAfterLabel)} · shrink ${esc(row.shrinkLabel)} (exact) · discarded ${esc(row.discardedLabel)}</div>
      ${lineageLine}
      <div class="compaction-time">${esc(row.atISO)}</div>
    </div>
  `;
}

function buildCompactions(data: ReportData): string {
  if (data.compactions.length === 0) {
    return `
      <section>
        <h2>Compaction timeline</h2>
        <p class="empty-note">No compactions detected in this session.</p>
      </section>
    `;
  }
  const cards = data.compactions.map(buildCompactionCard).join("");
  return `
    <section>
      <h2>Compaction timeline</h2>
      <div class="compaction-strip">${cards}</div>
    </section>
  `;
}

function buildModelTable(rows: readonly ReportModelRow[]): string {
  if (rows.length === 0) {
    return `<p class="empty-note">No turns recorded.</p>`;
  }
  const body = rows
    .map(
      (r) => `
        <tr>
          <td>${esc(r.model)}</td>
          <td>${formatNumber(r.turnCount)}</td>
          <td>${formatNumber(r.contextTotal)}</td>
          <td>${esc(r.costLabel)}</td>
        </tr>`
    )
    .join("");
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Model</th><th>Turns</th><th>Context tokens (exact)</th><th>Cost</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function buildToolTable(rows: readonly ReportToolRow[]): string {
  if (rows.length === 0) {
    return `<p class="empty-note">No tool calls recorded.</p>`;
  }
  const body = rows
    .map(
      (r) => `
        <tr>
          <td>${esc(r.name)}${r.mcpServer ? ` <span class="mcp-tag">(${esc(r.mcpServer)})</span>` : ""}</td>
          <td>${formatNumber(r.totalSpanCount)}</td>
          <td>${esc(r.tokenShareLabel)}</td>
        </tr>`
    )
    .join("");
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Tool</th><th>Spans (exact)</th><th>Token share (estimate)</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function buildMcpServerTable(rows: readonly ReportMcpServerRow[]): string {
  if (rows.length === 0) {
    return `<p class="empty-note">No MCP server calls recorded.</p>`;
  }
  const body = rows
    .map(
      (r) => `
        <tr>
          <td>${esc(r.mcpServer)}</td>
          <td>${esc(r.tools.join(", "))}</td>
          <td>${formatNumber(r.totalSpanCount)}</td>
          <td>${esc(r.tokenShareLabel)}</td>
        </tr>`
    )
    .join("");
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>MCP server</th><th>Tools</th><th>Spans (exact)</th><th>Token share (estimate)</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function buildAttribution(data: ReportData): string {
  return `
    <section>
      <h2>Cost attribution — by model</h2>
      ${buildModelTable(data.byModel)}
    </section>
    <section>
      <h2>Cost attribution — by tool (token share, estimate)</h2>
      ${buildToolTable(data.byTool)}
    </section>
    <section>
      <h2>Cost attribution — by MCP server (token share, estimate)</h2>
      ${buildMcpServerTable(data.byMcpServer)}
    </section>
  `;
}

function buildFooter(data: ReportData): string {
  return `
    <footer>
      generated by peek-agent v${esc(data.peekVersion)} · local-only, zero telemetry<br>
      Generated ${esc(data.generatedAtISO)}
    </footer>
  `;
}

function buildJsonEmbed(
  data: ReportData,
  enabled: boolean | undefined
): string {
  if (!enabled) {
    return "";
  }
  // application/json — never executed as script by any browser, but a
  // field value containing a literal "</script>" (e.g. a session-log-
  // originated cwd) would still close this tag early and let anything
  // after it run as live HTML. Standard JSON-in-script escape: \u003c also
  // neutralizes "<!--"/"<script" sequences a parser could act on before
  // the closing tag. JSON.parse reverses it losslessly (it's just "<").
  return `<script type="application/json" id="peek-report-data">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Renders one self-contained HTML document for `peek report` — inline CSS
 * only, zero external URLs, works offline via file://, light/dark via
 * prefers-color-scheme. Pure: no I/O. See file header for the sanitization
 * boundary this function relies on ReportData already having enforced.
 */
export function renderReportHtml(
  data: ReportData,
  options: RenderReportOptions = {}
): string {
  const title = `peek report — ${esc(data.sessionId)}`;
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
${buildComposition(data)}
${buildCompactions(data)}
${buildAttribution(data)}
${buildFooter(data)}
</main>
${buildJsonEmbed(data, options.jsonEmbed)}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Diff report (`peek report --diff <a> <b>`) — DiffReport -> HTML.
//
// Reuses this file's palette/CSS (buildCss()) and esc() boundary; the input
// contract is commands/diff.ts's DiffReport (built by that module's own
// buildDiffReport, from an already-computed SessionDiff — see this file's
// header for why importing that TYPE here doesn't weaken the sanitization
// boundary). Mirrors `peek diff`'s own text output (printDiffReport) section
// for section, just as HTML.
// ---------------------------------------------------------------------------

function buildDiffWarnings(report: DiffReport): string {
  if (report.comparabilityWarnings.length === 0) {
    return "";
  }
  const items = report.comparabilityWarnings
    .map((w) => `<li>${esc(w)}</li>`)
    .join("");
  return `
    <div class="warning-banner">
      <div class="warning-title">⚠ these sessions diverge strongly on:</div>
      <ul>${items}</ul>
    </div>
  `;
}

function buildDiffMetaTable(report: DiffReport): string {
  const { a, b } = report.meta;
  const rows: [string, string, string][] = [
    ["id", a.id, b.id],
    ["harness", a.harness, b.harness],
    ["version", a.harnessVersion, b.harnessVersion],
    ["model", a.modelLabel, b.modelLabel],
    ["turns", formatNumber(a.turns), formatNumber(b.turns)],
    ["duration", a.durationLabel, b.durationLabel],
  ];
  const body = rows
    .map(
      ([field, av, bv]) => `
        <tr><td>${esc(field ?? "")}</td><td>${esc(av ?? "")}</td><td>${esc(bv ?? "")}</td></tr>`
    )
    .join("");
  return `
    <section>
      <h2>Sessions</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>field</th><th class="diff-meta-columns">a</th><th class="diff-meta-columns">b</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>
  `;
}

function buildDiffTotalsTable(report: DiffReport): string {
  const body = report.totals
    .map(
      (r) => `
        <tr>
          <td>${esc(r.tokenClassLabel)}</td>
          <td>${esc(r.aLabel)}</td>
          <td>${esc(r.bLabel)}</td>
          <td>${esc(r.deltaLabel)}</td>
          <td>${esc(r.pctLabel)}</td>
        </tr>`
    )
    .join("");
  return `
    <section>
      <h2>Totals</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>class</th><th>a</th><th>b</th><th>Δ</th><th>%</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>
  `;
}

function buildDiffCost(report: DiffReport): string {
  const c = report.cost;
  const line = c.bothPriced
    ? `${esc(c.aLabel)} → ${esc(c.bLabel)} &nbsp; Δ ${esc(c.deltaLabel)} (${esc(c.pctLabel)})`
    : `<span class="empty-note">— (one or both sessions have unpriced turns)</span>`;
  return `
    <section>
      <h2>Cost</h2>
      <p>${line}</p>
    </section>
  `;
}

function buildDiffComposition(report: DiffReport): string {
  const rows = [...report.composition, report.residual];
  const body = rows
    .map(
      (r) => `
        <tr>
          <td>${esc(r.categoryLabel)}</td>
          <td>${esc(r.aLabel)}</td>
          <td>${esc(r.bLabel)}</td>
          <td>${esc(r.deltaLabel)}</td>
        </tr>`
    )
    .join("");
  return `
    <section>
      <h2>Composition (final turn)</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>category</th><th>a</th><th>b</th><th>Δ</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <p class="empty-note">${esc(report.residual.label ?? "")}</p>
    </section>
  `;
}

function buildDiffCompactions(report: DiffReport): string {
  const c = report.compactions;
  return `
    <section>
      <h2>Compactions</h2>
      <p>a: ${formatNumber(c.countA)} compaction(s), shrink ${esc(c.shrinkTotalLabelA)}, discarded ${esc(c.discardedEstLabelA)}</p>
      <p>b: ${formatNumber(c.countB)} compaction(s), shrink ${esc(c.shrinkTotalLabelB)}, discarded ${esc(c.discardedEstLabelB)}</p>
    </section>
  `;
}

function buildDiffConfig(report: DiffReport): string {
  const items = report.config.map((line) => `<li>${esc(line)}</li>`).join("");
  return `
    <section>
      <h2>Config</h2>
      <ul class="config-list">${items}</ul>
    </section>
  `;
}

function buildDiffFooter(peekVersion: string, generatedAtISO: string): string {
  return `
    <footer>
      generated by peek-agent v${esc(peekVersion)} · local-only, zero telemetry<br>
      Generated ${esc(generatedAtISO)}
    </footer>
  `;
}

export interface RenderDiffReportOptions {
  generatedAtISO?: string;
  peekVersion?: string;
}

/**
 * Renders one self-contained HTML document for `peek report --diff <a> <b>`
 * — same zero-JS/inline-CSS/no-external-URL contract as renderReportHtml,
 * sharing its palette/CSS. Pure: no I/O.
 */
export function renderDiffHtml(
  report: DiffReport,
  options: RenderDiffReportOptions = {}
): string {
  const title = `peek diff — ${esc(report.meta.a.id)} vs ${esc(report.meta.b.id)}`;
  const peekVersion = options.peekVersion ?? "unknown";
  const generatedAtISO = options.generatedAtISO ?? new Date().toISOString();
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
<header>
  <h1>peek diff</h1>
</header>
${buildDiffWarnings(report)}
${buildDiffMetaTable(report)}
${buildDiffTotalsTable(report)}
${buildDiffCost(report)}
${buildDiffComposition(report)}
${buildDiffCompactions(report)}
${buildDiffConfig(report)}
${buildDiffFooter(peekVersion, generatedAtISO)}
</main>
</body>
</html>
`;
}
