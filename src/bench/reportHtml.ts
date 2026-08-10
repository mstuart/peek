// biome-ignore-all lint/style/useFilenamingConvention: Preserve the existing public module path.
// `peek bench report -o <file>.html` (A4 deliverable #4) — a NEW,
// self-contained module following render/html.ts's conventions (documented
// there): pure string-building, zero JS, inline CSS only, no external URLs
// (fonts/CDN/scripts) — must render correctly opened directly via file://
// with the network disconnected, light/dark via prefers-color-scheme.
//
// SANITIZATION BOUNDARY: every string this module writes comes from
// compare.ts's CompareTable — task names (BenchTask.name, a short
// identifier from the suite file, same class of value as a model id or tool
// name elsewhere in the codebase), config names (directory basenames or
// "current"), and already-computed numeric labels. There is no field here
// carrying a BenchTask's `prompt`, a runner's `raw` result, or any other
// free-form agent/session content — CompareTable's own fields (compare.ts)
// never carry that either. Every string is still routed through esc() as
// defense in depth, same posture as render/html.ts.

import type { CompareCell, CompareDeltaRow, CompareTable } from "./compare.js";

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
// CSS — inline, no external fonts/URLs. Mirrors render/html.ts's token
// names/values so a bench report and a session report feel like the same
// tool, without importing that module (keeps this file's dependency surface
// to just compare.ts, per its own file header).
// ---------------------------------------------------------------------------

