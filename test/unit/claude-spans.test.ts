import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeCompactionDeltas,
  findNextTurnIndex,
  findTokensAfter,
  findTokensBefore,
} from "../../src/adapters/claude/compaction.js";
import { discoverClaudeSessions } from "../../src/adapters/claude/discover.js";
import { parseClaudeSession } from "../../src/adapters/claude/parse.js";
import type { RawClaudeRecord } from "../../src/adapters/claude/records.js";
import {
  buildToolUseIndex,
  extractUserContentSpans,
  parseMcpToolName,
} from "../../src/adapters/claude/spans.js";
import type { SessionRef, Span } from "../../src/model/types.js";

const FIXTURES_ROOT = path.join(import.meta.dirname, "../fixtures/claude-code");

function refs(): Promise<SessionRef[]> {
  return discoverClaudeSessions([FIXTURES_ROOT]);
}

function findRef(
  all: SessionRef[],
  versionDir: string,
  id: string
): SessionRef {
  const ref = all.find(
    (r) => r.id === id && r.path.includes(`${path.sep}${versionDir}${path.sep}`)
  );
  if (!ref) {
    throw new Error(`fixture ref not found: ${versionDir}/${id}`);
  }
  return ref;
}

function spansOf(
  spans: Span[] | undefined,
  category: Span["category"]
): Span[] {
  return (spans ?? []).filter((s) => s.category === category);
}

describe("parseMcpToolName", () => {
  it("parses mcp__github__get_issue", () => {
    expect(parseMcpToolName("mcp__github__get_issue")).toEqual({
      mcpServer: "github",
      toolName: "get_issue",
    });
  });

  it("parses plugin-form mcp__plugin_acme-tools_linter__run_lint", () => {
    expect(parseMcpToolName("mcp__plugin_acme-tools_linter__run_lint")).toEqual(
      {
        mcpServer: "plugin_acme-tools_linter",
        toolName: "run_lint",
      }
    );
  });

  it("plain tool names get toolName only", () => {
    expect(parseMcpToolName("Bash")).toEqual({ toolName: "Bash" });
    expect(parseMcpToolName("Bash")).not.toHaveProperty("mcpServer");
  });
});

describe("computeCompactionDeltas — PLAN worked example", () => {
  it("844000 / 54437 / 30581 -> shrink 789563, discarded 820144", () => {
    expect(computeCompactionDeltas(844_000, 54_437, 30_581)).toEqual({
      discardedEst: 820_144,
      shrinkExact: 789_563,
    });
  });

  it("degenerate: summary replaces everything -> shrinkExact 0", () => {
    expect(computeCompactionDeltas(500, 500, 500)).toEqual({
      discardedEst: 500,
      shrinkExact: 0,
    });
  });

  it("null when either side is unknown", () => {
    expect(computeCompactionDeltas(null, 100, 10)).toEqual({
      discardedEst: null,
      shrinkExact: null,
    });
    expect(computeCompactionDeltas(100, null, 10)).toEqual({
      discardedEst: null,
      shrinkExact: null,
    });
  });
});

describe("compaction anchoring primitives", () => {
  const turns = [
    { contextTotal: 20_000, isApiError: false, line: 2 },
    { contextTotal: 0, isApiError: true, line: 3 }, // adjacent api-error trap
    { contextTotal: 3000, isApiError: false, line: 5 },
  ];

  it("findTokensBefore skips the zero-usage api-error turn", () => {
    expect(findTokensBefore(turns, 4)).toBe(20_000);
  });

  it("findTokensAfter finds the first real-usage turn after the marker", () => {
    expect(findTokensAfter(turns, 4)).toBe(3000);
  });

  it("findNextTurnIndex points at the next turn's index", () => {
    expect(findNextTurnIndex(turns, 4)).toBe(2);
  });

  it("findNextTurnIndex is turns.length when nothing follows the marker", () => {
    expect(findNextTurnIndex(turns, 10)).toBe(3);
  });
});

