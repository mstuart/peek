// T3.1 gate — fixture-driven tests for `peek list` / `peek cost` /
// `peek compactions`'s pure cores: buildListReport, buildCostReport,
// buildCompactionsReport. Mirrors test/unit/context-command.test.ts's and
// test/unit/compaction-attribution.test.ts's fixture-loading conventions
// (discover -> find ref -> parse -> dedup[/price/finalize]).

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "../../src/adapters/claude/discover.js";
import { parseClaudeSession } from "../../src/adapters/claude/parse.js";
import { discoverCodexSessions } from "../../src/adapters/codex/discover.js";
import { parseCodexSession } from "../../src/adapters/codex/parse.js";
import { parsePiSession } from "../../src/adapters/pi/parse.js";
import {
  buildCompactionsReport,
  loadFinalizedSession,
} from "../../src/commands/compactions.js";
import {
  type CostAllEntry,
  buildCostAllReport,
  buildCostReport,
  loadPricedSession,
  runCostCommand,
} from "../../src/commands/cost.js";
import {
  DEFAULT_LIST_LIMIT,
  type ListEntry,
  buildListReport,
  runListCommand,
} from "../../src/commands/list.js";
import { resolveSessionRef } from "../../src/commands/shared.js";
import { priceSession } from "../../src/engine/accounting.js";
import {
  byMcpServer,
  byModel,
  bySubagent,
  byTool,
  mergeAttribution,
} from "../../src/engine/attribution.js";
import { finalizeCompactions } from "../../src/engine/compaction.js";
import { dedupSession } from "../../src/engine/dedup.js";
import type { Session, SessionRef } from "../../src/model/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_FIXTURES_ROOT = join(__dirname, "../fixtures/claude-code");
const CODEX_FIXTURES_ROOT = join(__dirname, "../fixtures/codex");
const PI_FIXTURES_ROOT = join(__dirname, "../fixtures/pi");

interface RefAndSession {
  ref: SessionRef;
  session: Session; // deduped, unpriced, unfinalized — callers add stages
}

async function dedupedClaudeSession(
  fixtureName: string,
  root: string = CLAUDE_FIXTURES_ROOT,
): Promise<RefAndSession> {
  const refs = await discoverClaudeSessions([root]);
  const ref = refs.find((r) => r.path.endsWith(`${fixtureName}.jsonl`));
  if (!ref) throw new Error(`fixture ref not found: ${fixtureName}`);
  const { session } = await parseClaudeSession(ref);
  return { ref, session: dedupSession(session) };
}

async function dedupedCodexSession(fixtureId: string): Promise<RefAndSession> {
  const refs = await discoverCodexSessions([CODEX_FIXTURES_ROOT]);
  const ref = refs.find((r) => r.id === fixtureId);
  if (!ref) throw new Error(`fixture ref not found: ${fixtureId}`);
  const { session } = await parseCodexSession(ref);
  return { ref, session: dedupSession(session) };
}

function piRef(id: string, filename: string): SessionRef {
  return {
    harness: "pi",
    id,
    path: join(
      PI_FIXTURES_ROOT,
      "system-a-v3/--Users-fake-project--",
      filename,
    ),
    sizeBytes: 0,
    mtime: new Date(0),
    kind: "main",
  };
}

async function dedupedPiSession(ref: SessionRef): Promise<RefAndSession> {
  const { session } = await parsePiSession(ref);
  return { ref, session: dedupSession(session) };
}

/** Parent + subagent child of the dedup-family fixture (dedup-family.test.ts's
 * own family: v2.1.225/20000000-…0001.jsonl + its subagents/agent-abc123.jsonl
 * child — the child's trailing turn replays the parent's msg-0001/req-0001
 * turn verbatim), deduped + priced. Used to verify mergeAttribution excludes
 * that replayed turn's spans instead of double-counting them (the latent risk
 * flagged in the 2026-08-08 engine review — see attribution.ts's
 * mergeAttribution doc comment). */
