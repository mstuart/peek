// Shared table-rendering primitives (T3.1 + T3.2) — minimal, column-aligned,
// no external table library (per task constraint: "picocolors, no deps
// beyond it"). Every command that prints tabular or bar-chart output goes
// through this module so formatting stays consistent across `peek context`,
// `peek cost`, `peek list`, etc.

import pc from "picocolors";

/** "12345" -> "12,345". Negative numbers keep their sign before the digits. */
export function formatNumber(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(Math.round(value));
  return sign + abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Compact human form for large token counts: 37481 -> "37.5k", 1234567 ->
 * "1.2M". Values under 1000 render as plain digits (no decimal, no suffix)
 * since a "0.8k" reads worse than "823" at that scale. Always one decimal
 * place in the k/M ranges, sign preserved for negative values (residuals can
 * be negative per the composition invariant).
 */
export function formatCompact(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs < 1000) {
    return sign + Math.round(abs).toString();
  }
  if (abs < 1_000_000) {
    return `${sign}${(abs / 1000).toFixed(1)}k`;
  }
  return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
}

const BAR_FILLED = "█";
const BAR_EMPTY = "░";
const DEFAULT_BAR_WIDTH = 8;

/**
 * Fixed-width percentage bar, e.g. "████░░░░ 42%". `share` is a 0..1
 * fraction (Composition.residualShare's own units); values outside [0, 1]
 * are clamped for the BAR ITSELF (a negative or >100% residual share can't
 * be drawn as filled blocks) but the printed percentage text is never
 * clamped — an over-estimation shows as e.g. "-12%" rather than being
 * silently hidden, per the honesty convention this module exists to serve.
 */
export function renderBar(share: number, width = DEFAULT_BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(1, share));
  const filled = Math.round(clamped * width);
  const bar = BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(width - filled);
  const pct = Math.round(share * 100);
  return `${bar} ${pct}%`;
}

export type ColumnAlign = "left" | "right";

export interface TableColumn {
  align?: ColumnAlign; // default "left"
  header: string;
}

/**
 * Minimal column-aligned table. `rows[i][j]` must already be the final
 * display string for that cell (this function does no number formatting —
 * callers use formatNumber/formatCompact/renderBar first). Numeric columns
 * are right-aligned by passing `align: "right"` on that column.
 */
export function renderTable(
  columns: readonly TableColumn[],
  rows: readonly string[][]
): string {
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...rows.map((row) => (row[i] ?? "").length))
  );

  const padCell = (text: string, width: number, align: ColumnAlign): string =>
    align === "right" ? text.padStart(width) : text.padEnd(width);

  const headerLine = columns
    .map((col, i) =>
      pc.bold(padCell(col.header, widths[i] ?? 0, col.align ?? "left"))
    )
    .join("  ");

  const bodyLines = rows.map((row) =>
    columns
      .map((col, i) =>
        padCell(row[i] ?? "", widths[i] ?? 0, col.align ?? "left")
      )
      .join("  ")
  );

  return [headerLine, ...bodyLines].join("\n");
}

/** Dim, full-width-ish separator line for section breaks (e.g. compaction
 * boundaries) inside otherwise tabular output. Not column-aware — callers
 * that need it aligned to a specific table width pass that width in. */
export function renderSeparator(label: string): string {
  return pc.dim(`── ${label} ──`);
}
