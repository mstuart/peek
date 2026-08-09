// `peek context` (T3.2) — docs/DESIGN.md § "CLI surface (v1)": historical
// per-turn composition, residual honestly labeled.
//
// Two halves, deliberately separated for testability (standing worker rule
// "keep printing separated from report-building"):
//   - buildContextReport / buildTurnDetail: PURE, Session -> report structure.
//     No I/O. This is what test/unit/context-command.test.ts snapshots.
//   - resolveSession / runContextCommand: I/O (discovery, parse, stdout).
//
// Pipeline: parse -> dedupSession -> computeComposition -> finalizeCompactions.
// dedupSession (NOT bare dedupTurns) is required: it remaps CompactionEvent.turnIndex
// through the dedup index map so composition phase-resets land on the right turns
// (engine review finding 1, 2026-08-08). engine/compaction.ts (T2.4) already exists — wired in
// directly rather than skipped.

import pc from "picocolors";
import { parseClaudeSession } from "../adapters/claude/parse.js";
import { parseCodexSession } from "../adapters/codex/parse.js";
import { parsePiSession } from "../adapters/pi/parse.js";
import { finalizeCompactions } from "../engine/compaction.js";
import { computeComposition } from "../engine/composition.js";
import { dedupSession } from "../engine/dedup.js";
import type {
  CompactionEvent,
  Composition,
  CompositionCategory,
  HarnessId,
  ParseResult,
  ParseWarning,
  Session,
  SessionRef,
  Turn,
  TurnRole,
} from "../model/types.js";
import { serializeJSON } from "../render/json.js";
import {
  formatNumber,
  renderBar,
  renderSeparator,
  renderTable,
} from "../render/table.js";
import { resolveSessionRef } from "./shared.js";

// ---------------------------------------------------------------------------
// Report structure — pure, JSON-serializable, consumed by both text and
// --json rendering.
// ---------------------------------------------------------------------------

/** Verbatim per docs/DESIGN.md § "Accounting rules" rule 5. */
export const RESIDUAL_LABEL =
  "system prompt + tool schemas + framing (not logged by this harness)";

const TRUNCATED_LABEL = "(lower bound — truncated sources)";

// CompositionCategory's declared order (model/types.ts) — not exported from
// engine/composition.ts, so re-declared here (small, frozen union per PLAN;
// same list composition.ts keeps privately).
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

export interface ContextCategoryRow {
  category: CompositionCategory;
  tokens: number; // char/4 estimate
  tokensLabel: string; // "~"-prefixed — the honesty convention
  pct: number; // share of contextTotal, 0..1 (not clamped)
}

export interface ContextResidualRow {
  tokens: number;
  tokensLabel: string; // unprefixed: exact total minus Σ estimates, not itself a char/4 read
  pct: number;
  label: string; // RESIDUAL_LABEL, verbatim
}

export interface ContextTurnRow {
  turnNumber: number; // 1-indexed, for display and the --turn flag
  turnIndex: number; // 0-indexed position in session.turns (internal)
  role: TurnRole;
  model: string;
  contextTotal: number; // exact, from usage fields — never char/4
  categories: ContextCategoryRow[]; // only non-zero categories, declaration order
  residual: ContextResidualRow;
  truncatedLabel?: string;
}

export interface ContextCompactionSeparatorRow {
  beforeTurnNumber: number; // separator prints immediately before this turn
  shrinkExact: number | null;
  label: string;
}

export interface ContextSpanRow {
  category: CompositionCategory;
  toolName?: string;
  mcpServer?: string;
  tokensEst: number;
  tokensLabel: string; // always "~"-prefixed — spans are always char/4 estimates
  truncated: boolean;
  turnRole: TurnRole;
}

export interface ContextReport {
  harness: HarnessId;
  harnessVersion: string;
  sessionId: string;
  cwd: string;
  model: string;
  turns: ContextTurnRow[];
  separators: ContextCompactionSeparatorRow[];
}

function estTokensLabel(tokens: number): string {
  return `~${formatNumber(tokens)}`;
}

function buildCategoryRows(
  composition: Composition,
  contextTotal: number,
): ContextCategoryRow[] {
  const rows: ContextCategoryRow[] = [];
  for (const category of COMPOSITION_CATEGORY_ORDER) {
    const tokens = composition.categories[category];
    if (!tokens) continue;
    rows.push({
      category,
      tokens,
      tokensLabel: estTokensLabel(tokens),
      pct: contextTotal !== 0 ? tokens / contextTotal : 0,
    });
  }
  return rows;
}

function buildResidualRow(composition: Composition): ContextResidualRow {
  return {
    tokens: composition.residual,
    tokensLabel: formatNumber(composition.residual),
    pct: composition.residualShare,
    label: RESIDUAL_LABEL,
  };
}

