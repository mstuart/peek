// Totals cache (v2 PLAN Lane B, docs/DESIGN.md § Other v2 subsystems + docs/PERF.md fix #3) — the
// durable answer to `peek list`'s cold-parse floor. One row per session
// file, keyed by (path, mtimeMs, size): a stat-only match skips the full
// parse+dedup+price pipeline entirely. Schema-versioned by FILENAME
// (totals-v1.jsonl) rather than an in-row version field — a schema change
// bumps the filename, the old file is simply orphaned/ignored, no migration
// code needed.
//
// On-disk format: append-only JSONL. Reads tolerate corruption line-by-line
// (bad JSON or wrong shape -> skip that line, keep going) and tolerate a
// missing/unreadable file (-> empty cache, rebuilt from scratch by the
// caller's own upserts). Later lines for the same `path` win over earlier
// ones (last-write-wins on load), so the file can carry stale duplicate rows
// between compactions without correctness risk.
//
// Concurrency: peek is a single-process CLI (no daemon, no parallel `peek
// list` invocations coordinating with each other) — `upsert` uses
// `appendFileSync`/sync compaction rather than a lockfile or atomic-append
// protocol. Two concurrent `peek list` processes racing on the same cache
// file is a known, accepted limitation: worst case is a torn/interleaved
// line, which the corruption-safe reader above skips (a lost cache row, not
// a crash).

import { appendFileSync, chmodSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SessionTotals } from "../engine/accounting.js";
import { sessionTotals } from "../engine/accounting.js";
import type { HarnessId, Session, SessionRef } from "../model/types.js";

export interface TotalsCacheRow {
  compactions: number;
  cwd: string;
  endedAt: string;
  harness: HarnessId;
  model: string;
  mtimeMs: number;
  path: string;
  size: number;
  startedAt: string; // ISO — cache rows are plain JSON, not USM Session objects
  totals: SessionTotals;
  turns: number;
}

/** Builds a cache row from an already deduped+priced session (list's
 * loadEntries pipeline: parse -> dedupSession -> priceSession). Mirrors
 * exactly what commands/list.ts's buildListRow reads off a Session. */
export function toCacheRow(ref: SessionRef, session: Session): TotalsCacheRow {
  return {
    compactions: session.events.filter((e) => e.kind === "compaction").length,
    cwd: session.cwd,
    endedAt: session.endedAt.toISOString(),
    harness: ref.harness,
    model: session.configSnapshot.model,
    mtimeMs: ref.mtime.getTime(),
    path: ref.path,
    size: ref.sizeBytes,
    startedAt: session.startedAt.toISOString(),
    totals: sessionTotals(session),
    turns: session.turns.length,
  };
}

const HARNESS_IDS = new Set<HarnessId>(["claude-code", "codex", "pi"]);

/** Tokens/turns/compactions/cost must be finite, non-negative numbers — a hand-edited or
 * corrupted cache line can carry `typeof === "number"` values like `1e308`, `-5`, `NaN`, or
 * `Infinity` (all valid JSON) that would otherwise flow straight through to `peek list`'s
 * output verbatim. A row failing this check is treated as a cache miss (see the `isValidRow`
 * call site in loadCache below), forcing a re-parse from the source session file rather than
 * ever surfacing the poisoned values. */
function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Cache-boundary validation checks every persisted field explicitly.
function isValidRow(value: unknown): value is TotalsCacheRow {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  if (typeof r.path !== "string") {
    return false;
  }
  if (typeof r.mtimeMs !== "number") {
    return false;
  }
  if (typeof r.size !== "number") {
    return false;
  }
  if (
    typeof r.harness !== "string" ||
    !HARNESS_IDS.has(r.harness as HarnessId)
  ) {
    return false;
  }
  if (!isFiniteNonNegative(r.turns)) {
    return false;
  }
  if (!isFiniteNonNegative(r.compactions)) {
    return false;
  }
  if (typeof r.startedAt !== "string") {
    return false;
  }
  if (typeof r.endedAt !== "string") {
    return false;
  }
  if (typeof r.cwd !== "string") {
    return false;
  }
  if (typeof r.model !== "string") {
    return false;
  }

  if (typeof r.totals !== "object" || r.totals === null) {
    return false;
  }
  const totals = r.totals as Record<string, unknown>;
  if (!isFiniteNonNegative(totals.cost)) {
    return false;
  }
  if (typeof totals.priced !== "boolean") {
    return false;
  }
  if (typeof totals.tokens !== "object" || totals.tokens === null) {
    return false;
  }
  const tokens = totals.tokens as Record<string, unknown>;
  const tokenKeys = [
    "inputUncached",
    "cacheRead",
    "cacheWrite5m",
    "cacheWrite1h",
    "output",
    "contextTotal",
  ] as const;
  for (const key of tokenKeys) {
    if (!isFiniteNonNegative(tokens[key])) {
      return false;
    }
  }
  return true;
}

/** `${XDG_CACHE_HOME ?? ~/.cache}/peek/totals-v1.jsonl`. */
function resolveCachePath(override?: string): string {
  if (override) {
    return override;
  }
  const base = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(base, "peek", "totals-v1.jsonl");
}