describe("compaction.jsonl — full CompactionEvent (audit R1-C2 anchoring)", () => {
  it("anchors tokensBeforeExact past the isApiErrorMessage trap, not 0", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "compaction");
    const { session } = await parseClaudeSession(ref);

    const compactionEvents = session.events.filter(
      (e) => e.kind === "compaction"
    );
    expect(compactionEvents).toHaveLength(1);
    const event = compactionEvents.at(0);
    if (event?.kind !== "compaction") {
      throw new Error("unreachable");
    }

    // a-0001: input 15000 + cache_read 5000 (no TTL sub-object -> all cacheWrite5m=0 here)
    expect(event.tokensBeforeExact).toBe(20_000);
    // a-0003 (post-marker, real usage): input 200 + cache_read 800 + cache_creation 2000
    expect(event.tokensAfterExact).toBe(3000);
    expect(event.shrinkExact).toBe(17_000);
    expect(event.cost).toBeNull();

    const summaryContent =
      "This session is being continued from a previous conversation. The user asked to implement a feature; work so far has added the initial scaffolding and tests.";
    expect(event.summaryTokensEst).toBe(Math.ceil(summaryContent.length / 4));
    expect(event.discardedEst).toBe(
      event.tokensBeforeExact !== null && event.tokensAfterExact !== null
        ? event.tokensBeforeExact -
            event.tokensAfterExact +
            event.summaryTokensEst
        : null
    );

    // turnIndex points at the turn (a-0003) whose contentSpans carry the
    // compactionSummaries span this event was built from.
    expect(event.turnIndex).toBe(2);
    const landingTurn = session.turns[event.turnIndex];
    expect(
      spansOf(landingTurn?.contentSpans ?? [], "compactionSummaries")
    ).toHaveLength(1);
    expect(
      spansOf(landingTurn?.contentSpans ?? [], "compactionSummaries")[0]
        ?.charCount
    ).toBe(summaryContent.length);
  });
});

describe("streaming-split.jsonl — span tagging across the split trio", () => {
  it("thinking/text/tool_use land as separate spans on their own records; user span attaches once", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "streaming-split");
    const { session } = await parseClaudeSession(ref);
    expect(session.turns).toHaveLength(4);

    const [thinkTurn, textTurn, toolTurn, replyTurn] = session.turns;

    expect(spansOf(thinkTurn?.contentSpans, "thinking")).toHaveLength(1);
    expect(spansOf(thinkTurn?.contentSpans, "userText")).toHaveLength(1);

    // The trio shares one message.id but is 3 distinct raw records; the
    // preceding user span is consumed once (by the first of the trio) and
    // is not re-attached to the other two.
    expect(spansOf(textTurn?.contentSpans, "assistantText")).toHaveLength(1);
    expect(spansOf(textTurn?.contentSpans, "userText")).toHaveLength(0);

    const toolCallSpans = spansOf(toolTurn?.contentSpans, "toolCallArgs");
    expect(toolCallSpans).toHaveLength(1);
    expect(toolCallSpans[0]?.toolName).toBe("Bash");
    expect(toolCallSpans[0]?.mcpServer).toBeUndefined();
    expect(spansOf(toolTurn?.contentSpans, "userText")).toHaveLength(0);

    // Reply turn (a-0002) carries the pending tool_result span from u-0002.
    expect(spansOf(replyTurn?.contentSpans, "toolResults")).toHaveLength(1);
    expect(spansOf(replyTurn?.contentSpans, "assistantText")).toHaveLength(1);
  });
});

