// Canonical formatCost (src/model/format.ts) — the single dollar-formatting
// implementation shared by commands/shared.ts (re-exported), commands/
// report.ts, and render/dashboardHtml.ts. Also a regression check that
// report.ts's headline.costLabel goes through this canonical implementation
// rather than a divergent local copy (report.ts previously used an `abs < 1`
// 4dp threshold, which rendered $0.50 as "$0.5000").

import { describe, expect, it } from "vitest";
import { buildReportData } from "../../src/commands/report.js";
import { formatCost } from "../../src/model/format.js";
import type {
  Composition,
  CostBreakdown,
  NormalizedUsage,
  Session,
  Turn,
} from "../../src/model/types.js";

describe("formatCost", () => {
  it('$0.50 renders as "$0.50" (2dp), not "$0.5000"', () => {
    expect(formatCost(0.5)).toBe("$0.50");
  });

  it("sub-cent positive amounts render at 4dp", () => {
    expect(formatCost(0.005)).toBe("$0.0050");
  });

  it("negative amounts carry a leading sign", () => {
    expect(formatCost(-1.5)).toBe("-$1.50");
  });
});

// ---------------------------------------------------------------------------
// Regression: buildReportData's headline.costLabel through the canonical
// formatCost.
// ---------------------------------------------------------------------------

function zeroComposition(): Composition {
  return {
    categories: {
      userText: 0,
      assistantText: 0,
      thinking: 0,
      toolResults: 0,
      toolCallArgs: 0,
      instructionInjection: 0,
      systemPrompt: 0,
      toolSchemas: 0,
      compactionSummaries: 0,
      coordination: 0,
    },
    residual: 0,
    residualShare: 0,
    truncated: false,
  };
}

function makeTurn(costTotal: number): Turn {
  const usage: NormalizedUsage = {
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    raw: undefined,
  };
  const cost: CostBreakdown = {
    input: costTotal,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    total: costTotal,
    mode: "auto",
    priced: true,
  };
  return {
    role: "assistant",
    model: "claude-opus-5",
    timestamp: new Date(0),
    contentSpans: [],
    usage,
    contextTotal: 0,
    composition: zeroComposition(),
    cost,
  };
}

function makeSession(turns: Turn[]): Session {
  return {
    harness: "claude-code",
    harnessVersion: "test",
    id: "session-1",
    cwd: "/tmp/project",
    startedAt: new Date(0),
    endedAt: new Date(0),
    configSnapshot: { model: "claude-opus-5", modelChanges: [] },
    turns,
    events: [],
    children: [],
    warnings: [],
  };
}

describe("buildReportData headline.costLabel", () => {
  it('fifty cents renders as "$0.50"', () => {
    const session = makeSession([makeTurn(0.5)]);
    const data = buildReportData(session, new Date(0), "test");
    expect(data.headline.costLabel).toBe("$0.50");
  });
});
