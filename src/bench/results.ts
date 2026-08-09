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

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { TrialResult } from "./types.js";

export const DEFAULT_RESULTS_BASE_DIR = "bench-results";
export const RESULTS_FILE_NAME = "results.jsonl";

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
  readonly dir: string;
  readonly path: string;
  append(result: TrialResult): Promise<void>;
}

export interface CreateResultsWriterOptions {
  baseDir?: string; // default "bench-results" (relative to cwd, like peek report's default output)
  timestamp?: Date; // default: now — test seam for deterministic paths
}

/** Creates (mkdir -p) `<baseDir>/<ISO-ts>/` and returns a writer whose
 * append() appends one JSON line per TrialResult to `results.jsonl` inside
 * it. */
export async function createResultsWriter(
  opts: CreateResultsWriterOptions = {},
): Promise<ResultsWriter> {
  const baseDir = opts.baseDir ?? DEFAULT_RESULTS_BASE_DIR;
  const dir = resultsDirForRun(baseDir, opts.timestamp ?? new Date());
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, RESULTS_FILE_NAME);
  return {
    dir,
    path: filePath,
    async append(result: TrialResult): Promise<void> {
      await appendFile(filePath, `${JSON.stringify(result)}\n`, "utf8");
    },
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
  filePath: string,
): Promise<ReadResultsOutcome> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `could not read results file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
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
    if (trimmed.length === 0) return; // blank line (trailing newline, etc.) — not a warning
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
