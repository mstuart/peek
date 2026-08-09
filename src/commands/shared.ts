// Cross-command helpers (T3.1) shared by list.ts / cost.ts / compactions.ts.
//
// resolveSessionRef's direct-file-path branch (resolveByPath/sniffHarness
// below) is the CANONICAL implementation — content-sniffed, not directory-
// shape-based (a directory-shape resolver was tried first and abandoned:
// see sniffHarness's doc comment for why). commands/context.ts's
// resolveSession delegates here rather than keeping its own copy, so there
// is exactly one direct-file-path resolver for the whole CLI.
//
// Engine pipeline stage per command (docs/DESIGN.md architecture order: dedup
// -> accounting -> composition -> compaction -> attribution):
//   - list:        parse -> dedupSession -> priceSession -> sessionTotals.
//                  Composition is skipped entirely — a list row only needs
//                  exact totals/cost/compaction-count, not the O(turns)
//                  per-category char/4 walk composition.ts does, so running
//                  it here would cost real time across a whole discovery
//                  tree for output nothing downstream reads.
//   - cost:        parse -> dedupSession -> priceSession -> attribution.ts's
//                  byModel/byTool/byMcpServer/cacheAnalysis. These read
//                  Span.category/toolName/mcpServer straight off
//                  turn.contentSpans, not off Composition, so composition is
//                  not a dependency here either.
//   - compactions:  parse -> dedupSession -> finalizeCompactions. No pricing
//                  needed unless a CompactionEvent already carries adapter-
//                  attached cost (pi); no composition needed.
//
// Every command funnels session loading through loadSession/parseAndDedup
// below so "dedup precedes all aggregation" (model/types.ts's Session
// invariant) holds without each command re-deriving it.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ROOT as CLAUDE_DEFAULT_ROOT,
  discoverClaudeSessions,
} from "../adapters/claude/discover.js";
import { parseClaudeSession } from "../adapters/claude/parse.js";
import {
  DEFAULT_ROOT as CODEX_DEFAULT_ROOT,
  discoverCodexSessions,
} from "../adapters/codex/discover.js";
import { parseCodexSession } from "../adapters/codex/parse.js";
import {
  discoverPiSessions,
  defaultRoot as piDefaultRoot,
} from "../adapters/pi/discover.js";
import { parsePiSession } from "../adapters/pi/parse.js";
import { dedupSession } from "../engine/dedup.js";
import { formatCost } from "../model/format.js";
import type {
  HarnessId,
  ParseResult,
  ParseWarning,
  Session,
  SessionRef,
} from "../model/types.js";

export { formatCost };

// ---------------------------------------------------------------------------
// CLI option parsing helpers — small enough that duplicating cli.ts's own
// private parseHarness (that file is off-limits, see header) across list/
// cost/compactions would be worse than one shared copy here.
// ---------------------------------------------------------------------------

const HARNESS_IDS: readonly HarnessId[] = ["claude-code", "codex", "pi"];

export function parseHarnessOption(value: string): HarnessId {
  if ((HARNESS_IDS as readonly string[]).includes(value)) {
    return value as HarnessId;
  }
  throw new Error(
    `--harness must be one of ${HARNESS_IDS.join(", ")} (got: ${value})`,
  );
}

export function parseSinceOption(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`--since must be a valid date (got: ${value})`);
  }
  return date;
}

// ---------------------------------------------------------------------------
// Formatting helpers shared by list/cost/compactions' text renderers.
// ---------------------------------------------------------------------------

/** Date -> "YYYY-MM-DD HH:mm" in UTC — deterministic across machines/
 * timezones for snapshot tests, unlike a locale-formatted string. */
export function formatTimestamp(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

// ---------------------------------------------------------------------------
// discoverAll — merges all three adapters' refs, with filters.
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  harness?: HarnessId;
  cwd?: string;
  /** Discovery root overrides, keyed like adapters/*'s own `roots?: string[]`
   * param. Test-only escape hatch — production callers omit this and get
   * each adapter's real default root. */
  roots?: Partial<Record<HarnessId, string[]>>;
}

export interface DiscoverAllOptions extends ResolveOptions {
  /** Only refs with mtime >= since are kept. */
  since?: Date;
}

