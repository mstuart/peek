// Lane B (docs/DESIGN.md § Other v2 subsystems) gate — cache/totals.ts unit tests + list pipeline
// integration. Mirrors test/unit/commands.test.ts's fixture-loading
// conventions where relevant.

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "../../src/adapters/claude/discover.js";
import { parseClaudeSession } from "../../src/adapters/claude/parse.js";
import {
  type TotalsCacheRow,
  loadCache,
  toCacheRow,
} from "../../src/cache/totals.js";
import {
  type ListCommandOptions,
  buildListReport,
  loadEntries,
} from "../../src/commands/list.js";
import { priceSession, sessionTotals } from "../../src/engine/accounting.js";
import { dedupSession } from "../../src/engine/dedup.js";
import type { HarnessId, SessionRef } from "../../src/model/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_FIXTURES_ROOT = join(__dirname, "../fixtures/claude-code");

function makeRow(overrides: Partial<TotalsCacheRow> = {}): TotalsCacheRow {
  return {
    path: "/fake/session.jsonl",
    mtimeMs: 1000,
    size: 500,
    harness: "claude-code" as HarnessId,
    totals: {
      tokens: {
        inputUncached: 10,
        cacheRead: 20,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 30,
        contextTotal: 60,
      },
      cost: 1.23,
      priced: true,
    },
    turns: 4,
    compactions: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
    cwd: "/fake",
    model: "claude-fake",
    ...overrides,
  };
}

function refFor(row: TotalsCacheRow): SessionRef {
  return {
    harness: row.harness,
    id: "fake",
    path: row.path,
    sizeBytes: row.size,
    mtime: new Date(row.mtimeMs),
    kind: "main",
  };
}

