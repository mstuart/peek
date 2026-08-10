// T5.2 gate — `peek report`'s HTML output, fixture-driven. Pipeline under
// test matches src/commands/report.ts's runReportCommand: parse ->
// dedupTurns -> computeComposition -> finalizeCompactions -> priceSession ->
// buildReportData -> renderReportHtml.

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "../../src/adapters/claude/discover.js";
import { parseClaudeSession } from "../../src/adapters/claude/parse.js";
import { discoverCodexSessions } from "../../src/adapters/codex/discover.js";
import { parseCodexSession } from "../../src/adapters/codex/parse.js";
import { RESIDUAL_LABEL } from "../../src/commands/context.js";
import { buildDiffReport, loadDiffSession } from "../../src/commands/diff.js";
import { buildReportData } from "../../src/commands/report.js";
import { priceSession } from "../../src/engine/accounting.js";
import { finalizeCompactions } from "../../src/engine/compaction.js";
import { computeComposition } from "../../src/engine/composition.js";
import { dedupTurns } from "../../src/engine/dedup.js";
import { diffSessions } from "../../src/engine/diff.js";
import type { Session } from "../../src/model/types.js";
import { renderDiffHtml, renderReportHtml } from "../../src/render/html.js";

const TEST_PATTERN_1 =
  /<script type="application\/json" id="peek-report-data">([\s\S]*?)<\/script>/;
const TEST_PATTERN_2 = /get_issue[\s\S]{0,80}\$\d/;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_FIXTURES_ROOT = join(__dirname, "../fixtures/claude-code");
const CODEX_FIXTURES_ROOT = join(__dirname, "../fixtures/codex");

async function processedClaudeSession(fixtureName: string): Promise<Session> {
  const refs = await discoverClaudeSessions([CLAUDE_FIXTURES_ROOT]);
  const ref = refs.find((r) => r.path.endsWith(`${fixtureName}.jsonl`));
  if (!ref) {
    throw new Error(`fixture ref not found: ${fixtureName}`);
  }
  const { session } = await parseClaudeSession(ref);
  const deduped: Session = { ...session, turns: dedupTurns(session.turns) };
  const finalized = finalizeCompactions(computeComposition(deduped));
  return priceSession(finalized, { mode: "auto" });
}

async function processedCodexSession(fixtureId: string): Promise<Session> {
  const refs = await discoverCodexSessions([CODEX_FIXTURES_ROOT]);
  const ref = refs.find((r) => r.id === fixtureId);
  if (!ref) {
    throw new Error(`fixture ref not found: ${fixtureId}`);
  }
  const { session } = await parseCodexSession(ref);
  const deduped: Session = { ...session, turns: dedupTurns(session.turns) };
  const finalized = finalizeCompactions(computeComposition(deduped));
  return priceSession(finalized, { mode: "auto" });
}