function applyFilters(
  refs: readonly SessionRef[],
  opts: DiscoverAllOptions,
): SessionRef[] {
  let result: SessionRef[] = [...refs];
  if (opts.harness) result = result.filter((r) => r.harness === opts.harness);
  if (opts.cwd) {
    const cwd = opts.cwd;
    // Only excludes refs that CARRY a cwd at discovery time and it doesn't
    // match (codex refs never carry cwd until parse time — see
    // adapters/codex/discover.ts) — same documented limitation as
    // commands/context.ts's own applyFilters.
    result = result.filter((r) => r.cwd === undefined || r.cwd === cwd);
  }
  if (opts.since) {
    const since = opts.since;
    result = result.filter((r) => r.mtime >= since);
  }
  return result;
}

/** Discovers and merges SessionRefs across all three harnesses, applying
 * --harness/--cwd/--since filters. Never throws — missing discovery roots
 * resolve to an empty list per each adapter's own discover(). */
export async function discoverAll(
  opts: DiscoverAllOptions = {},
): Promise<SessionRef[]> {
  const [claude, codex, pi] = await Promise.all([
    discoverClaudeSessions(opts.roots?.["claude-code"]),
    discoverCodexSessions(opts.roots?.codex),
    discoverPiSessions(opts.roots?.pi),
  ]);
  return applyFilters([...claude, ...codex, ...pi], opts);
}

// ---------------------------------------------------------------------------
// "No sessions found" messaging convention.
//
// Two different situations both say "no sessions found", and they are NOT
// the same thing:
//   - list-empty (peek list's printListReport, cost/compactions/context
//     with no matches): the discovery roots exist and were readable, they
//     just happen to hold nothing that matches the filters. This is a
//     normal, successful outcome — exit 0.
//   - unresolvable-target (resolveSessionRef below, when a bare `peek
//     context`/`cost`/... has no session to default to): the caller asked
//     to resolve to something specific (most-recent session, or an id/path)
//     and nothing could be produced. This is a failure the caller must
//     react to — exit 1 (thrown Error, caught by each command's own
//     try/catch in cli.ts).
// Both cases used to say only "check discovery roots" — checkedRootsList/
// describeCheckedRoots below name the ACTUAL resolved root(s) (honoring
// opts.roots' test-only override and pi's $PI_AGENT_DIR) so the message is
// immediately actionable instead of sending the user hunting for the paths.
// ---------------------------------------------------------------------------

const DEFAULT_ROOT_BY_HARNESS: Record<HarnessId, () => string> = {
  "claude-code": () => CLAUDE_DEFAULT_ROOT,
  codex: () => CODEX_DEFAULT_ROOT,
  pi: () => piDefaultRoot(),
};

/** The concrete discovery root path(s) actually in scope for a given
 * discoverAll/resolveSessionRef call: opts.roots' per-harness override when
 * present (test-only escape hatch), else that harness's real resolved
 * default. Scoped to the single harness when --harness filters, otherwise
 * all three. */
export function checkedRootsList(opts: ResolveOptions = {}): string[] {
  const harnesses: readonly HarnessId[] = opts.harness
    ? [opts.harness]
    : HARNESS_IDS;
  return harnesses.flatMap((h) => {
    const override = opts.roots?.[h];
    return override && override.length > 0
      ? override
      : [DEFAULT_ROOT_BY_HARNESS[h]()];
  });
}

/** checkedRootsList, comma-joined for inline use in a "no sessions found"
 * message. */
export function describeCheckedRoots(opts: ResolveOptions = {}): string {
  return checkedRootsList(opts).join(", ");
}

// ---------------------------------------------------------------------------
// Session resolution — id match, direct-file-path match, most-recent
// fallback.
// ---------------------------------------------------------------------------

function mostRecent(refs: readonly SessionRef[]): SessionRef {
  const sorted = [...refs].sort((a, b) => {
    const byMtime = b.mtime.getTime() - a.mtime.getTime();
    if (byMtime !== 0) return byMtime;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; // deterministic tiebreak
  });
  const first = sorted[0];
  if (!first) throw new Error("mostRecent: refs must be non-empty");
  return first;
}