describe("cache/totals", () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "peek-totals-cache-"));
    cachePath = join(dir, "nested", "totals-v1.jsonl");
  });

  it("misses on an empty/missing cache file", async () => {
    const cache = await loadCache(cachePath);
    expect(cache.lookup(refFor(makeRow()))).toBeUndefined();
  });

  it("hits when path+mtimeMs+size all match", async () => {
    const cache = await loadCache(cachePath);
    const row = makeRow();
    await cache.upsert([row]);
    expect(cache.lookup(refFor(row))).toEqual(row);

    // A fresh load from disk sees the same row.
    const reloaded = await loadCache(cachePath);
    expect(reloaded.lookup(refFor(row))).toEqual(row);
  });

  it("misses when mtime changed", async () => {
    const cache = await loadCache(cachePath);
    const row = makeRow();
    await cache.upsert([row]);
    const staleRef = refFor(row);
    staleRef.mtime = new Date(row.mtimeMs + 1);
    expect(cache.lookup(staleRef)).toBeUndefined();
  });

  it("misses when size changed", async () => {
    const cache = await loadCache(cachePath);
    const row = makeRow();
    await cache.upsert([row]);
    const staleRef = refFor(row);
    staleRef.sizeBytes = row.size + 1;
    expect(cache.lookup(staleRef)).toBeUndefined();
  });

  it("misses when path doesn't match any row", async () => {
    const cache = await loadCache(cachePath);
    await cache.upsert([makeRow()]);
    expect(
      cache.lookup(refFor(makeRow({ path: "/fake/other.jsonl" }))),
    ).toBeUndefined();
  });

  it("skips corrupt lines and keeps valid ones on load", async () => {
    const good = makeRow();
    const badShape = { path: "/fake/bad.jsonl" }; // missing required fields
    const lines = [
      JSON.stringify(good),
      "not json at all {{{",
      JSON.stringify(badShape),
      "", // blank line, should be skipped silently
    ].join("\n");
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${lines}\n`, "utf8");

    const cache = await loadCache(cachePath);
    expect(cache.lookup(refFor(good))).toEqual(good);
    expect(
      cache.lookup(
        refFor(makeRow({ path: "/fake/bad.jsonl", mtimeMs: 0, size: 0 })),
      ),
    ).toBeUndefined();
  });

  it("treats a totally unreadable/garbage file as an empty cache", async () => {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, "{{{ not even close to jsonl", "utf8");
    const cache = await loadCache(cachePath);
    // The single garbage line is skipped; cache behaves as empty.
    expect(cache.lookup(refFor(makeRow()))).toBeUndefined();
    // And it's still writable afterward.
    await cache.upsert([makeRow()]);
    expect(cache.lookup(refFor(makeRow()))).toEqual(makeRow());
  });

  it("last write for a path wins across multiple upserts", async () => {
    const cache = await loadCache(cachePath);
    const v1 = makeRow({ mtimeMs: 1000, size: 500 });
    const v2 = makeRow({ mtimeMs: 2000, size: 600 });
    await cache.upsert([v1]);
    await cache.upsert([v2]);
    expect(cache.lookup(refFor(v1))).toBeUndefined(); // stale
    expect(cache.lookup(refFor(v2))).toEqual(v2);

    const reloaded = await loadCache(cachePath);
    expect(reloaded.lookup(refFor(v2))).toEqual(v2);
  });

  it("compacts the on-disk file once accumulated lines exceed 2x live rows", async () => {
    const cache = await loadCache(cachePath);
    const row = makeRow();

    // Repeatedly upsert the SAME path with a changing mtime: each upsert
    // appends a line but live rows stay at 1, so linesOnDisk grows past
    // 2x live rows and triggers a compaction rewrite.
    for (let i = 0; i < 5; i++) {
      await cache.upsert([{ ...row, mtimeMs: row.mtimeMs + i }]);
    }

    const raw = await readFile(cachePath, "utf8");
    const lineCount = raw.split("\n").filter((l) => l.trim() !== "").length;
    // After compaction, only live (deduped-by-path) rows remain on disk —
    // far fewer than the 5 appends that happened.
    expect(lineCount).toBeLessThan(5);
    expect(lineCount).toBe(1);

    // The cache still correctly reflects the latest row after compaction.
    const latest = { ...row, mtimeMs: row.mtimeMs + 4 };
    expect(cache.lookup(refFor(latest))).toEqual(latest);
  });

  it("toCacheRow mirrors sessionTotals/turns/compactions off a real session", async () => {
    const refs = await discoverClaudeSessions([CLAUDE_FIXTURES_ROOT]);
    const ref = refs.find((r) => r.path.endsWith("normal-turns.jsonl"));
    if (!ref) throw new Error("fixture ref not found: normal-turns");
    const { session } = await parseClaudeSession(ref, { spans: false });
    const priced = priceSession(dedupSession(session), { mode: "auto" });

    const row = toCacheRow(ref, priced);
    expect(row.totals).toEqual(sessionTotals(priced));
    expect(row.turns).toBe(priced.turns.length);
    expect(row.path).toBe(ref.path);
    expect(row.mtimeMs).toBe(ref.mtime.getTime());
    expect(row.size).toBe(ref.sizeBytes);
  });
});

// ---------------------------------------------------------------------------
// list.ts's loadEntries wired against the cache, over real fixtures copied
// into a scratch discovery root (so mutating mtime for the "re-parse on
// change" assertion never touches the checked-in fixtures).
// ---------------------------------------------------------------------------

describe("list.ts loadEntries + totals cache integration", () => {
  let scratchRoot: string;
  let xdgCacheHome: string;
  let prevXdgCacheHome: string | undefined;

  beforeEach(() => {
    scratchRoot = mkdtempSync(join(tmpdir(), "peek-list-fixtures-"));
    cpSync(
      join(CLAUDE_FIXTURES_ROOT, "v2.1.104"),
      join(scratchRoot, "v2.1.104"),
      {
        recursive: true,
      },
    );
    xdgCacheHome = mkdtempSync(join(tmpdir(), "peek-xdg-cache-"));
    prevXdgCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = xdgCacheHome;
  });

  afterEach(() => {
    if (prevXdgCacheHome === undefined) {
      Reflect.deleteProperty(process.env, "XDG_CACHE_HOME");
    } else {
      process.env.XDG_CACHE_HOME = prevXdgCacheHome;
    }
  });

  function opts(extra: Partial<ListCommandOptions> = {}): ListCommandOptions {
    return { roots: { "claude-code": [scratchRoot] }, ...extra };
  }

  it("first call is all misses, second call (same files) is all hits", async () => {
    const first = await loadEntries(opts());
    expect(first.entries.length).toBeGreaterThan(0);
    expect(first.cacheStats).toBeDefined();
    expect(first.cacheStats?.misses).toBe(first.entries.length);
    expect(first.cacheStats?.hits).toBe(0);
    // Cache-miss entries are freshly parsed — they carry `session`, not `cached`.
    for (const e of first.entries) expect("session" in e).toBe(true);

    const second = await loadEntries(opts());
    expect(second.cacheStats?.hits).toBe(first.entries.length);
    expect(second.cacheStats?.misses).toBe(0);
    for (const e of second.entries) expect("cached" in e).toBe(true);

    // Row content is equivalent regardless of hit/miss path.
    expect(buildListReport(second.entries)).toEqual(
      buildListReport(first.entries),
    );
  });

  it("re-parses a file whose mtime changed since the cached row", async () => {
    const first = await loadEntries(opts());
    const total = first.entries.length;
    expect(total).toBeGreaterThan(1);

    // Touch exactly one fixture file's mtime forward.
    const touched = join(scratchRoot, "v2.1.104", "normal-turns.jsonl");
    const future = new Date(Date.now() + 60_000);
    utimesSync(touched, future, future);

    const second = await loadEntries(opts());
    expect(second.cacheStats?.misses).toBe(1);
    expect(second.cacheStats?.hits).toBe(total - 1);
  });

  it("--no-cache (cache: false) bypasses the cache entirely", async () => {
    const first = await loadEntries(opts({ cache: false }));
    expect(first.cacheStats).toBeUndefined();
    for (const e of first.entries) expect("session" in e).toBe(true);

    const second = await loadEntries(opts({ cache: false }));
    expect(second.cacheStats).toBeUndefined();
    for (const e of second.entries) expect("session" in e).toBe(true); // still fresh, never cached
  });
});
