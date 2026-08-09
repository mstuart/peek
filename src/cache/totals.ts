// Totals cache (v2 PLAN Lane B, docs/DESIGN.md + docs/PERF.md fix #3) — the
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

import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SessionTotals } from "../engine/accounting.js";
import { sessionTotals } from "../engine/accounting.js";
import type { HarnessId, Session, SessionRef } from "../model/types.js";

export interface TotalsCacheRow {
  path: string;
  mtimeMs: number;
  size: number;
  harness: HarnessId;
  totals: SessionTotals;
  turns: number;
  compactions: number;
  startedAt: string; // ISO — cache rows are plain JSON, not USM Session objects
  endedAt: string;
  cwd: string;
  model: string;
}

/** Builds a cache row from an already deduped+priced session (list's
 * loadEntries pipeline: parse -> dedupSession -> priceSession). Mirrors
 * exactly what commands/list.ts's buildListRow reads off a Session. */
export function toCacheRow(ref: SessionRef, session: Session): TotalsCacheRow {
  return {
    path: ref.path,
    mtimeMs: ref.mtime.getTime(),
    size: ref.sizeBytes,
    harness: ref.harness,
    totals: sessionTotals(session),
    turns: session.turns.length,
    compactions: session.events.filter((e) => e.kind === "compaction").length,
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt.toISOString(),
    cwd: session.cwd,
    model: session.configSnapshot.model,
  };
}

const HARNESS_IDS = new Set<HarnessId>(["claude-code", "codex", "pi"]);

function isValidRow(value: unknown): value is TotalsCacheRow {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.path !== "string") return false;
  if (typeof r.mtimeMs !== "number") return false;
  if (typeof r.size !== "number") return false;
  if (typeof r.harness !== "string" || !HARNESS_IDS.has(r.harness as HarnessId))
    return false;
  if (typeof r.turns !== "number") return false;
  if (typeof r.compactions !== "number") return false;
  if (typeof r.startedAt !== "string") return false;
  if (typeof r.endedAt !== "string") return false;
  if (typeof r.cwd !== "string") return false;
  if (typeof r.model !== "string") return false;

  if (typeof r.totals !== "object" || r.totals === null) return false;
  const totals = r.totals as Record<string, unknown>;
  if (typeof totals.cost !== "number") return false;
  if (typeof totals.priced !== "boolean") return false;
  if (typeof totals.tokens !== "object" || totals.tokens === null) return false;
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
    if (typeof tokens[key] !== "number") return false;
  }
  return true;
}

/** `${XDG_CACHE_HOME ?? ~/.cache}/peek/totals-v1.jsonl`. */
function resolveCachePath(override?: string): string {
  if (override) return override;
  const base = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(base, "peek", "totals-v1.jsonl");
}

export interface TotalsCache {
  /** A row matches only when path+mtimeMs+size ALL match `ref` — any drift
   * (file touched, resized, or the ref pointing somewhere else entirely) is
   * treated as a miss, never a stale hit. */
  lookup(ref: SessionRef): TotalsCacheRow | undefined;
  /** Appends `rows` to the on-disk cache and updates the in-memory index.
   * Triggers a full compaction rewrite (tmp-file + rename) when the file's
   * accumulated line count exceeds 2x the live (deduped-by-path) row
   * count. */
  upsert(rows: readonly TotalsCacheRow[]): Promise<void>;
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
    linesOnDisk: number,
  ) {
    this.cachePath = cachePath;
    this.rows = rows;
    this.linesOnDisk = linesOnDisk;
  }

  lookup(ref: SessionRef): TotalsCacheRow | undefined {
    const row = this.rows.get(ref.path);
    if (!row) return undefined;
    if (row.mtimeMs !== ref.mtime.getTime() || row.size !== ref.sizeBytes) {
      return undefined;
    }
    return row;
  }

  async upsert(newRows: readonly TotalsCacheRow[]): Promise<void> {
    if (newRows.length === 0) return;

    for (const row of newRows) this.rows.set(row.path, row);

    await mkdir(path.dirname(this.cachePath), { recursive: true });
    const lines = `${newRows.map((r) => JSON.stringify(r)).join("\n")}\n`;
    appendFileSync(this.cachePath, lines, "utf8");
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
    writeFileSync(tmpPath, body.length > 0 ? `${body}\n` : "", "utf8");
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
  cachePathOverride?: string,
): Promise<TotalsCache> {
  const cachePath = resolveCachePath(cachePathOverride);
  const rows = new Map<string, TotalsCacheRow>();
  let lineCount = 0;

  try {
    const raw = await readFile(cachePath, "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      lineCount++;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // corrupt JSON — skip this line, keep reading
      }
      if (!isValidRow(parsed)) continue; // wrong/stale shape — skip this line
      rows.set(parsed.path, parsed); // last write for a path wins
    }
  } catch {
    // missing/unreadable file — start with an empty cache
  }

  return new TotalsCacheImpl(cachePath, rows, lineCount);
}
