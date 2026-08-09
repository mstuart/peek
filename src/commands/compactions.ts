// `peek compactions` (T3.1) — docs/DESIGN.md § "CLI surface": "timeline:
// shrinkExact (headline), discardedEst (labeled), per-compaction cost".
//
// Pipeline (commands/shared.ts's file header): parse -> dedupSession ->
// finalizeCompactions. No pricing needed for the report itself (a
// CompactionEvent only ever carries a cost when an adapter attached one at
// parse time — currently pi only, via its own display-cost math — see
// engine/accounting.ts's priceSession doc comment); no composition needed.

import type { Command } from "commander";
import { finalizeCompactions } from "../engine/compaction.js";
import type {
  CompactionEvent,
  HarnessId,
  Session,
  SessionEvent,
} from "../model/types.js";
import { serializeJSON } from "../render/json.js";
import { formatNumber, renderTable } from "../render/table.js";
import {
  type ResolveOptions,
  formatCost,
  formatTimestamp,
  loadSession,
  parseHarnessOption,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Report structure — pure, JSON-serializable.
// ---------------------------------------------------------------------------

export interface CompactionRow {
  turnNumber: number; // event.turnIndex + 1 — 1-indexed, matches commands/context.ts's convention
  whenLabel: string;
  beforeLabel: string; // exact, or "unknown" when the anchor search found nothing
  afterLabel: string;
  shrinkLabel: string; // exact (before - after) — the headline number per PLAN
  discardedLabel: string; // "~"-prefixed estimate (labeled per PLAN), or "unknown"
  summarySizeLabel: string; // "~"-prefixed estimate, always known (adapters always set summaryTokensEst)
  costLabel: string; // "—" when the adapter attached no cost, or attached one that's unpriced
}

export interface CompactionsReport {
  harness: HarnessId;
  sessionId: string;
  cwd: string;
  rows: CompactionRow[];
}

function isCompactionEvent(event: SessionEvent): event is CompactionEvent {
  return event.kind === "compaction";
}

function exactOrUnknown(value: number | null): string {
  return value === null ? "unknown" : formatNumber(value);
}

function estOrUnknown(value: number | null): string {
  return value === null ? "unknown" : `~${formatNumber(value)}`;
}

function buildCompactionRow(event: CompactionEvent): CompactionRow {
  return {
    turnNumber: event.turnIndex + 1,
    whenLabel: formatTimestamp(event.at),
    beforeLabel: exactOrUnknown(event.tokensBeforeExact),
    afterLabel: exactOrUnknown(event.tokensAfterExact),
    shrinkLabel: exactOrUnknown(event.shrinkExact),
    discardedLabel: estOrUnknown(event.discardedEst),
    summarySizeLabel: `~${formatNumber(event.summaryTokensEst)}`,
    costLabel: event.cost?.priced ? formatCost(event.cost.total) : "—",
  };
}

/**
 * Builds the compaction timeline for an already deduped+finalized session
 * (see loadFinalizedSession). Pure; does no I/O.
 */
export function buildCompactionsReport(session: Session): CompactionsReport {
  const rows = session.events
    .filter(isCompactionEvent)
    .map(buildCompactionRow)
    .sort((a, b) => a.turnNumber - b.turnNumber);

  return {
    harness: session.harness,
    sessionId: session.id,
    cwd: session.cwd,
    rows,
  };
}

// ---------------------------------------------------------------------------
// I/O — discovery, parse, stdout.
// ---------------------------------------------------------------------------

/** parse -> dedupSession -> finalizeCompactions for `peek compactions <sess>`. */
export async function loadFinalizedSession(
  idOrPath: string | undefined,
  opts: ResolveOptions = {},
): Promise<Session> {
  const { session } = await loadSession(idOrPath, opts);
  return finalizeCompactions(session);
}

function printCompactionsReport(report: CompactionsReport): void {
  process.stdout.write(
    `peek compactions — ${report.harness} · ${report.sessionId} · ${report.cwd}\n\n`,
  );

  if (report.rows.length === 0) {
    process.stdout.write("no compactions recorded in this session\n");
    return;
  }

  const rows = report.rows.map((r) => [
    formatNumber(r.turnNumber),
    r.whenLabel,
    r.beforeLabel,
    r.afterLabel,
    r.shrinkLabel,
    r.discardedLabel,
    r.summarySizeLabel,
    r.costLabel,
  ]);
  const table = renderTable(
    [
      { header: "turn", align: "right" },
      { header: "when" },
      { header: "before", align: "right" },
      { header: "after", align: "right" },
      { header: "shrink", align: "right" },
      { header: "~discarded", align: "right" },
      { header: "~summary", align: "right" },
      { header: "cost", align: "right" },
    ],
    rows,
  );
  process.stdout.write(`${table}\n`);
}

export interface CompactionsCommandOptions {
  harness?: HarnessId;
  cwd?: string;
  json?: boolean;
}

export async function runCompactionsCommand(
  sessionArg: string | undefined,
  options: CompactionsCommandOptions,
): Promise<void> {
  const resolveOpts: ResolveOptions = {};
  if (options.harness !== undefined) resolveOpts.harness = options.harness;
  if (options.cwd !== undefined) resolveOpts.cwd = options.cwd;
  const session = await loadFinalizedSession(sessionArg, resolveOpts);
  const report = buildCompactionsReport(session);
  if (options.json) {
    process.stdout.write(`${serializeJSON(report)}\n`);
    return;
  }
  printCompactionsReport(report);
}

// ---------------------------------------------------------------------------
// Command registration — the orchestrator wires this into cli.ts.
// ---------------------------------------------------------------------------

export function registerCompactionsCommand(program: Command): void {
  program
    .command("compactions [sessionIdOrPath]")
    .description(
      "Compaction timeline: exact shrink (before - after), labeled discardedEst, per-compaction cost. " +
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
    .option("--json", "emit the full computed structure as JSON")
    .action(
      async (
        sessionIdOrPath: string | undefined,
        opts: { harness?: HarnessId; cwd?: string; json?: boolean },
      ) => {
        try {
          const commandOpts: CompactionsCommandOptions = {
            json: Boolean(opts.json),
          };
          if (opts.harness !== undefined) commandOpts.harness = opts.harness;
          if (opts.cwd !== undefined) commandOpts.cwd = opts.cwd;
          await runCompactionsCommand(sessionIdOrPath, commandOpts);
        } catch (err) {
          process.stderr.write(
            `${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exitCode = 1;
        }
      },
    );
}