function buildTurnRow(turn: Turn, index: number): ContextTurnRow {
  const row: ContextTurnRow = {
    turnNumber: index + 1,
    turnIndex: index,
    role: turn.role,
    model: turn.model,
    contextTotal: turn.contextTotal,
    categories: buildCategoryRows(turn.composition, turn.contextTotal),
    residual: buildResidualRow(turn.composition),
  };
  if (turn.composition.truncated) row.truncatedLabel = TRUNCATED_LABEL;
  return row;
}

function compactionLabel(shrinkExact: number | null): string {
  return shrinkExact === null
    ? "compaction: shrink unknown (before/after usage not both recorded)"
    : `compaction: shrunk ${formatNumber(shrinkExact)} tokens (exact)`;
}

function isCompactionEvent(
  event: Session["events"][number],
): event is CompactionEvent {
  return event.kind === "compaction";
}

/**
 * Builds the full per-turn composition report for an already-processed
 * session (parse -> dedupSession -> computeComposition -> finalizeCompactions
 * — see loadProcessedSession). Pure; does no I/O.
 */
export function buildContextReport(session: Session): ContextReport {
  const turns = session.turns.map((turn, index) => buildTurnRow(turn, index));

  const separators: ContextCompactionSeparatorRow[] = session.events
    .filter(isCompactionEvent)
    .map((event) => ({
      beforeTurnNumber: event.turnIndex + 1,
      shrinkExact: event.shrinkExact,
      label: compactionLabel(event.shrinkExact),
    }))
    .sort((a, b) => a.beforeTurnNumber - b.beforeTurnNumber);

  return {
    harness: session.harness,
    harnessVersion: session.harnessVersion,
    sessionId: session.id,
    cwd: session.cwd,
    model: session.configSnapshot.model,
    turns,
    separators,
  };
}

/**
 * Expands one turn (1-indexed `turnNumber`, matching ContextTurnRow.turnNumber
 * and the `--turn` CLI flag) into its raw content spans — the `--turn n`
 * view. Returns undefined when the turn doesn't exist. Spans are always
 * char/4 estimates (PLAN rule 5), so every row's tokensLabel is "~"-prefixed
 * unconditionally, unlike ContextResidualRow.
 */
export function buildTurnDetail(
  session: Session,
  turnNumber: number,
): ContextSpanRow[] | undefined {
  const turn = session.turns[turnNumber - 1];
  if (!turn) return undefined;
  return turn.contentSpans.map((span) => {
    const tokensEst = Math.ceil(span.charCount / 4);
    const row: ContextSpanRow = {
      category: span.category,
      tokensEst,
      tokensLabel: estTokensLabel(tokensEst),
      truncated: span.truncated,
      turnRole: span.turnRole,
    };
    if (span.toolName !== undefined) row.toolName = span.toolName;
    if (span.mcpServer !== undefined) row.mcpServer = span.mcpServer;
    return row;
  });
}

// ---------------------------------------------------------------------------
// Session resolution — I/O. Discovers across all three adapters (or one, via
// --harness), matches a session id or a direct file path, or falls back to
// the most-recently-modified session when no argument is given.
//
// Delegates entirely to commands/shared.ts's resolveSessionRef — the
// canonical resolver (id match, content-sniffed direct-file-path match,
// most-recent fallback) shared with cost.ts/compactions.ts/list.ts, so there
// is exactly one implementation of this logic for the whole CLI. `resolveSession`
// and `ResolveOptions` stay exported under their original names here since
// commands/report.ts imports both from this module.
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  harness?: HarnessId;
  cwd?: string;
  /** Discovery root overrides, keyed like adapters/*'s own `roots?: string[]`
   * param. Test-only escape hatch — production callers omit this and get
   * each adapter's real default root. */
  roots?: Partial<Record<HarnessId, string[]>>;
}

/**
 * Resolves a `peek context [sessionIdOrPath]` argument to a SessionRef:
 *   - undefined -> most-recently-modified session across the (optionally
 *     --harness/--cwd filtered) discovered set.
 *   - an existing file path -> that exact file, whichever harness it belongs
 *     to by content (never directory shape) — and a clear error if a given
 *     --harness disagrees with the sniffed content.
 *   - anything else -> a session id, matched across the filtered discovered set.
 * Throws (never returns undefined) — CLI callers catch and print the message.
 */
export async function resolveSession(
  input: string | undefined,
  opts: ResolveOptions = {},
): Promise<SessionRef> {
  return resolveSessionRef(input, opts);
}

async function parseSessionByHarness(ref: SessionRef): Promise<ParseResult> {
  switch (ref.harness) {
    case "claude-code":
      return parseClaudeSession(ref);
    case "codex":
      return parseCodexSession(ref);
    case "pi":
      return parsePiSession(ref);
    default: {
      const exhaustive: never = ref.harness;
      throw new Error(`unknown harness: ${String(exhaustive)}`);
    }
  }
}