function ancestorDirs(dir: string, levels: number): string[] {
  const dirs: string[] = [];
  let current = dir;
  for (let i = 0; i < levels; i++) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

/**
 * Determines which harness a session file belongs to by reading its FIRST
 * line only and checking a field each format's own on-disk shape always
 * carries there — NOT duplicated parsing logic, just enough of a peek to
 * pick which already-correct adapter to hand the whole file to.
 *
 * Directory-shape-based disambiguation was tried first and abandoned: this
 * repo's own fixture layout (test/fixtures/codex/v0.134/*.jsonl,
 * test/fixtures/claude-code/v2.1.104/*.jsonl, …) happens to satisfy
 * claude-code's "root/slugDir/id.jsonl" shape check for EVERY harness's
 * fixture tree, not just claude-code's — a codex fixture path was being
 * mis-resolved to a bogus claude-code SessionRef purely because its
 * containing directory looked like a slug dir (docs/examples/BROKEN.md).
 * Directory shape is not a reliable signal here; file content is.
 *
 *   - codex: every on-disk record is EXACTLY `{timestamp, type, payload}` —
 *     no more, no fewer keys (docs/recon/codex.md, confirmed at cli 0.134.0).
 *   - pi System A: header line is `{"type":"session","version":<n>,...}`
 *     (adapters/pi/tree.ts).
 *   - pi System B (harness v4): header line carries a `kind` field instead
 *     of `type:"session"` — sniffed as "pi" the same as System A; the A/B
 *     split (and System B's parse path (supported since v2 Lane D)) is
 *     adapters/pi/tree.ts's job once parsing actually starts, not this
 *     function's.
 *   - claude-code: every record (including the first, and subagent files'
 *     first record) carries a top-level `sessionId` string
 *     (docs/recon/claude-code.md; verified against every local fixture's
 *     first line).
 */
async function sniffHarness(filePath: string): Promise<HarnessId | undefined> {
  let firstLine: string;
  try {
    const raw = await readFile(filePath, "utf8");
    const nl = raw.indexOf("\n");
    firstLine = nl === -1 ? raw : raw.slice(0, nl);
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;

  const keys = Object.keys(record).sort().join(",");
  if (keys === "payload,timestamp,type") return "codex";
  if (record.type === "session" || "kind" in record) return "pi";
  if (typeof record.sessionId === "string") return "claude-code";
  return undefined;
}

const DISCOVER_BY_HARNESS: Record<
  HarnessId,
  (roots?: string[]) => Promise<SessionRef[]>
> = {
  "claude-code": discoverClaudeSessions,
  codex: discoverCodexSessions,
  pi: discoverPiSessions,
};

/**
 * Direct-file-path resolution: sniffHarness picks the ONE correct adapter
 * (see its doc comment for why content, not directory shape, decides this),
 * then that adapter's own discover function is tried at several ancestor
 * roots above the file — claude-code's real layout needs a root TWO levels
 * above a main session file (root/slugDir/id.jsonl) and up to four above a
 * subagent file (root/slugDir/sessionId/subagents/agent-id.jsonl).
 *
 * `harnessOverride` (a caller-supplied `--harness`) is validated against the
 * sniffed content rather than silently trusted or silently ignored: a
 * mismatch is a clear, actionable error, never a silent guess in either
 * direction.
 */
async function resolveByPath(
  input: string,
  harnessOverride?: HarnessId,
): Promise<SessionRef | undefined> {
  const asPath = path.resolve(input);
  if (!existsSync(asPath)) return undefined;

  const harness = await sniffHarness(asPath);
  if (!harness) {
    throw new Error(
      `file exists but is not a recognized session file: ${input} (tried codex [line 1 is exactly {timestamp,type,payload}], pi [line 1 has type:"session" or a "kind" field], claude-code [line 1 has a sessionId field]; none matched)`,
    );
  }
  if (harnessOverride !== undefined && harness !== harnessOverride) {
    throw new Error(
      `--harness ${harnessOverride} was given but ${input} is a ${harness} session by content — drop --harness or correct it`,
    );
  }

  const discover = DISCOVER_BY_HARNESS[harness];
  const roots = ancestorDirs(path.dirname(asPath), 4);
  for (const root of roots) {
    const found = (await discover([root])).find(
      (r) => path.resolve(r.path) === asPath,
    );
    if (found) return found;
  }

  throw new Error(`file exists but is not a recognized session file: ${input}`);
}

/**
 * Resolves a `[sess]` CLI argument to a SessionRef:
 *   - undefined -> most-recently-modified session across the (optionally
 *     --harness/--cwd-filtered) discovered set.
 *   - an existing file path -> that exact file, whichever harness it belongs to
 *     (content-sniffed — see resolveByPath/sniffHarness).
 *   - anything else -> a session id, matched across the filtered discovered set.
 * Throws (never returns undefined) — CLI callers catch and print the message.
 */
export async function resolveSessionRef(
  input: string | undefined,
  opts: ResolveOptions = {},
): Promise<SessionRef> {
  if (input !== undefined) {
    const byPath = await resolveByPath(input, opts.harness);
    if (byPath) return byPath;
  }

  const refs = await discoverAll(opts);

  if (input === undefined) {
    if (refs.length === 0) {
      throw new Error(
        `no sessions found — checked ${describeCheckedRoots(opts)} (narrowed by --cwd/--harness if passed)`,
      );
    }
    return mostRecent(refs);
  }

  // Exact id first; fall back to unique-prefix match (≥6 chars) so the
  // 8-char short ids `peek list` prints are directly paste-able into every
  // other command (found in final real-data verification: peek's own list
  // output was not resolvable by peek).
  let matches = refs.filter((r) => r.id === input);
  if (matches.length === 0 && input.length >= 6) {
    const prefixMatches = refs.filter((r) => r.id.startsWith(input));
    const uniqueIds = new Set(prefixMatches.map((r) => r.id));
    if (uniqueIds.size === 1) {
      matches = prefixMatches;
    } else if (uniqueIds.size > 1) {
      throw new Error(
        `ambiguous session id prefix "${input}" (${uniqueIds.size} matches) — use more characters`,
      );
    }
  }
  if (matches.length === 0) {
    throw new Error(`no session found with id or path: ${input}`);
  }
  if (matches.length > 1) {
    const harnesses = [...new Set(matches.map((m) => m.harness))].join(", ");
    throw new Error(
      `session id "${input}" is ambiguous across harnesses (${harnesses}) — pass --harness to disambiguate`,
    );
  }
  const match = matches[0];
  if (!match) throw new Error("unreachable");
  return match;
}

// ---------------------------------------------------------------------------
// Parse + dedup pipeline.
// ---------------------------------------------------------------------------

/** Threaded through to each adapter's own {spans?} option (claude/parse.ts's
 * ParseClaudeSessionOptions doc has the shared contract). Default spans:true
 * (unset) — only list's loadEntries passes spans:false today. */
export interface ParseOptions {
  spans?: boolean;
}

async function parseSessionByHarness(
  ref: SessionRef,
  opts: ParseOptions = {},
): Promise<ParseResult> {
  switch (ref.harness) {
    case "claude-code":
      return parseClaudeSession(ref, opts);
    case "codex":
      return parseCodexSession(ref, opts);
    case "pi":
      return parsePiSession(ref, opts);
    default: {
      const exhaustive: never = ref.harness;
      throw new Error(`unknown harness: ${String(exhaustive)}`);
    }
  }
}

export interface LoadedSession {
  ref: SessionRef;
  /** Deduped (dedupSession — turns AND event.turnIndex remapped together;
   * see engine/dedup.ts's dedupSession doc for why the bare dedupTurns isn't
   * enough once CompactionEvents are in play). NOT priced, NOT composed,
   * NOT finalized — callers add whichever later stages they need (see file
   * header's per-command pipeline table). */
  session: Session;
  warnings: ParseWarning[];
}

/** parse -> dedupSession for an already-resolved ref. `opts.spans: false`
 * (list's loadEntries only) skips content-span extraction for a cheaper
 * parse — see ParseOptions doc. */
export async function parseAndDedup(
  ref: SessionRef,
  opts: ParseOptions = {},
): Promise<LoadedSession> {
  const { session, warnings } = await parseSessionByHarness(ref, opts);
  return { ref, session: dedupSession(session), warnings };
}

/** resolveSessionRef -> parseAndDedup, for commands taking a `[sess]` arg. */
export async function loadSession(
  idOrPath: string | undefined,
  opts: ResolveOptions = {},
): Promise<LoadedSession> {
  const ref = await resolveSessionRef(idOrPath, opts);
  return parseAndDedup(ref);
}
