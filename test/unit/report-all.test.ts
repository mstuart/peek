// `peek report --all` (cross-session trends dashboard) gate.
//
// buildDashboardData is tested directly against SYNTHETIC CachedListEntry
// fixtures, built the same way test/unit/cache.test.ts's makeRow/refFor do.
// Cache rows (cache/totals.ts's TotalsCacheRow) ARE this dashboard's data
// source (commands/list.ts's loadEntries cache-hit path), so synthesizing
// them here is the idiomatic way to get deterministic control over day/
// model/harness/priced diversity without needing N real session fixtures
// for every branch (day bucketing, top-5+other, unpriced honesty note).
//
// A second suite wires runReportAllCommand end-to-end against real
// claude-code + codex fixtures and a tmp XDG_CACHE_HOME (mirrors
// cache.test.ts's list.ts integration pattern) to gate CLI flag plumbing.

import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TotalsCacheRow } from "../../src/cache/totals.js";
import type {
  CachedListEntry,
  ListReportEntry,
} from "../../src/commands/list.js";
import {
  buildDashboardData,
  runReportAllCommand,
} from "../../src/commands/report.js";
import type { SessionRef } from "../../src/model/types.js";
import { renderDashboardHtml } from "../../src/render/dashboardHtml.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_FIXTURES_ROOT = join(__dirname, "../fixtures/claude-code");
const CODEX_FIXTURES_ROOT = join(__dirname, "../fixtures/codex");

function makeCacheRow(overrides: Partial<TotalsCacheRow> = {}): TotalsCacheRow {
  return {
    path: "/fake/session.jsonl",
    mtimeMs: 1000,
    size: 500,
    harness: "claude-code",
    totals: {
      tokens: {
        inputUncached: 100,
        cacheRead: 200,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 50,
        contextTotal: 350,
      },
      cost: 1.5,
      priced: true,
    },
    turns: 4,
    compactions: 0,
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:05:00.000Z",
    cwd: "/fake/project-a",
    model: "claude-fake",
    ...overrides,
  };
}

function makeEntry(row: TotalsCacheRow, id = "fake"): CachedListEntry {
  const ref: SessionRef = {
    harness: row.harness,
    id,
    path: row.path,
    sizeBytes: row.size,
    mtime: new Date(row.mtimeMs),
    kind: "main",
  };
  return { ref, cached: row };
}

describe("buildDashboardData", () => {
  it("buckets sessions by UTC day", () => {
    const entries: ListReportEntry[] = [
      makeEntry(
        makeCacheRow({ path: "/a", startedAt: "2026-08-01T23:59:00.000Z" }),
        "a",
      ),
      makeEntry(
        makeCacheRow({ path: "/b", startedAt: "2026-08-02T00:01:00.000Z" }),
        "b",
      ),
    ];
    const data = buildDashboardData(
      entries,
      {},
      new Date("2026-08-08T00:00:00.000Z"),
      "0.1.0",
    );
    expect(data.days).toEqual(["2026-08-01", "2026-08-02"]);
    expect(data.headline.activeDays).toBe(2);
  });

  it("stacks the top-5 models by cost and lumps the rest into 'other'", () => {
    const models = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"];
    const entries: ListReportEntry[] = models.map((m, i) =>
      makeEntry(
        makeCacheRow({
          path: `/session-${i}`,
          model: m,
          startedAt: "2026-08-01T00:00:00.000Z",
          totals: {
            tokens: {
              inputUncached: 10,
              cacheRead: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
              output: 10,
              contextTotal: 20,
            },
            cost: 10 - i, // descending: m1=10 ... m7=4, so top-5 = m1..m5
            priced: true,
          },
        }),
        `s${i}`,
      ),
    );
    const data = buildDashboardData(entries, {}, new Date(), "0.1.0");
    const modelNames = data.dailyCost.map((s) => s.model);
    expect(modelNames).toEqual(["m1", "m2", "m3", "m4", "m5", "other"]);

    const otherSeries = data.dailyCost.find((s) => s.model === "other");
    // m6 (cost 5) + m7 (cost 4) = 9
    expect(otherSeries?.costsByDay[0]).toBeCloseTo(9);

    const m1Series = data.dailyCost.find((s) => s.model === "m1");
    expect(m1Series?.costsByDay[0]).toBeCloseTo(10);
  });

  it("does not add an 'other' bucket when 5 or fewer models are present", () => {
    const entries: ListReportEntry[] = ["m1", "m2"].map((m, i) =>
      makeEntry(makeCacheRow({ path: `/s${i}`, model: m }), `s${i}`),
    );
    const data = buildDashboardData(entries, {}, new Date(), "0.1.0");
    expect(data.dailyCost.map((s) => s.model)).toEqual(["m1", "m2"]);
  });

  it("excludes unpriced sessions from cost totals but counts them in the honesty note", () => {
    const entries: ListReportEntry[] = [
      makeEntry(
        makeCacheRow({
          path: "/priced",
          totals: {
            tokens: {
              inputUncached: 10,
              cacheRead: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
              output: 0,
              contextTotal: 10,
            },
            cost: 5,
            priced: true,
          },
        }),
        "p",
      ),
      makeEntry(
        makeCacheRow({
          path: "/unpriced",
          totals: {
            tokens: {
              inputUncached: 10,
              cacheRead: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
              output: 0,
              contextTotal: 10,
            },
            cost: 0,
            priced: false,
          },
        }),
        "u",
      ),
    ];
    const data = buildDashboardData(entries, {}, new Date(), "0.1.0");
    expect(data.headline.unpricedSessionCount).toBe(1);
    expect(data.headline.totalSessions).toBe(2);
    expect(data.headline.totalCostLabel).toBe("$5.00");
  });

  it("caps day buckets to the trailing 30 days without --since, widens with it", () => {
    const entries: ListReportEntry[] = Array.from({ length: 35 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1 + i));
      return makeEntry(
        makeCacheRow({ path: `/d${i}`, startedAt: d.toISOString() }),
        `d${i}`,
      );
    });

    const uncapped = buildDashboardData(entries, {}, new Date(), "0.1.0");
    expect(uncapped.days.length).toBe(30);
    // headline reflects the FULL entry set regardless of the chart cap.
    expect(uncapped.headline.totalSessions).toBe(35);
    expect(uncapped.headline.activeDays).toBe(35);

    const widened = buildDashboardData(
      entries,
      { since: new Date(Date.UTC(2026, 0, 1)) },
      new Date(),
      "0.1.0",
    );
    expect(widened.days.length).toBe(35);
  });

  it("per-harness rollup includes both harnesses when both are present", () => {
    const entries: ListReportEntry[] = [
      makeEntry(makeCacheRow({ path: "/c", harness: "claude-code" }), "c"),
      makeEntry(
        makeCacheRow({ path: "/x", harness: "codex", model: "gpt-x" }),
        "x",
      ),
    ];
    const data = buildDashboardData(entries, {}, new Date(), "0.1.0");
    const harnesses = data.perHarness.map((r) => r.harness);
    expect(harnesses).toContain("claude-code");
    expect(harnesses).toContain("codex");
  });

  it("per-project table is top-15 by cost and shortens ~-prefixed home paths", () => {
    const entries: ListReportEntry[] = Array.from({ length: 20 }, (_, i) =>
      makeEntry(
        makeCacheRow({
          path: `/proj${i}`,
          cwd: `/fake/project-${i}`,
          totals: {
            tokens: {
              inputUncached: 1,
              cacheRead: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
              output: 0,
              contextTotal: 1,
            },
            cost: i, // ascending — top 15 by cost excludes the 5 cheapest
            priced: true,
          },
        }),
        `p${i}`,
      ),
    );
    const data = buildDashboardData(entries, {}, new Date(), "0.1.0");
    expect(data.perProject.length).toBe(15);
    expect(data.perProject[0]?.costLabel).toBe("$19.00");
  });
});