/** parse -> dedupSession -> computeComposition -> finalizeCompactions, per
 * T3.2's pipeline brief. */
export async function loadProcessedSession(
  ref: SessionRef,
): Promise<{ session: Session; warnings: ParseWarning[] }> {
  const { session, warnings } = await parseSessionByHarness(ref);
  const deduped: Session = dedupSession(session);
  const composed = computeComposition(deduped);
  const finalized = finalizeCompactions(composed);
  return { session: finalized, warnings };
}

// ---------------------------------------------------------------------------
// Text rendering — console output only, no logic. --json bypasses this
// entirely via serializeJSON.
// ---------------------------------------------------------------------------

function printTurnRow(
  turn: ContextTurnRow,
  separators: Map<number, ContextCompactionSeparatorRow[]>,
  out: string[],
): void {
  for (const sep of separators.get(turn.turnNumber) ?? []) {
    out.push(renderSeparator(sep.label));
    out.push("");
  }

  out.push(
    `${pc.bold(`Turn ${turn.turnNumber}`)}  ${turn.role.padEnd(9)}  ${turn.model}  contextTotal ${formatNumber(turn.contextTotal)}`,
  );
  if (turn.truncatedLabel) out.push(`  ${pc.yellow(turn.truncatedLabel)}`);

  const rows: string[][] = turn.categories.map((c) => [
    c.category,
    c.tokensLabel,
    renderBar(c.pct),
  ]);
  rows.push([
    "residual",
    turn.residual.tokensLabel,
    `${renderBar(turn.residual.pct)}  ${pc.dim(turn.residual.label)}`,
  ]);

  const table = renderTable(
    [
      { header: "category", align: "left" },
      { header: "tokens", align: "right" },
      { header: "share", align: "left" },
    ],
    rows,
  );
  out.push(...table.split("\n").map((line) => `  ${line}`));
  out.push("");
}

function printReport(report: ContextReport): void {
  const out: string[] = [];
  out.push(
    pc.bold("peek context") +
      pc.dim(` — ${report.harness} · ${report.sessionId} · ${report.cwd}`),
  );
  out.push("");

  const separators = new Map<number, ContextCompactionSeparatorRow[]>();
  for (const sep of report.separators) {
    const bucket = separators.get(sep.beforeTurnNumber);
    if (bucket) bucket.push(sep);
    else separators.set(sep.beforeTurnNumber, [sep]);
  }

  for (const turn of report.turns) {
    printTurnRow(turn, separators, out);
  }

  process.stdout.write(`${out.join("\n")}\n`);
}

function printTurnDetail(turnNumber: number, spans: ContextSpanRow[]): void {
  const out: string[] = [];
  out.push(pc.bold(`Turn ${turnNumber} — spans`));
  if (spans.length === 0) {
    out.push(pc.dim("  (no content spans)"));
  } else {
    const rows = spans.map((s) => [
      s.category,
      [s.toolName, s.mcpServer]
        .filter((v): v is string => Boolean(v))
        .join(" / "),
      s.tokensLabel,
      s.truncated ? "truncated" : "",
    ]);
    out.push(
      renderTable(
        [
          { header: "category", align: "left" },
          { header: "tool / mcp", align: "left" },
          { header: "tokens", align: "right" },
          { header: "flags", align: "left" },
        ],
        rows,
      ),
    );
  }
  process.stdout.write(`${out.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export interface ContextCommandOptions {
  harness?: HarnessId;
  cwd?: string;
  json?: boolean;
  turn?: number;
}

export async function runContextCommand(
  sessionIdOrPath: string | undefined,
  options: ContextCommandOptions,
): Promise<void> {
  const resolveOpts: ResolveOptions = {};
  if (options.harness !== undefined) resolveOpts.harness = options.harness;
  if (options.cwd !== undefined) resolveOpts.cwd = options.cwd;
  const ref = await resolveSession(sessionIdOrPath, resolveOpts);
  const { session } = await loadProcessedSession(ref);

  if (options.turn !== undefined) {
    const spans = buildTurnDetail(session, options.turn);
    if (!spans) {
      throw new Error(
        `no turn ${options.turn} in this session (it has ${session.turns.length} turn${session.turns.length === 1 ? "" : "s"})`,
      );
    }
    if (options.json) {
      process.stdout.write(
        `${serializeJSON({ turnNumber: options.turn, spans })}\n`,
      );
      return;
    }
    printTurnDetail(options.turn, spans);
    return;
  }

  const report = buildContextReport(session);
  if (options.json) {
    process.stdout.write(`${serializeJSON(report)}\n`);
    return;
  }
  printReport(report);
}
