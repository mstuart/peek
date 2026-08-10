// results.jsonl writer/reader (A4 deliverable #1, DESIGN.md § Bench design
// "Metrics & output": `peek bench run` writes
// `bench-results/<ISO-ts>/results.jsonl`, one TrialResult per line.
//
// Writer: one `appendFile` per trial (open/write/close, not a long-lived
// stream) — a crash mid-run leaves every already-completed trial's line
// intact; at worst the LAST line is torn (partial JSON from a write that was
// interrupted mid-flush). Reader tolerates that: a line that fails
// JSON.parse is reported as a warning, never thrown, and never discards the
// rest of the file (spec: "loader tolerant of partial lines from crashed
// runs").
//
// Content-on-disk boundary: append() redacts TrialResult.raw (the runner's
// full harness result JSON, incl. the agent's response text) down to an
// allowlist of cost/usage/error/timing fields before it hits this file — see
// redactRaw below. results.jsonl lives in a directory users' own repos won't
// gitignore by default.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { TrialResult } from "./types.js";

export const DEFAULT_RESULTS_BASE_DIR = "bench-results";
export const RESULTS_FILE_NAME = "results.jsonl";

/** Keys from a claude-code runner's raw `--output-format json` result
 * (runners/claude.ts) that are safe to persist to disk — cost/usage/error/
 * timing metadata only, per docs/DESIGN.md's `permission_denials` mention.
 * Everything else, notably `result` (the agent's full response text), is
 * dropped by redactRaw below. */
const RAW_SAFE_KEYS = new Set([
  "type",
  "subtype",
  "session_id",
  "is_error",
  "stop_reason",
  "duration_ms",
  "duration_api_ms",
  "num_turns",
  "total_cost_usd",
  "usage",
  "modelUsage",
  "permission_denials",
]);

/** Drops free-text fields — the agent's full response text (`result`) and
 * anything else not on the allowlist above — from a trial's raw harness
 * result JSON before it's written to disk. `bench-results/` is a directory
 * users' own repos won't gitignore, and TrialResult.raw used to carry the
 * complete claude result verbatim, response text included. Marks the row
 * with `rawRedacted: true` so a reader can tell the field was intentionally
 * trimmed rather than simply absent (e.g. a runner that never populated
 * `raw`, or a crash before the result JSON was parsed). */
function redactRaw(raw: unknown): unknown {
  if (raw === undefined) {
    return;
  }
  const safe: Record<string, unknown> = { rawRedacted: true };
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (RAW_SAFE_KEYS.has(key)) {
        safe[key] = value;
      }
    }
  }
  return safe;
}

/** ISO timestamp -> filesystem-safe directory name: colons and the
 * milliseconds dot aren't safe/pleasant across platforms, so both become
 * dashes ("2026-08-08T17-22-10-123Z"). Collision-free at second granularity
 * in practice (one bench run per invocation). */
export function isoTimestampSlug(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function resultsDirForRun(baseDir: string, timestamp: Date): string {
  return path.join(baseDir, isoTimestampSlug(timestamp));
}

export interface ResultsWriter {
  append: (result: TrialResult) => Promise<void>;
  readonly dir: string;
  readonly path: string;
}

export interface CreateResultsWriterOptions {
  baseDir?: string; // default "bench-results" (relative to cwd, like peek report's default output)
  timestamp?: Date; // default: now — test seam for deterministic paths
}

/** Creates (mkdir -p) `<baseDir>/<ISO-ts>/` and returns a writer whose
 * append() appends one JSON line per TrialResult to `results.jsonl` inside
 * it. */
export async function createResultsWriter(
  opts: CreateResultsWriterOptions = {}
): Promise<ResultsWriter> {
  const baseDir = opts.baseDir ?? DEFAULT_RESULTS_BASE_DIR;
  const dir = resultsDirForRun(baseDir, opts.timestamp ?? new Date());
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, RESULTS_FILE_NAME);
  return {
    async append(result: TrialResult): Promise<void> {
      // Redact TrialResult.raw at the disk-write chokepoint (never in the
      // in-memory TrialResult returned to callers) — see redactRaw above.
      const persisted: TrialResult = { ...result, raw: redactRaw(result.raw) };
      await appendFile(filePath, `${JSON.stringify(persisted)}\n`, "utf8");
    },
    dir,
    path: filePath,
  };
}

export interface ReadResultsWarning {
  line: number; // 1-indexed
  message: string;
}

export interface ReadResultsOutcome {
  results: TrialResult[];
  /** Lines that failed JSON.parse (a crashed run's torn last line, or any
   * other corrupt line) — surfaced, not thrown. */
  warnings: ReadResultsWarning[];
}

/** Reads a results.jsonl file, tolerant of a torn/partial trailing line (or
 * any other unparseable line) from a crashed run — that line is reported as
 * a warning and skipped; every other line's TrialResult is still returned. */
export async function readResults(
  filePath: string
): Promise<ReadResultsOutcome> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `could not read results file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  return parseResultsJsonl(raw);
}

/** Pure parse of already-read results.jsonl content — split out from
 * readResults so tests can exercise torn-line tolerance without touching the
 * filesystem. */
export function parseResultsJsonl(raw: string): ReadResultsOutcome {
  const lines = raw.split("\n");
  const results: TrialResult[] = [];
  const warnings: ReadResultsWarning[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return; // blank line (trailing newline, etc.) — not a warning
    }
    try {
      results.push(JSON.parse(trimmed) as TrialResult);
    } catch (err) {
      warnings.push({
        line: i + 1,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return { results, warnings };
}
