// Cross-command formatting — the single canonical formatCost/shortenCwd used
// by every renderer (moved here from commands/shared.ts / commands/report.ts
// so leaf render modules like render/dashboardHtml.ts, render/html.ts and
// command modules like commands/report.ts can import them without a
// commands/ -> commands/ or render/ -> commands/ cycle; commands/shared.ts
// re-exports formatCost for its existing importers).

import { homedir } from "node:os";

/** "1234.5" -> "$1,234.50". Sub-cent positive amounts (real but rounds to
 * "$0.00" at 2dp — misleadingly reads as free) get 4dp instead. */
export function formatCost(usd: number): string {
  const sign = usd < 0 ? "-" : "";
  const abs = Math.abs(usd);
  const decimals = abs > 0 && abs < 0.01 ? 4 : 2;
  return `${sign}$${abs.toFixed(decimals)}`;
}

const CWD_HOME = homedir();

/** "/Users/me/git/peek" -> "~/git/peek"; mid-truncates anything still over
 * `maxLen` after the home-swap to "<first>/…/<last two>" (e.g. a project two
 * directories deep under a long, non-home path). Originally
 * commands/report.ts's dashboard-only shortenCwdForDashboard — moved here so
 * render/html.ts's shareable single-session report can shorten its
 * Working-directory row the same way, instead of embedding the full path. */
export function shortenCwd(cwd: string, maxLen = 40): string {
  const withHome = cwd.startsWith(CWD_HOME)
    ? `~${cwd.slice(CWD_HOME.length)}`
    : cwd;
  if (withHome.length <= maxLen) return withHome;
  const parts = withHome.split("/");
  if (parts.length <= 3) return withHome;
  return `${parts[0]}/…/${parts.slice(-2).join("/")}`;
}