// Cache rows carry usernames and project paths (session cwd, session ids derived from
// filenames) — the peek cache dir and everything in it is tightened to owner-only
// (0700 dir / 0600 files) to avoid leaking that to other accounts on a shared machine.
// mkdir's/writeFileSync's `mode` option only takes effect for a path that doesn't yet
// exist, so an explicit chmod after every create/write (and on load, for a
// pre-existing file/dir left loose by a peek version predating this fix) is required
// to actually guarantee the tightened mode rather than merely requesting it.
const CACHE_DIR_MODE = 0o700;
const CACHE_FILE_MODE = 0o600;

/** Best-effort chmod — failure (missing path, unsupported filesystem, permissions we
 * don't own) is silently ignored: this is host-local convenience cache state, not
 * something a failed chmod should ever crash the CLI over. */
function tightenPerms(targetPath: string, mode: number): void {
  try {
    chmodSync(targetPath, mode);
  } catch {
    // best-effort — ignore
  }
}

export interface TotalsCache {
  /** A row matches only when path+mtimeMs+size ALL match `ref` — any drift
   * (file touched, resized, or the ref pointing somewhere else entirely) is
   * treated as a miss, never a stale hit. */
  lookup: (ref: SessionRef) => TotalsCacheRow | undefined;
  /** Appends `rows` to the on-disk cache and updates the in-memory index.
   * Triggers a full compaction rewrite (tmp-file + rename) when the file's
   * accumulated line count exceeds 2x the live (deduped-by-path) row
   * count. */
  upsert: (rows: readonly TotalsCacheRow[]) => Promise<void>;
}

class TotalsCacheImpl implements TotalsCache {
  private readonly cachePath: string;
  private readonly rows: Map<string, TotalsCacheRow>;
  /** Lines physically on disk since the last compaction — always >= rows.size;
   * grows on every append, reset to rows.size on compaction. */
  private linesOnDisk: number;

  constructor(
    cachePath: string,
    rows: Map<string, TotalsCacheRow>,
    linesOnDisk: number
  ) {
    this.cachePath = cachePath;
    this.rows = rows;
    this.linesOnDisk = linesOnDisk;
  }

  lookup(ref: SessionRef): TotalsCacheRow | undefined {
    const row = this.rows.get(ref.path);
    if (!row) {
      return;
    }
    if (row.mtimeMs !== ref.mtime.getTime() || row.size !== ref.sizeBytes) {
      return;
    }
    return row;
  }

  async upsert(newRows: readonly TotalsCacheRow[]): Promise<void> {
    if (newRows.length === 0) {
      return;
    }

    for (const row of newRows) {
      this.rows.set(row.path, row);
    }

    const dir = path.dirname(this.cachePath);
    await mkdir(dir, { mode: CACHE_DIR_MODE, recursive: true });
    tightenPerms(dir, CACHE_DIR_MODE);
    const lines = `${newRows.map((r) => JSON.stringify(r)).join("\n")}\n`;
    appendFileSync(this.cachePath, lines, {
      encoding: "utf8",
      mode: CACHE_FILE_MODE,
    });
    tightenPerms(this.cachePath, CACHE_FILE_MODE);
    this.linesOnDisk += newRows.length;

    if (this.linesOnDisk > this.rows.size * 2) {
      this.compact();
    }
  }

  /** Full rewrite: live (deduped-by-path) rows only, via tmp-file + rename
   * so a crash mid-write never leaves a truncated cache file in place. */
  private compact(): void {
    const tmpPath = `${this.cachePath}.tmp-${process.pid}-${Date.now()}`;
    const body = [...this.rows.values()]
      .map((r) => JSON.stringify(r))
      .join("\n");
    writeFileSync(tmpPath, body.length > 0 ? `${body}\n` : "", {
      encoding: "utf8",
      mode: CACHE_FILE_MODE,
    });
    tightenPerms(tmpPath, CACHE_FILE_MODE); // chmod before rename, per the header note above
    renameSync(tmpPath, this.cachePath);
    this.linesOnDisk = this.rows.size;
  }
}

/** Loads the totals cache from disk. Never throws: a missing file yields an
 * empty cache; an unreadable file or corrupt lines are skipped (partial or
 * zero rows), never a crash — callers rebuild via upsert on miss regardless.
 * `cachePathOverride` is a test-only escape hatch; production callers omit
 * it and get the real XDG-resolved path. */
export async function loadCache(
  cachePathOverride?: string
): Promise<TotalsCache> {
  const cachePath = resolveCachePath(cachePathOverride);
  const rows = new Map<string, TotalsCacheRow>();
  let lineCount = 0;

  try {
    const raw = await readFile(cachePath, "utf8");
    // File existed and was readable — tighten it (and its dir) in case it was left
    // loose by a peek version predating this fix, or by umask on plain creation.
    tightenPerms(cachePath, CACHE_FILE_MODE);
    tightenPerms(path.dirname(cachePath), CACHE_DIR_MODE);
    for (const line of raw.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      lineCount += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // corrupt JSON — skip this line, keep reading
      }
      if (!isValidRow(parsed)) {
        continue; // wrong/stale shape — skip this line
      }
      rows.set(parsed.path, parsed); // last write for a path wins
    }
  } catch {
    // missing/unreadable file — start with an empty cache
  }

  return new TotalsCacheImpl(cachePath, rows, lineCount);
}