async function dedupFamilyFixture(): Promise<[Session, Session]> {
  const all = await discoverClaudeSessions([CLAUDE_FIXTURES_ROOT]);
  const parentRef = all.find(
    (r) =>
      r.id === "20000000-2000-4200-8200-200000000001" &&
      r.path.includes(`${sep}v2.1.225${sep}`),
  );
  if (!parentRef)
    throw new Error("fixture ref not found: v2.1.225 family parent");
  const { session: parentRaw } = await parseClaudeSession(parentRef);
  const childRef = parentRaw.children[0];
  if (!childRef)
    throw new Error("unreachable: family fixture has no child ref");
  const { session: childRaw } = await parseClaudeSession(childRef);

  const parent = priceSession(dedupSession(parentRaw), { mode: "auto" });
  const child = priceSession(dedupSession(childRaw), { mode: "auto" });
  return [parent, child];
}

// ---------------------------------------------------------------------------
// buildListReport
// ---------------------------------------------------------------------------

describe("buildListReport", () => {
  it("one row per session, sorted mtime desc, across all three harnesses", async () => {
    const claude = await dedupedClaudeSession("cache-heavy");
    const codex = await dedupedCodexSession("full-turn");
    const pi = await dedupedPiSession(
      piRef(
        "cb5b132f-2542-40b3-a7c9-49ffc431e30b",
        "2026-08-01T10-00-00-000Z_cb5b132f-2542-40b3-a7c9-49ffc431e30b.jsonl",
      ),
    );

    const entries: ListEntry[] = [
      {
        ref: { ...claude.ref, mtime: new Date(2000) },
        session: priceSession(claude.session, { mode: "auto" }),
      },
      {
        ref: { ...codex.ref, mtime: new Date(3000) },
        session: priceSession(codex.session, { mode: "auto" }),
      },
      {
        ref: { ...pi.ref, mtime: new Date(1000) },
        session: priceSession(pi.session, { mode: "auto" }),
      },
    ];

    const report = buildListReport(entries);
    expect(report.rows).toHaveLength(3);
    expect(report.rows.map((r) => r.harness)).toEqual([
      "codex", // mtime 3000
      "claude-code", // mtime 2000
      "pi", // mtime 1000
    ]);
  });

  it("claude cache-heavy: exact turns/tokens, priced cost (claude-opus-5 resolves in the pricing snapshot)", async () => {
    const claude = await dedupedClaudeSession("cache-heavy");
    const priced = priceSession(claude.session, { mode: "auto" });
    const report = buildListReport([{ ref: claude.ref, session: priced }]);

    const row = report.rows[0];
    expect(row?.harness).toBe("claude-code");
    expect(row?.turns).toBe(2);
    // turn1 contextTotal 1750 + turn2 1200 (same fixture as
    // context-command.test.ts's cache-heavy assertions).
    expect(row?.tokensTotal).toBe(2950);
    expect(row?.priced).toBe(true);
    expect(row?.costLabel.startsWith("$")).toBe(true);
    expect(row?.compactionCount).toBe(0);
  });

  it("codex full-turn: gpt-5.5 resolves in the pricing snapshot -> priced cost, not the unpriced '—'", async () => {
    const codex = await dedupedCodexSession("full-turn");
    const priced = priceSession(codex.session, { mode: "auto" });
    const report = buildListReport([{ ref: codex.ref, session: priced }]);

    const row = report.rows[0];
    expect(row?.priced).toBe(true);
    expect(row?.costLabel.startsWith("$")).toBe(true);
  });

  it("claude compaction fixture: compactionCount reflects the session's one CompactionEvent", async () => {
    const claude = await dedupedClaudeSession("compaction");
    const priced = priceSession(claude.session, { mode: "auto" });
    const report = buildListReport([{ ref: claude.ref, session: priced }]);
    expect(report.rows[0]?.compactionCount).toBe(1);
  });

  it("excludes subagent-kind refs by default; includeSubagents:true includes them", async () => {
    // v2.1.225 IS the slug dir (discoverClaudeSessions expects
    // <root>/<slug>/<id>.jsonl — see claude-discover.test.ts), so the root
    // passed here is CLAUDE_FIXTURES_ROOT itself, not a join onto v2.1.225.
    const allRefs = await discoverClaudeSessions([CLAUDE_FIXTURES_ROOT]);
    const refs = allRefs.filter((r) => r.path.includes("v2.1.225"));
    const mains = refs.filter((r) => r.kind === "main");
    const subagents = refs.filter((r) => r.kind === "subagent");
    expect(mains.length).toBeGreaterThan(0);
    expect(subagents.length).toBeGreaterThan(0);

    const entries: ListEntry[] = await Promise.all(
      refs.map(async (ref) => {
        const { session } = await parseClaudeSession(ref);
        const priced = priceSession(dedupSession(session), { mode: "auto" });
        return { ref, session: priced };
      }),
    );

    const defaultReport = buildListReport(entries);
    expect(defaultReport.rows).toHaveLength(mains.length);
    expect(defaultReport.rows.every((r) => r.kind === "main")).toBe(true);

    const withSubagents = buildListReport(entries, {
      includeSubagents: true,
    });
    expect(withSubagents.rows).toHaveLength(refs.length);
    expect(withSubagents.rows.some((r) => r.kind === "subagent")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `peek list` --limit / "no sessions found" root-naming (install-gauntlet
// CLI UX fixes). Real-but-empty dirs for codex/pi so discovery doesn't fall
// back to the real home-directory roots — same isolation trick as `peek
// cost --all --by`'s CLAUDE_ROOTS_ONLY below.
// ---------------------------------------------------------------------------

describe("runListCommand — --limit / empty-results messaging", () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "peek-list-limit-test-"));
  const CLAUDE_ROOTS_ONLY = {
    "claude-code": [CLAUDE_FIXTURES_ROOT],
    codex: [emptyDir],
    pi: [emptyDir],
  };
  // v2.1.225's fixture tree alone has main+subagent refs mixed in with the
  // other fixture dirs under CLAUDE_FIXTURES_ROOT; what matters here is only
  // that main-session count comfortably straddles a small --limit.
  const ALL_EMPTY_ROOTS = {
    "claude-code": [emptyDir],
    codex: [emptyDir],
    pi: [emptyDir],
  };

  async function runAndCapture(
    opts: Partial<Parameters<typeof runListCommand>[0]>,
  ): Promise<{ stdout: string }> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    let written = "";
    process.stdout.write = ((chunk: string) => {
      written += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      await runListCommand({ roots: CLAUDE_ROOTS_ONLY, ...opts });
    } finally {
      process.stdout.write = originalWrite;
    }
    return { stdout: written };
  }

  it("truncates the text table to --limit and prints a hint naming the remaining count", async () => {
    const { stdout } = await runAndCapture({ limit: 5 });
    const dataLines = stdout
      .trim()
      .split("\n")
      .filter((l) => /^(claude-code|codex|pi)\b/.test(l));
    expect(dataLines).toHaveLength(5);
    expect(stdout).toMatch(
      /…and 7 more sessions \(use --limit <n> or --limit 0 for all\)/,
    );
  });

  it("--limit 0 prints every row with no truncation hint", async () => {
    const { stdout } = await runAndCapture({ limit: 0 });
    expect(stdout).not.toMatch(/more session/);
    const dataLines = stdout
      .trim()
      .split("\n")
      .filter((l) => /^(claude-code|codex|pi)\b/.test(l));
    expect(dataLines).toHaveLength(12); // all main sessions in the fixture tree
  });

  it("default limit (DEFAULT_LIST_LIMIT) shows no hint when under the cap", async () => {
    expect(DEFAULT_LIST_LIMIT).toBe(50);
    const { stdout } = await runAndCapture({});
    expect(stdout).not.toMatch(/more session/);
  });

  it("--json ignores --limit entirely — always the full report", async () => {
    const { stdout } = await runAndCapture({ limit: 1, json: true });
    const report = JSON.parse(stdout) as { rows: unknown[] };
    expect(report.rows).toHaveLength(12);
  });

  it("empty results (exit-0 case) name the concrete roots that were checked", async () => {
    const { stdout } = await runAndCapture({ roots: ALL_EMPTY_ROOTS });
    expect(stdout).toMatch(/no sessions found/);
    // All three roots resolved to the same tmp dir here, but the message
    // must be built from the actual resolved roots, not a hardcoded string.
    expect(stdout).toContain(emptyDir);
  });

  it("empty results scoped by --harness only name that harness's root", async () => {
    const { stdout } = await runAndCapture({
      roots: ALL_EMPTY_ROOTS,
      harness: "codex",
    });
    expect(stdout).toContain(emptyDir);
    expect(stdout).not.toMatch(/claude-code|pi/);
  });
});

// ---------------------------------------------------------------------------
// buildCostReport
// ---------------------------------------------------------------------------

describe("buildCostReport", () => {
  it("claude cache-heavy: totals + byModel exact tokens, priced cost", async () => {
    const claude = await dedupedClaudeSession("cache-heavy");
    const priced = priceSession(claude.session, { mode: "auto" });
    const report = buildCostReport(priced);

    expect(report.harness).toBe("claude-code");
    expect(report.totals.tokens.contextTotal).toBe(2950);
    expect(report.totals.priced).toBe(true);
    expect(report.totals.costLabel.startsWith("$")).toBe(true);
    expect(report.byModel).toHaveLength(1);
    expect(report.byModel[0]?.model).toBe("claude-opus-5");
    expect(report.byModel[0]?.turnCount).toBe(2);
  });

  it("tool-use-names: byMcpServer groups get_issue under github; byTool has exact call/result counts and a ~-prefixed token-share estimate, never a per-tool cost", async () => {
    const claude = await dedupedClaudeSession("tool-use-names");
    const priced = priceSession(claude.session, { mode: "auto" });
    const report = buildCostReport(priced);

    const github = report.byMcpServer.find((s) => s.mcpServer === "github");
    expect(github).toBeDefined();
    expect(github?.tools).toEqual(["get_issue"]);
    expect(github?.callCount).toBe(1);
    expect(github?.tokenShareLabel.startsWith("~")).toBe(true);

    const getIssue = report.byTool.find((t) => t.toolName === "get_issue");
    expect(getIssue?.mcpServer).toBe("github");
    expect(getIssue?.callCount).toBe(1); // exact
    // tokenShareEst is over totalChars (toolCallArgs 50 chars + the linked
    // toolResults span, 104 chars): ceil(154/4) = 39.
    expect(getIssue?.tokenShareEst).toBe(Math.ceil((50 + 104) / 4));
    expect(getIssue?.tokenShareLabel).toBe(`~${Math.ceil((50 + 104) / 4)}`);

    // Honesty choice (attribution.ts file header): per-tool COST is never reported.
    for (const tool of report.byTool) {
      expect(tool).not.toHaveProperty("cost");
    }
  });

  it("cache-miss-reason fixture: the miss-reason spike list surfaces with its exact token figure", async () => {
    const claude = await dedupedClaudeSession("cache-miss-reason");
    const priced = priceSession(claude.session, { mode: "auto" });
    const report = buildCostReport(priced);

    expect(report.cache.missReasons).toHaveLength(1);
    const entry = report.cache.missReasons[0];
    expect(entry?.type).toBe("system_changed");
    expect(entry?.cacheMissedInputTokensLabel).toBe("4,500");
    expect(report.cache.wasteTokensLabel).toBe("4,500");
  });

  it("codex full-turn: model from configSnapshot, byMcpServer groups search_code under github, priced totals", async () => {
    const codex = await dedupedCodexSession("full-turn");
    const priced = priceSession(codex.session, { mode: "auto" });
    const report = buildCostReport(priced);

    expect(report.model).toBe("gpt-5.5");
    const github = report.byMcpServer.find((s) => s.mcpServer === "github");
    expect(github).toBeDefined();
    expect(github?.tools).toContain("search_code");

    expect(report.totals.priced).toBe(true);
    expect(report.totals.costLabel.startsWith("$")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mergeAttribution / buildCostAllReport — `peek cost --all` cross-session
// attribution merge (docs/DESIGN.md § Other v2 subsystems, Lane C).
// ---------------------------------------------------------------------------

describe("mergeAttribution", () => {
  it("cross-harness merge: github rows from claude tool-use-names + codex full-turn fold into one bucket keyed identically; arithmetic = sum of the two single-session reports", async () => {
    const claude = await dedupedClaudeSession("tool-use-names");
    const claudePriced = priceSession(claude.session, { mode: "auto" });
    const codex = await dedupedCodexSession("full-turn");
    const codexPriced = priceSession(codex.session, { mode: "auto" });

    const claudeGithub = byMcpServer(claudePriced).find(
      (s) => s.mcpServer === "github",
    );
    const codexGithub = byMcpServer(codexPriced).find(
      (s) => s.mcpServer === "github",
    );
    expect(claudeGithub).toBeDefined();
    expect(codexGithub).toBeDefined();

    const merged = mergeAttribution([[claudePriced], [codexPriced]]);
    const githubRows = merged.byMcpServer.filter(
      (s) => s.mcpServer === "github",
    );
    // One merged bucket, not two side-by-side per-harness rows.
    expect(githubRows).toHaveLength(1);
    const mergedGithub = githubRows[0];

    expect(mergedGithub?.tools.slice().sort()).toEqual(
      [
        ...new Set([
          ...(claudeGithub?.tools ?? []),
          ...(codexGithub?.tools ?? []),
        ]),
      ].sort(),
    );

    // Exact arithmetic = sum of the two single-session byMcpServer reports.
    expect(mergedGithub?.totalChars).toBe(
      (claudeGithub?.totalChars ?? 0) + (codexGithub?.totalChars ?? 0),
    );
    expect(mergedGithub?.totalSpanCount).toBe(
      (claudeGithub?.totalSpanCount ?? 0) + (codexGithub?.totalSpanCount ?? 0),
    );
    expect(mergedGithub?.toolCallArgs.spanCount).toBe(
      (claudeGithub?.toolCallArgs.spanCount ?? 0) +
        (codexGithub?.toolCallArgs.spanCount ?? 0),
    );
    expect(mergedGithub?.toolResults.spanCount).toBe(
      (claudeGithub?.toolResults.spanCount ?? 0) +
        (codexGithub?.toolResults.spanCount ?? 0),
    );
    expect(mergedGithub?.tokenShareEst).toBe(
      Math.ceil((mergedGithub?.totalChars ?? 0) / 4),
    );

    // byTool: get_issue (claude-only) and search_code (codex-only) stay
    // separate rows — merging is by (toolName, mcpServer), not by server
    // alone — each equal to its single-session figure exactly.
    const claudeGetIssue = byTool(claudePriced).find(
      (t) => t.toolName === "get_issue",
    );
    const codexSearchCode = byTool(codexPriced).find(
      (t) => t.toolName === "search_code",
    );
    const mergedGetIssue = merged.byTool.find(
      (t) => t.toolName === "get_issue",
    );
    const mergedSearchCode = merged.byTool.find(
      (t) => t.toolName === "search_code",
    );
    expect(mergedGetIssue?.totalChars).toBe(claudeGetIssue?.totalChars);
    expect(mergedSearchCode?.totalChars).toBe(codexSearchCode?.totalChars);

    // byModel: merged turnCount = sum of the two sessions' own turnCounts.
    const mergedTurnCount = merged.byModel.reduce(
      (sum, m) => sum + m.turnCount,
      0,
    );
    const singleTurnCount =
      byModel(claudePriced).reduce((sum, m) => sum + m.turnCount, 0) +
      byModel(codexPriced).reduce((sum, m) => sum + m.turnCount, 0);
    expect(mergedTurnCount).toBe(singleTurnCount);
  });

  it("family-dedup interaction: a cross-file replay turn's spans are excluded from the merge entirely, not double-counted (dedup-family fixture)", async () => {
    const [parent, child] = await dedupFamilyFixture();

    // Sanity: without the exclusion, naively summing each session's own
    // byTool would double-count the child's replayed Task call-args span —
    // the exact latent risk the engine reviewer flagged.
    const parentTask = byTool(parent).find((t) => t.toolName === "Task");
    const childTask = byTool(child).find((t) => t.toolName === "Task");
    expect(parentTask).toBeDefined();
    expect(childTask).toBeDefined(); // the replay's own (zeroed-usage) copy
    const naiveTaskSpanCount =
      (parentTask?.totalSpanCount ?? 0) + (childTask?.totalSpanCount ?? 0);

    const merged = mergeAttribution([[parent, child]]);
    const mergedTask = merged.byTool.find((t) => t.toolName === "Task");
    expect(mergedTask).toBeDefined();

    // The merge matches the PARENT's own canonical Task attribution exactly
    // — the child's replayed copy contributes nothing to it.
    expect(mergedTask?.totalChars).toBe(parentTask?.totalChars);
    expect(mergedTask?.totalSpanCount).toBe(parentTask?.totalSpanCount);
    expect(mergedTask?.toolCallArgs.spanCount).toBe(
      parentTask?.toolCallArgs.spanCount,
    );
    expect(mergedTask?.toolResults.spanCount).toBe(
      parentTask?.toolResults.spanCount,
    );
    // Not the naive (buggy) sum of both sessions' own views.
    expect(mergedTask?.totalSpanCount).toBeLessThan(naiveTaskSpanCount);

    // The child's genuinely-its-own Bash call (not a replay) still comes
    // through unchanged.
    const childBash = byTool(child).find((t) => t.toolName === "Bash");
    const mergedBash = merged.byTool.find((t) => t.toolName === "Bash");
    expect(childBash).toBeDefined();
    expect(mergedBash?.totalChars).toBe(childBash?.totalChars);
    expect(mergedBash?.totalSpanCount).toBe(childBash?.totalSpanCount);
  });

  it("single-family input still matches bySubagent's own token/cost totals (dedup-family fixture) — merge and dollar-rollup agree on what a 'replay' is", async () => {
    const [parent, child] = await dedupFamilyFixture();
    const rollup = bySubagent([parent, child]);
    const merged = mergeAttribution([[parent, child]]);

    // Both exclude the replay: merged byModel's total turnCount should be
    // one fewer than the naive (parent.turns.length + child.turns.length)
    // — the replayed turn contributes to neither.
    const naiveTurnCount = parent.turns.length + child.turns.length;
    const mergedTurnCount = merged.byModel.reduce(
      (sum, m) => sum + m.turnCount,
      0,
    );
    expect(mergedTurnCount).toBe(naiveTurnCount - 1);
    expect(rollup.combined.tokens.contextTotal).toBeGreaterThan(0);
  });
});

describe("buildCostAllReport — merged byModel/byTool/byMcpServer", () => {
  it("merges byModel/byTool/byMcpServer across every family in `entries`, alongside the existing byHarness/totals", async () => {
    const claude = await dedupedClaudeSession("tool-use-names");
    const claudePriced = priceSession(claude.session, { mode: "auto" });
    const codex = await dedupedCodexSession("full-turn");
    const codexPriced = priceSession(codex.session, { mode: "auto" });

    const entries: CostAllEntry[] = [
      {
        ref: claude.ref,
        rollup: bySubagent([claudePriced]),
        family: [claudePriced],
      },
      {
        ref: codex.ref,
        rollup: bySubagent([codexPriced]),
        family: [codexPriced],
      },
    ];

    const report = buildCostAllReport(entries);
    expect(report.byHarness).toHaveLength(2); // unchanged existing behavior

    const githubRows = report.byMcpServer.filter(
      (s) => s.mcpServer === "github",
    );
    expect(githubRows).toHaveLength(1); // merged, not one row per harness

    // Honesty choice preserved in the merged tables too — never a per-tool
    // or per-mcp-server cost figure.
    for (const tool of report.byTool) {
      expect(tool).not.toHaveProperty("cost");
    }
    for (const server of report.byMcpServer) {
      expect(server).not.toHaveProperty("cost");
    }

    expect(report.note).toMatch(/mergeAttribution|merged the same way/);
  });
});

describe("`peek cost --all --by` — filters human-readable output to one attribution table", () => {
  // Real-but-empty dirs so discoverCodexSessions/discoverPiSessions don't
  // fall back to their default (real home-directory) discovery roots —
  // this test only wants the claude-code tool-use-names fixture in scope.
  const emptyDir = mkdtempSync(join(tmpdir(), "peek-cost-all-by-test-"));
  const CLAUDE_ROOTS_ONLY = {
    "claude-code": [CLAUDE_FIXTURES_ROOT],
    codex: [emptyDir],
    pi: [emptyDir],
  };

  async function runAndCapture(by?: "tool" | "mcp" | "model"): Promise<string> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    let written = "";
    process.stdout.write = ((chunk: string) => {
      written += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      const opts: Parameters<typeof runCostCommand>[1] = {
        all: true,
        json: false,
        roots: CLAUDE_ROOTS_ONLY,
      };
      if (by !== undefined) opts.by = by;
      await runCostCommand(undefined, opts);
    } finally {
      process.stdout.write = originalWrite;
    }
    return written;
  }

  it("no --by: all three tables print", async () => {
    const out = await runAndCapture();
    expect(out).toMatch(/by model/);
    expect(out).toMatch(/by tool/);
    expect(out).toMatch(/by MCP server/);
  });

  it("--by model: only the model table prints", async () => {
    const out = await runAndCapture("model");
    expect(out).toMatch(/by model/);
    expect(out).not.toMatch(/by tool/);
    expect(out).not.toMatch(/by MCP server/);
  });

  it("--by tool: only the tool table prints", async () => {
    const out = await runAndCapture("tool");
    expect(out).not.toMatch(/by model/);
    expect(out).toMatch(/by tool/);
    expect(out).not.toMatch(/by MCP server/);
  });

  it("--by mcp: only the MCP-server table prints", async () => {
    const out = await runAndCapture("mcp");
    expect(out).not.toMatch(/by model/);
    expect(out).not.toMatch(/by tool/);
    expect(out).toMatch(/by MCP server/);
  });
});

// ---------------------------------------------------------------------------
// buildCompactionsReport
// ---------------------------------------------------------------------------

describe("buildCompactionsReport", () => {
  it("claude compaction fixture: F2-trap respected — tokensBeforeExact anchors past the isApiErrorMessage zero-usage record to the real 20,000", async () => {
    const claude = await dedupedClaudeSession("compaction");
    const finalized = finalizeCompactions(claude.session);
    const report = buildCompactionsReport(finalized);

    expect(report.rows).toHaveLength(1);
    const row = report.rows[0];
    expect(row?.turnNumber).toBe(3); // event.turnIndex(2) + 1
    expect(row?.beforeLabel).toBe("20,000");
    expect(row?.afterLabel).toBe("3,000");
    expect(row?.shrinkLabel).toBe("17,000");
    expect(row?.discardedLabel).toBe("~17,040"); // 17,000 + summaryTokensEst(40)
    expect(row?.summarySizeLabel).toBe("~40");
  });

  it("codex compaction fixture: engine fills tokensAfterExact from the trailing post-compaction turn (26,800) -> shrink 187,500; no per-compaction cost (codex logs none)", async () => {
    const codex = await dedupedCodexSession("compaction");
    const finalized = finalizeCompactions(codex.session);
    const report = buildCompactionsReport(finalized);

    expect(report.rows).toHaveLength(1);
    const row = report.rows[0];
    expect(row?.beforeLabel).toBe("214,300");
    expect(row?.afterLabel).toBe("26,800");
    expect(row?.shrinkLabel).toBe("187,500");
    expect(row?.costLabel).toBe("—");
  });

  it("pi compaction fixture: tokensBefore from the adapter's own field, cost from the adapter's own display-cost math", async () => {
    const pi = await dedupedPiSession(
      piRef(
        "6d816cb4-9915-4741-9571-a436e36f68c5",
        "2026-08-01T12-45-00-000Z_6d816cb4-9915-4741-9571-a436e36f68c5.jsonl",
      ),
    );
    const finalized = finalizeCompactions(pi.session);
    const report = buildCompactionsReport(finalized);

    expect(report.rows).toHaveLength(1);
    const row = report.rows[0];
    expect(row?.beforeLabel).toBe("8,500"); // pi adapter's own tokensBefore
    expect(row?.afterLabel).toBe("1,000"); // engine-filled
    expect(row?.shrinkLabel).toBe("7,500");
    // Fixture's compaction usage.cost.total is 0.02025 -> "$0.02".
    expect(row?.costLabel).toBe("$0.02");
  });

  it("empty state: a session with no compaction events produces zero rows", async () => {
    const claude = await dedupedClaudeSession("cache-heavy");
    const finalized = finalizeCompactions(claude.session);
    const report = buildCompactionsReport(finalized);
    expect(report.rows).toEqual([]);
    expect(report.harness).toBe("claude-code");
  });
});

// ---------------------------------------------------------------------------
// resolveSessionRef — direct-file-path resolution (content-sniffed, not
// directory-shape-based). docs/examples/BROKEN.md regression: a codex
// fixture passed by path to cost/compactions used to get silently
// mis-resolved as claude-code (directory-shape match), producing the wrong
// harness label and all-zero totals instead of an error.
// ---------------------------------------------------------------------------

describe("resolveSessionRef — direct-file-path resolution", () => {
  const CODEX_TOOLS_PATH = join(
    CODEX_FIXTURES_ROOT,
    "v0.134/real-capture-tools-redacted.jsonl",
  );
  const CODEX_COMPACTION_PATH = join(
    CODEX_FIXTURES_ROOT,
    "v0.134/compaction.jsonl",
  );
  const CLAUDE_PATH = join(CLAUDE_FIXTURES_ROOT, "v2.1.104/cache-heavy.jsonl");
  const PI_SYSTEM_A_PATH = join(
    PI_FIXTURES_ROOT,
    "system-a-v3/--Users-fake-project--/2026-08-01T10-00-00-000Z_cb5b132f-2542-40b3-a7c9-49ffc431e30b.jsonl",
  );
  const PI_SYSTEM_B_PATH = join(
    PI_FIXTURES_ROOT,
    "system-b-v4/2026-08-01T16-00-00-000Z_b9f0fc61-c03e-49c7-a148-e1e7c660822c.jsonl",
  );

  it("BROKEN.md regression: a codex fixture by path resolves as codex, not claude-code", async () => {
    const ref = await resolveSessionRef(CODEX_TOOLS_PATH, {});
    expect(ref.harness).toBe("codex");
  });

  it("BROKEN.md regression: `cost` on the codex fixture by path reports codex with real (non-zero) totals", async () => {
    const priced = await loadPricedSession(CODEX_TOOLS_PATH, {});
    const report = buildCostReport(priced);
    expect(report.harness).toBe("codex");
    expect(report.totals.tokens.contextTotal).toBeGreaterThan(0);
  });

  it("BROKEN.md regression: `compactions` on the codex fixture by path reports codex with its real compaction row, not an empty timeline", async () => {
    const finalized = await loadFinalizedSession(CODEX_COMPACTION_PATH, {});
    const report = buildCompactionsReport(finalized);
    expect(report.harness).toBe("codex");
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.beforeLabel).toBe("214,300");
  });

  it("claude-code fixture by path still resolves correctly", async () => {
    const ref = await resolveSessionRef(CLAUDE_PATH, {});
    expect(ref.harness).toBe("claude-code");
    expect(ref.id).toBe("cache-heavy");
  });

  it("pi System A fixture by path still resolves correctly", async () => {
    const ref = await resolveSessionRef(PI_SYSTEM_A_PATH, {});
    expect(ref.harness).toBe("pi");
    expect(ref.id).toBe("cb5b132f-2542-40b3-a7c9-49ffc431e30b");
  });

  it("pi System B fixture by path resolves to a pi ref and parses fully (Lane D: no longer detect-and-skip), not a crash", async () => {
    const ref = await resolveSessionRef(PI_SYSTEM_B_PATH, {});
    expect(ref.harness).toBe("pi");

    const { session, warnings } = await parsePiSession(ref);
    expect(warnings.some((w) => w.code === "pi-system-b")).toBe(false);
    expect(session.turns.length).toBeGreaterThan(0);
  });

  it("--harness mismatch against sniffed content errors clearly instead of proceeding", async () => {
    await expect(
      resolveSessionRef(CODEX_TOOLS_PATH, { harness: "claude-code" }),
    ).rejects.toThrow(
      /--harness claude-code was given but .* is a codex session/,
    );
  });

  it("--harness matching sniffed content resolves normally", async () => {
    const ref = await resolveSessionRef(CODEX_TOOLS_PATH, { harness: "codex" });
    expect(ref.harness).toBe("codex");
  });

  it("an existing file with unrecognized content errors listing what was tried, never silently guesses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peek-resolve-test-"));
    const filePath = join(dir, "not-a-session.jsonl");
    writeFileSync(filePath, '{"foo":"bar"}\n');

    await expect(resolveSessionRef(filePath, {})).rejects.toThrow(
      /not a recognized session file/,
    );
  });
});

describe("resolveSessionRef short-id prefix (real-data verification fix)", () => {
  it("resolves a unique 8-char prefix to the full session", async () => {
    const { resolveSessionRef } = await import("../../src/commands/shared.js");
    const roots = { "claude-code": ["test/fixtures/claude-code"] };
    const short = await resolveSessionRef("cache-h", { roots });
    expect(short.id).toBe("cache-heavy");
  });
  it("errors on an ambiguous prefix instead of guessing", async () => {
    const { resolveSessionRef } = await import("../../src/commands/shared.js");
    await expect(
      resolveSessionRef("streaming-spl", {
        roots: { "claude-code": ["test/fixtures/claude-code"] },
      }),
    ).rejects.toThrow(/ambiguous session id prefix/);
  });
});

describe("resolveSessionRef — unresolvable-target message names the checked roots", () => {
  it("no argument + nothing discovered: error names all three (test-override) roots", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "peek-resolve-empty-test-"));
    const roots = {
      "claude-code": [emptyDir],
      codex: [emptyDir],
      pi: [emptyDir],
    };
    await expect(resolveSessionRef(undefined, { roots })).rejects.toThrow(
      new RegExp(
        `no sessions found.*${emptyDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
  });
});