describe("renderDashboardHtml", () => {
  it("produces well-formed, self-contained HTML — no external URLs, no <script>", () => {
    const entries: ListReportEntry[] = [
      makeEntry(makeCacheRow({ path: "/a" }), "a"),
      makeEntry(
        makeCacheRow({ path: "/b", harness: "codex", model: "gpt-x" }),
        "b",
      ),
    ];
    const data = buildDashboardData(
      entries,
      {},
      new Date("2026-08-08T00:00:00.000Z"),
      "0.1.0",
    );
    const html = renderDashboardHtml(data);

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("<script");
    expect(html).toContain("claude-code");
    expect(html).toContain("codex");
  });

  it("renders an honest empty state with zero sessions", () => {
    const data = buildDashboardData(
      [],
      {},
      new Date("2026-08-08T00:00:00.000Z"),
      "0.1.0",
    );
    const html = renderDashboardHtml(data);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("<script");
    expect(html).toContain("No sessions found");
  });
});

// ---------------------------------------------------------------------------
// runReportAllCommand — CLI flag plumbing against real fixtures + a tmp
// XDG_CACHE_HOME (mirrors cache.test.ts's list.ts integration pattern).
// ---------------------------------------------------------------------------

describe("runReportAllCommand", () => {
  let xdgCacheHome: string;
  let prevXdgCacheHome: string | undefined;
  let outDir: string;

  beforeEach(() => {
    xdgCacheHome = mkdtempSync(join(tmpdir(), "peek-xdg-cache-"));
    prevXdgCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = xdgCacheHome;
    outDir = mkdtempSync(join(tmpdir(), "peek-dashboard-out-"));
  });

  afterEach(async () => {
    if (prevXdgCacheHome === undefined) {
      Reflect.deleteProperty(process.env, "XDG_CACHE_HOME");
    } else {
      process.env.XDG_CACHE_HOME = prevXdgCacheHome;
    }
    await rm(outDir, { recursive: true, force: true });
  });

  it("writes a dashboard HTML file covering claude-code and codex fixtures", async () => {
    const outputPath = join(outDir, "dashboard.html");
    await runReportAllCommand({
      output: outputPath,
      roots: {
        "claude-code": [CLAUDE_FIXTURES_ROOT],
        codex: [CODEX_FIXTURES_ROOT],
      },
    });
    const html = await readFile(outputPath, "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("<script");
    expect(html).toContain("claude-code");
    expect(html).toContain("codex");
  });

  it("--harness filters the dashboard to a single harness", async () => {
    const outputPath = join(outDir, "dashboard-claude-only.html");
    await runReportAllCommand({
      output: outputPath,
      harness: "claude-code",
      roots: {
        "claude-code": [CLAUDE_FIXTURES_ROOT],
        codex: [CODEX_FIXTURES_ROOT],
      },
    });
    const html = await readFile(outputPath, "utf8");
    expect(html).toContain("claude-code");
    expect(html).not.toContain(">codex<");
  });

  it("defaults the output path to ./peek-dashboard.html when -o is omitted", async () => {
    const prevCwd = process.cwd();
    process.chdir(outDir);
    try {
      await runReportAllCommand({
        roots: { "claude-code": [CLAUDE_FIXTURES_ROOT] },
      });
      const html = await readFile(join(outDir, "peek-dashboard.html"), "utf8");
      expect(html.startsWith("<!doctype html>")).toBe(true);
    } finally {
      process.chdir(prevCwd);
    }
  });
});