describe("tool-use-names.jsonl — MCP name parsing on real spans", () => {
  it("tags toolName/mcpServer for both plain and plugin-form MCP names", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "tool-use-names");
    const { session } = await parseClaudeSession(ref);
    const firstTurn = session.turns.at(0);
    const toolCallSpans = spansOf(firstTurn?.contentSpans, "toolCallArgs");
    expect(toolCallSpans).toHaveLength(2);
    expect(toolCallSpans[0]).toMatchObject({
      mcpServer: "github",
      toolName: "get_issue",
    });
    expect(toolCallSpans[1]).toMatchObject({
      mcpServer: "plugin_acme-tools_linter",
      toolName: "run_lint",
    });
  });

  it("links each toolResults span back to its originating tool_use — toolName/mcpServer populated, not null", async () => {
    const all = await refs();
    const ref = findRef(all, "v2.1.104", "tool-use-names");
    const { session } = await parseClaudeSession(ref);

    // a-0002 carries the pending toolResults spans from u-0002 (toolu-0001,
    // the github get_issue call) and u-0003 (toolu-0002, the plugin-form
    // linter call).
    const secondTurn = session.turns.at(1);
    const toolResultSpans = spansOf(secondTurn?.contentSpans, "toolResults");
    expect(toolResultSpans).toHaveLength(2);
    expect(toolResultSpans[0]).toMatchObject({
      mcpServer: "github",
      toolName: "get_issue",
    });
    expect(toolResultSpans[1]).toMatchObject({
      mcpServer: "plugin_acme-tools_linter",
      toolName: "run_lint",
    });
  });

  it("an orphaned tool_result (no matching prior tool_use) leaves toolName/mcpServer undefined, no crash", () => {
    const orphanRecord: RawClaudeRecord = {
      line: 1,
      raw: {
        message: {
          content: [
            {
              content: "orphaned result",
              is_error: false,
              tool_use_id: "toolu-never-called",
              type: "tool_result",
            },
          ],
          role: "user",
        },
        type: "user",
      },
      type: "user",
    };
    const emptyIndex = buildToolUseIndex([]);
    const spans = extractUserContentSpans(orphanRecord, new Set(), emptyIndex);
    const toolResultSpans = spansOf(spans, "toolResults");
    expect(toolResultSpans).toHaveLength(1);
    expect(toolResultSpans[0]?.toolName).toBeUndefined();
    expect(toolResultSpans[0]?.mcpServer).toBeUndefined();
  });
});

describe("v2.1.225/…0003.jsonl — the single-source double-count trap + offload", () => {
  it("offloaded tool result: truncated:true, charCount is the SHORT reference, not the sidecar", async () => {
    const all = await refs();
    const ref = findRef(
      all,
      "v2.1.225",
      "20000000-2000-4200-8200-200000000003"
    );
    const { session, warnings } = await parseClaudeSession(ref);
    expect(warnings).toHaveLength(0);

    // a-0002 carries the pending toolResults span from the offloaded u-0002.
    const offloadedTurn = session.turns.at(1);
    const toolResultSpans = spansOf(offloadedTurn?.contentSpans, "toolResults");
    expect(toolResultSpans).toHaveLength(1);
    expect(toolResultSpans[0]?.truncated).toBe(true);
    // The sidecar (tool-results/toolu-offload-0001.txt) is ~500+ chars of
    // real CI log; the short inline reference is far shorter. Proves the
    // sidecar was never read into the span.
    expect(toolResultSpans[0]?.charCount).toBeLessThan(150);
  });

  it("byte-identical inline/toolUseResult turn: exactly ONE toolResults span, charCount = the single text's length", async () => {
    const all = await refs();
    const ref = findRef(
      all,
      "v2.1.225",
      "20000000-2000-4200-8200-200000000003"
    );
    const { session } = await parseClaudeSession(ref);

    // a-0004 carries the pending toolResults span from u-0004 (README read).
    const readmeTurn = session.turns.at(3);
    const toolResultSpans = spansOf(readmeTurn?.contentSpans, "toolResults");
    expect(toolResultSpans).toHaveLength(1); // NOT 2 — the double-count trap
    expect(toolResultSpans[0]?.truncated).toBe(false);

    const expectedText =
      "# Fixture Project\n\nThis is a fabricated README used for fixture testing.\n";
    expect(toolResultSpans[0]?.charCount).toBe(expectedText.length);
  });
});

describe("v2.1.225/…0002 — coordination span (team/SendMessage wrapper)", () => {
  it("<teammate-message ...> content is tagged coordination, not userText", async () => {
    const all = await refs();
    const ref = all.find(
      (r) => r.id === "def456" && r.path.endsWith("agent-def456.jsonl")
    );
    if (!ref) {
      throw new Error("agent-def456.jsonl ref not found");
    }
    const { session } = await parseClaudeSession(ref);

    const firstTurn = session.turns.at(0);
    expect(spansOf(firstTurn?.contentSpans, "coordination")).toHaveLength(1);
    expect(spansOf(firstTurn?.contentSpans, "userText")).toHaveLength(0);
  });
});