function buildCss(): string {
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
      --pos: #1baf7a;
      --neg: #e34948;
      --warn-bg: #fdf6e3;
      --warn-border: #e0b93d;
      --warn-text: #6b5410;
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
        --pos: #199e70;
        --neg: #e66767;
        --warn-bg: #332a0d;
        --warn-border: #8a6d1a;
        --warn-text: #f0d878;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--surface-2);
      color: var(--text-primary);
      font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    main { max-width: 1080px; margin: 0 auto; padding: 24px 20px 64px; }
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
    dl.meta dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
    }
    .tile { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
    .tile-label { font-size: 12px; color: var(--text-secondary); }
    .tile-value { font-size: 18px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    thead th { text-align: left; color: var(--text-secondary); font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--gridline); }
    tbody td { padding: 6px 10px; border-bottom: 1px solid var(--gridline); font-variant-numeric: tabular-nums; }
    .table-wrap { overflow-x: auto; }
    .empty-note { color: var(--text-secondary); font-size: 13px; }
    .delta-pos { color: var(--pos); }
    .delta-neg { color: var(--neg); }
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
// Section builders.
// ---------------------------------------------------------------------------

/** Wraps a delta label in a color class when it starts with "+"/"-" — purely
 * cosmetic (green/red), never changes the text content. */
function deltaSpan(label: string): string {
  let cls = "";
  if (label.startsWith("+")) {
    cls = "delta-pos";
  } else if (label.startsWith("-")) {
    cls = "delta-neg";
  }
  return cls ? `<span class="${cls}">${esc(label)}</span>` : esc(label);
}

function buildHeader(table: CompareTable, meta: BenchReportMeta): string {
  return `
    <header>
      <h1>peek bench report</h1>
      <dl class="meta">
        <div><dt>Harness</dt><dd>${esc(meta.harness)}</dd></div>
        <div><dt>Config A</dt><dd>${esc(table.configA)}</dd></div>
        <div><dt>Config B</dt><dd>${esc(table.configB)}</dd></div>
        <div><dt>Generated</dt><dd>${esc(meta.generatedAtISO)}</dd></div>
      </dl>
    </header>
  `;
}

function buildOverallStats(table: CompareTable): string {
  if (!table.overall) {
    return `
      <section>
        <h2>Overall</h2>
        <p class="empty-note">Not enough data — at least one of the two configs has zero trials.</p>
      </section>
    `;
  }
  const { a, b, delta } = table.overall;
  const tiles: [string, string, string][] = [
    ["Success rate", esc(a.successRateLabel), esc(b.successRateLabel)],
    ["Median wall", esc(a.medianWallLabel), esc(b.medianWallLabel)],
    ["Median tokens", esc(a.medianTokensLabel), esc(b.medianTokensLabel)],
    ["Median cost", esc(a.medianCostLabel), esc(b.medianCostLabel)],
    [
      "Compactions (sum)",
      esc(a.compactionTotalLabel),
      esc(b.compactionTotalLabel),
    ],
  ];
  const tileHtml = tiles
    .map(
      ([label, av, bv]) => `
        <div class="tile">
          <div class="tile-label">${label}</div>
          <div class="tile-value">${av} &rarr; ${bv}</div>
        </div>`
    )
    .join("");
  return `
    <section>
      <h2>Overall (${a.trialCount + b.trialCount} trials across ${table.deltas.length + table.missing.length} task(s))</h2>
      <div class="stats">${tileHtml}</div>
      <p class="empty-note">
        success ${deltaSpan(delta.successDeltaLabel)} &middot;
        wall ${deltaSpan(delta.wallDeltaLabel)} &middot;
        tokens ${deltaSpan(delta.tokensDeltaLabel)} &middot;
        cost ${deltaSpan(delta.costDeltaLabel)} &middot;
        compactions ${deltaSpan(delta.compactionDeltaLabel)}
      </p>
    </section>
  `;
}

function buildMissingWarning(table: CompareTable): string {
  if (table.missing.length === 0) {
    return "";
  }
  const items = table.missing
    .map(
      (m) =>
        `<li>${esc(m.taskName)} — no trials for config ${m.missingConfig === "a" ? esc(table.configA) : esc(table.configB)}</li>`
    )
    .join("");
  return `
    <div class="warning-banner">
      <div class="warning-title">&#9888; tasks missing from one side of the comparison</div>
      <ul>${items}</ul>
    </div>
  `;
}

function buildDeltaTable(table: CompareTable): string {
  if (table.deltas.length === 0) {
    return `<p class="empty-note">No task ran under both configs.</p>`;
  }
  const body = table.deltas
    .map(
      (d: CompareDeltaRow) => `
        <tr>
          <td>${esc(d.taskName)}</td>
          <td>${esc(d.a.successRateLabel)}</td>
          <td>${esc(d.b.successRateLabel)}</td>
          <td>${deltaSpan(d.successDeltaLabel)}</td>
          <td>${esc(d.a.medianWallLabel)}</td>
          <td>${esc(d.b.medianWallLabel)}</td>
          <td>${deltaSpan(d.wallDeltaLabel)}</td>
          <td>${esc(d.a.medianTokensLabel)}</td>
          <td>${esc(d.b.medianTokensLabel)}</td>
          <td>${deltaSpan(d.tokensDeltaLabel)}</td>
          <td>${esc(d.a.medianCostLabel)}</td>
          <td>${esc(d.b.medianCostLabel)}</td>
          <td>${deltaSpan(d.costDeltaLabel)}</td>
          <td>${esc(d.a.compactionTotalLabel)}</td>
          <td>${esc(d.b.compactionTotalLabel)}</td>
          <td>${deltaSpan(d.compactionDeltaLabel)}</td>
        </tr>`
    )
    .join("");
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Success A</th><th>Success B</th><th>&Delta;</th>
            <th>Wall A</th><th>Wall B</th><th>&Delta;</th>
            <th>Tokens A</th><th>Tokens B</th><th>&Delta;</th>
            <th>Cost A</th><th>Cost B</th><th>&Delta;</th>
            <th>Compactions A</th><th>Compactions B</th><th>&Delta;</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function buildCellsTable(cells: readonly CompareCell[]): string {
  if (cells.length === 0) {
    return `<p class="empty-note">No trials recorded.</p>`;
  }
  const body = cells
    .map(
      (c) => `
        <tr>
          <td>${esc(c.taskName)}</td>
          <td>${esc(c.configName)}</td>
          <td>${esc(c.successRateLabel)}</td>
          <td>${esc(c.medianWallLabel)}</td>
          <td>${esc(c.medianTokensLabel)}</td>
          <td>${esc(c.medianCostLabel)}</td>
          <td>${esc(c.compactionTotalLabel)}</td>
        </tr>`
    )
    .join("");
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Task</th><th>Config</th><th>Success</th><th>Median wall</th><th>Median tokens</th><th>Median cost</th><th>Compactions</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function buildFooter(peekVersion: string, generatedAtISO: string): string {
  return `
    <footer>
      generated by peek-agent v${esc(peekVersion)} &middot; local-only, zero telemetry<br>
      Generated ${esc(generatedAtISO)}
    </footer>
  `;
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export interface BenchReportMeta {
  generatedAtISO: string;
  harness: string;
  peekVersion: string;
}

/**
 * Renders one self-contained HTML document for `peek bench report` — inline
 * CSS only, zero external URLs, works offline via file://, light/dark via
 * prefers-color-scheme. Pure: no I/O.
 */
export function renderBenchReportHtml(
  table: CompareTable,
  meta: BenchReportMeta
): string {
  const title = `peek bench report — ${esc(table.configA)} vs ${esc(table.configB)}`;
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
${buildHeader(table, meta)}
${buildMissingWarning(table)}
${buildOverallStats(table)}
<section>
  <h2>Per-task comparison (A: ${esc(table.configA)} &middot; B: ${esc(table.configB)})</h2>
  ${buildDeltaTable(table)}
</section>
<section>
  <h2>All cells (every config name seen, including any outside A/B)</h2>
  ${buildCellsTable(table.cells)}
</section>
${buildFooter(meta.peekVersion, meta.generatedAtISO)}
</main>
</body>
</html>
`;
}
