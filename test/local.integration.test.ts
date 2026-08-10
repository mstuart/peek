import { describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "../src/adapters/claude/discover.js";
import { parseClaudeSession } from "../src/adapters/claude/parse.js";
import { discoverCodexSessions } from "../src/adapters/codex/discover.js";
import { parseCodexSession } from "../src/adapters/codex/parse.js";
import type { SessionRef } from "../src/model/types.js";

const TEST_PATTERN_1 = /\s+at \//;

// Guards on real local ~/.claude and ~/.codex data — only runs when
// PEEK_LOCAL=1 is set (Fable's [fable]-gated runs). Plain `vitest`
// skips this block everywhere else, including CI.
//
// PRIVACY RULE: nothing printed here may derive from session CONTENT — only
// counts, error messages (truncated + stack-stripped), warning codes, and
// rates. File paths (which embed cwd slugs, i.e. project names) are used
// internally for the pass/fail tally but are never logged.

const CLAUDE_FILE_CAP = 2000;
const PROGRESS_EVERY = 200;

/** Truncate to 120 chars and drop anything from a stack-trace-looking
 * " at /..." suffix onward, per the privacy rule — error messages only,
 * never raw content. */
function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const stackCut = raw.split(TEST_PATTERN_1)[0] ?? raw;
  return stackCut.length > 120 ? `${stackCut.slice(0, 120)}…` : stackCut;
}

function topN(
  counts: Map<string, number>,
  n: number
): { message: string; count: number }[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([message, count]) => ({ count, message }));
}

interface CorpusResult {
  attempted: number;
  failed: number;
  failureMessageCounts: Map<string, number>;
  ok: number;
  sessionsWithCompaction: number;
  totalRefs: number;
  totalTurns: number;
  totalWarnings: number;
  warningCounts: Map<string, number>;
}

async function runCorpus(
  refs: SessionRef[],
  parseFn: (ref: SessionRef) => Promise<{
    session: { turns: unknown[]; events: { kind: string }[] };
    warnings: { code: string }[];
  }>,
  label: string
): Promise<CorpusResult> {
  const result: CorpusResult = {
    attempted: refs.length,
    failed: 0,
    failureMessageCounts: new Map(),
    ok: 0,
    sessionsWithCompaction: 0,
    totalRefs: refs.length,
    totalTurns: 0,
    totalWarnings: 0,
    warningCounts: new Map(),
  };

  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i] as SessionRef;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Local session parsing is intentionally serialized to bound I/O.
      const { session, warnings } = await parseFn(ref);
      result.ok += 1;
      result.totalTurns += session.turns.length;
      if (session.events.some((e) => e.kind === "compaction")) {
        result.sessionsWithCompaction += 1;
      }
      for (const w of warnings) {
        result.totalWarnings += 1;
        result.warningCounts.set(
          w.code,
          (result.warningCounts.get(w.code) ?? 0) + 1
        );
      }
    } catch (err) {
      result.failed += 1;
      const msg = sanitizeError(err);
      result.failureMessageCounts.set(
        msg,
        (result.failureMessageCounts.get(msg) ?? 0) + 1
      );
    }

    if ((i + 1) % PROGRESS_EVERY === 0) {
      console.info(
        `[local-integration:${label}] progress: ${i + 1}/${refs.length} (ok=${result.ok} failed=${result.failed})`
      );
    }
  }

  return result;
}

function printSummary(label: string, r: CorpusResult, capNote?: string) {
  const rate = r.attempted === 0 ? 1 : r.ok / r.attempted;
  console.info(`\n=== local-integration summary: ${label} ===`);
  if (capNote) {
    console.info(capNote);
  }
  console.info(
    `parsed: ${r.ok}/${r.attempted} ok, ${r.failed} failed — rate=${(rate * 100).toFixed(2)}%`
  );
  console.info(`total turns: ${r.totalTurns}`);
  console.info(`sessions with compaction events: ${r.sessionsWithCompaction}`);
  console.info(`total ParseWarnings: ${r.totalWarnings}`);
  console.info("warning taxonomy (code: count):");
  for (const { message: code, count } of topN(r.warningCounts, 50)) {
    console.info(`  ${code}: ${count}`);
  }
  console.info("top 5 failure messages:");
  for (const { message, count } of topN(r.failureMessageCounts, 5)) {
    console.info(`  (${count}x) ${message}`);
  }
  console.info(`=== end summary: ${label} ===\n`);
}

describe.skipIf(!process.env.PEEK_LOCAL)("local integration", () => {
  it(
    "parses >=95% of real Claude Code sessions from ~/.claude/projects",
    async () => {
      const allRefs = await discoverClaudeSessions();
      expect(allRefs.length).toBeGreaterThan(0);

      let refs = allRefs;
      let capNote: string | undefined;
      if (allRefs.length > CLAUDE_FILE_CAP) {
        // Cap applied: most-recent-mtime CLAUDE_FILE_CAP files across main +
        // subagent refs together (corpus exceeds the cap).
        refs = [...allRefs]
          .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
          .slice(0, CLAUDE_FILE_CAP);
        capNote = `corpus (${allRefs.length} files) exceeds cap of ${CLAUDE_FILE_CAP}; selected the ${CLAUDE_FILE_CAP} most-recently-modified refs (main + subagent) by mtime`;
        console.info(`[local-integration:claude] ${capNote}`);
      }

      const mainCount = refs.filter((r) => r.kind === "main").length;
      const subagentCount = refs.length - mainCount;
      console.info(
        `[local-integration:claude] selected ${refs.length} refs (${mainCount} main, ${subagentCount} subagent) of ${allRefs.length} discovered`
      );

      const result = await runCorpus(refs, parseClaudeSession, "claude");
      printSummary("claude-code", result, capNote);

      const rate = result.ok / result.attempted;
      expect(rate).toBeGreaterThanOrEqual(0.95);
    },
    10 * 60 * 1000
  );

  it(
    "parses all real Codex sessions from ~/.codex/sessions",
    async () => {
      const refs = await discoverCodexSessions();
      expect(refs.length).toBeGreaterThan(0);
      console.info(`[local-integration:codex] discovered ${refs.length} refs`);

      const result = await runCorpus(refs, parseCodexSession, "codex");
      printSummary("codex", result);

      expect(result.failed).toBe(0);
      expect(result.ok).toBe(result.attempted);
    },
    5 * 60 * 1000
  );
});
