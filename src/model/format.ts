// Cross-command dollar formatting — the single canonical formatCost used by
// every renderer (moved here from commands/shared.ts so leaf render modules
// like render/dashboardHtml.ts and command modules like commands/report.ts
// can import it without a commands/ -> commands/ or render/ -> commands/
// cycle; commands/shared.ts re-exports this for its existing importers).

/** "1234.5" -> "$1,234.50". Sub-cent positive amounts (real but rounds to
 * "$0.00" at 2dp — misleadingly reads as free) get 4dp instead. */
export function formatCost(usd: number): string {
  const sign = usd < 0 ? "-" : "";
  const abs = Math.abs(usd);
  const decimals = abs > 0 && abs < 0.01 ? 4 : 2;
  return `${sign}$${abs.toFixed(decimals)}`;
}