function usageCarryingTurnCount(session: Session): number {
  return session.turns.filter((t) => t.contextTotal > 0).length;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function assertWellFormed(html: string): void {
  expect(html.startsWith("<!doctype html>")).toBe(true);
  expect(countOccurrences(html, "<html")).toBe(1);
  expect(countOccurrences(html, "</html>")).toBe(1);
  expect(countOccurrences(html, "<body")).toBe(1);
  expect(countOccurrences(html, "</body>")).toBe(1);
}

// ---------------------------------------------------------------------------
// claude compaction fixture
// ---------------------------------------------------------------------------

describe("renderReportHtml — claude compaction fixture", () => {
  it("produces well-formed, self-contained, sanitized HTML", async () => {
    const session = await processedClaudeSession("compaction");
    const data = buildReportData(
      session,
      new Date("2026-08-08T00:00:00.000Z"),
      "0.1.0"
    );
    const html = renderReportHtml(data);

    assertWellFormed(html);

    // No external URLs whatsoever — offline, self-contained (audit R2-F3).
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");

    // Honesty conventions: residual label verbatim, ~ markers present.
    expect(html).toContain(RESIDUAL_LABEL);
    expect(html).toContain("~");

    // One stacked-bar row per usage-carrying turn.
    const usageTurns = usageCarryingTurnCount(session);
    expect(usageTurns).toBeGreaterThan(0);
    expect(countOccurrences(html, 'class="bar"')).toBe(usageTurns);

    // One per-turn expandable span-level <details> block per usage-carrying
    // turn too (v2 Lane E) — same count as the composition bars above.
    expect(countOccurrences(html, 'class="spans"')).toBe(usageTurns);

    // Compaction timeline present (this fixture has one compaction event).
    expect(data.compactions.length).toBe(1);
    expect(html).toContain("Compaction #1");
    expect(html).toContain("(exact)");

    // Fixture message content NEVER lands in the HTML — only aggregated
    // structures (categories/numbers/short identifiers) reach the page.
    expect(html).not.toContain("things go sideways");
    expect(html).not.toContain("Picking up where we left off");
  });
});

// ---------------------------------------------------------------------------
// codex full-turn fixture
// ---------------------------------------------------------------------------

describe("renderReportHtml — codex full-turn fixture", () => {
  it("produces well-formed, self-contained, sanitized HTML", async () => {
    const session = await processedCodexSession("full-turn");
    const data = buildReportData(
      session,
      new Date("2026-08-08T00:00:00.000Z"),
      "0.1.0"
    );
    const html = renderReportHtml(data);

    assertWellFormed(html);

    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");

    expect(html).toContain(RESIDUAL_LABEL);
    expect(html).toContain("~");

    const usageTurns = usageCarryingTurnCount(session);
    expect(usageTurns).toBeGreaterThan(0);
    expect(countOccurrences(html, 'class="bar"')).toBe(usageTurns);
    expect(countOccurrences(html, 'class="spans"')).toBe(usageTurns);

    // No compaction events on this fixture — graceful empty state, no
    // fabricated timeline.
    expect(data.compactions.length).toBe(0);
    expect(html).toContain("No compactions detected");

    // Tool/MCP attribution surfaces short identifiers only.
    expect(html).toContain("search_code");
    expect(html).toContain("github");

    // Fixture message content NEVER lands in the HTML.
    expect(html).not.toContain("flaky auth test");
    expect(html).not.toContain("blocking the v2 release");
    expect(html).not.toContain("release checklist");
  });

  it("--json-embed embeds the full ReportData without leaking session content", async () => {
    const session = await processedCodexSession("full-turn");
    const data = buildReportData(
      session,
      new Date("2026-08-08T00:00:00.000Z"),
      "0.1.0"
    );
    const html = renderReportHtml(data, { jsonEmbed: true });

    expect(html).toContain('<script type="application/json"');
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("flaky auth test");
  });
});

// ---------------------------------------------------------------------------
// buildReportData — pure structure assertions
// ---------------------------------------------------------------------------

describe("buildReportData", () => {
  it("headline tokens/cost/turns/compactions are exact rollups", async () => {
    const session = await processedClaudeSession("compaction");
    const data = buildReportData(
      session,
      new Date("2026-08-08T00:00:00.000Z"),
      "0.1.0"
    );
    expect(data.headline.turnCount).toBe(session.turns.length);
    expect(data.headline.compactionCount).toBe(1);
    expect(data.residualLabel).toBe(RESIDUAL_LABEL);
  });

  it("compositionTurns excludes zero-usage turns (e.g. the isApiErrorMessage record)", async () => {
    const session = await processedClaudeSession("compaction");
    const data = buildReportData(
      session,
      new Date("2026-08-08T00:00:00.000Z"),
      "0.1.0"
    );
    expect(data.compositionTurns.every((t) => t.contextTotal > 0)).toBe(true);
    expect(data.compositionTurns.length).toBe(usageCarryingTurnCount(session));
  });

  it("compositionTurns[].spans carries category/toolName/mcpServer/tokensLabel/truncated only — never a span's text", async () => {
    const session = await processedClaudeSession("tool-use-names");
    const data = buildReportData(
      session,
      new Date("2026-08-08T00:00:00.000Z"),
      "0.1.0"
    );
    const allSpans = data.compositionTurns.flatMap((t) => t.spans);
    expect(allSpans.length).toBeGreaterThan(0);
    for (const span of allSpans) {
      expect(Object.keys(span).sort()).toEqual(
        ["category", "mcpServer", "toolName", "tokensLabel", "truncated"]
          .filter((k) => k in span)
          .sort((left, right) => left.localeCompare(right))
      );
      expect(span).not.toHaveProperty("text");
      if (span.tokensLabel !== undefined) {
        expect(span.tokensLabel.startsWith("~")).toBe(true);
      }
    }

    const getIssueArgs = allSpans.find(
      (s) => s.toolName === "get_issue" && s.category === "toolCallArgs"
    );
    expect(getIssueArgs?.mcpServer).toBe("github");
    const runLintArgs = allSpans.find(
      (s) => s.toolName === "run_lint" && s.category === "toolCallArgs"
    );
    expect(runLintArgs?.mcpServer).toBe("plugin_acme-tools_linter");
  });
});

// ---------------------------------------------------------------------------
// Cost attribution tables — tool-use-names fixture (byTool/byMcpServer HTML)
// ---------------------------------------------------------------------------

describe("renderReportHtml — cost attribution tables (tool-use-names fixture)", () => {
  it("byTool/byMcpServer rows render with the ~-prefixed honesty labels, no per-tool cost, no leaked content", async () => {
    const session = await processedClaudeSession("tool-use-names");
    const data = buildReportData(
      session,
      new Date("2026-08-08T00:00:00.000Z"),
      "0.1.0"
    );
    const html = renderReportHtml(data);

    assertWellFormed(html);
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");

    // byTool: get_issue under github, run_lint under the plugin server —
    // same grouping compaction-attribution.test.ts verifies against the raw
    // rollup (engine/attribution.ts), now surfaced in the HTML table.
    const getIssue = data.byTool.find((t) => t.name === "get_issue");
    expect(getIssue?.mcpServer).toBe("github");
    expect(getIssue?.tokenShareLabel).toBe("~39");
    const runLint = data.byTool.find((t) => t.name === "run_lint");
    expect(runLint?.mcpServer).toBe("plugin_acme-tools_linter");
    expect(html).toContain("get_issue");
    expect(html).toContain("run_lint");
    expect(html).toContain("~39");

    // byMcpServer: both servers present with their tool lists.
    const github = data.byMcpServer.find((s) => s.mcpServer === "github");
    expect(github?.tools).toEqual(["get_issue"]);
    expect(html).toContain("plugin_acme-tools_linter");

    // Honesty convention: never a per-tool/per-server dollar figure.
    expect(html).not.toMatch(TEST_PATTERN_2);

    // Fixture message content NEVER lands in the HTML (this fixture's
    // tool_result payloads carry JSON strings, not prose, but the prompt
    // text itself must still never leak).
    expect(html).not.toContain("Check open GitHub issue #42");
    expect(html).not.toContain("Flaky test in CI");
  });
});

// ---------------------------------------------------------------------------
// renderDiffHtml — `peek report --diff <a> <b>` (v2 Lane E)
// ---------------------------------------------------------------------------

async function loadDiffFixtureClaude(fixtureName: string): Promise<Session> {
  const refs = await discoverClaudeSessions([CLAUDE_FIXTURES_ROOT]);
  const ref = refs.find((r) => r.path.endsWith(`${fixtureName}.jsonl`));
  if (!ref) {
    throw new Error(`fixture ref not found: ${fixtureName}`);
  }
  return loadDiffSession(ref);
}

async function loadDiffFixtureCodex(fixtureId: string): Promise<Session> {
  const refs = await discoverCodexSessions([CODEX_FIXTURES_ROOT]);
  const ref = refs.find((r) => r.id === fixtureId);
  if (!ref) {
    throw new Error(`fixture ref not found: ${fixtureId}`);
  }
  return loadDiffSession(ref);
}

describe("renderDiffHtml", () => {
  it("comparable claude/claude pair: well-formed, self-contained, sanitized, no warning banner", async () => {
    const a = await loadDiffFixtureClaude("cache-heavy");
    const b = await loadDiffFixtureClaude("compaction");
    const report = buildDiffReport(diffSessions(a, b));
    const html = renderDiffHtml(report, {
      generatedAtISO: "2026-08-08T00:00:00.000Z",
      peekVersion: "0.1.0",
    });

    assertWellFormed(html);
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");

    expect(report.comparabilityWarnings).toEqual([]);
    expect(html).not.toContain('class="warning-banner"');

    // Meta/totals/composition/config sections all present.
    expect(html).toContain("cache-heavy");
    expect(html).toContain("compaction");
    expect(html).toContain(report.residual.label);
    expect(html).toContain("+14,850"); // inputUncached delta (diff-command.test.ts's own figure)

    // Fixture message content NEVER lands in the HTML.
    expect(html).not.toContain("Loading the repo into cache for analysis");
    expect(html).not.toContain("things go sideways");
    expect(html).not.toContain("Picking up where we left off");
  });

  it("divergent claude/codex pair: comparability warning banner present, no leaks", async () => {
    const a = await loadDiffFixtureClaude("cache-heavy");
    const b = await loadDiffFixtureCodex("full-turn");
    const report = buildDiffReport(diffSessions(a, b));
    const html = renderDiffHtml(report);

    assertWellFormed(html);
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");

    expect(report.comparabilityWarnings.length).toBeGreaterThan(0);
    expect(html).toContain('class="warning-banner"');
    expect(html).toContain("harness differs: a=claude-code b=codex");

    // Fixture message content NEVER lands in the HTML.
    expect(html).not.toContain("Loading the repo into cache for analysis");
    expect(html).not.toContain("flaky auth test");
    expect(html).not.toContain("blocking the v2 release");
  });
});

// ---------------------------------------------------------------------------
// --json-embed escaping (XSS fix): a field value containing "</script>"
// must never close the embed's own <script> tag early.
// ---------------------------------------------------------------------------

describe("renderReportHtml — --json-embed script-breakout escaping", () => {
  it("a cwd containing `</script><img onerror=...>` cannot break out of the embed block", async () => {
    const session = await processedClaudeSession("compaction");
    const payload = '</script><img src=x onerror="alert(1)">';
    const data = buildReportData(
      { ...session, cwd: payload },
      new Date("2026-08-08T00:00:00.000Z"),
      "0.1.0"
    );
    const html = renderReportHtml(data, { jsonEmbed: true });

    assertWellFormed(html);
    // Exactly one literal "</script>" in the whole document: the embed
    // block's own closing tag. If the payload's "</script>" had survived
    // unescaped inside the JSON text, this would be 2.
    expect(countOccurrences(html, "</script>")).toBe(1);
    // No live <img> element anywhere — the payload only ever appears as
    // escaped text (HTML-entity-escaped in the header row, <-escaped
    // inside the JSON embed).
    expect(html).not.toContain("<img");

    // The parsed-back JSON still round-trips the original value exactly —
    // the escape is reversible, not lossy.
    const match = html.match(TEST_PATTERN_1);
    expect(match).not.toBeNull();
    const embedded = JSON.parse(match?.[1] ?? "");
    expect(embedded.cwd).toBe(payload);
  });
});

// ---------------------------------------------------------------------------
// Working-directory row: shortened, not the raw absolute path (path
// disclosure fix).
// ---------------------------------------------------------------------------

describe("renderReportHtml — Working directory row is shortened", () => {
  it("a cwd under the real home directory renders with a ~ prefix, not the raw home path", async () => {
    const session = await processedClaudeSession("compaction");
    const cwd = `${homedir()}/git/some-project`;
    const data = buildReportData(
      { ...session, cwd },
      new Date("2026-08-08T00:00:00.000Z"),
      "0.1.0"
    );
    const html = renderReportHtml(data);

    expect(html).toContain("~/git/some-project");
    expect(html).not.toContain(homedir());
  });

  it("a long path outside home is mid-truncated rather than shown in full", async () => {
    const session = await processedClaudeSession("compaction");
    const cwd =
      "/very/deeply/nested/path/that/goes/on/for/a/very/long/while/project";
    const data = buildReportData(
      { ...session, cwd },
      new Date("2026-08-08T00:00:00.000Z"),
      "0.1.0"
    );
    const html = renderReportHtml(data);

    expect(html).not.toContain(cwd);
    expect(html).toContain("…");
  });
});
