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
      assistantText: 0,
      compactionSummaries: 0,
      coordination: 0,
      instructionInjection: 0,
      systemPrompt: 0,
      thinking: 0,
      toolCallArgs: 0,
      toolResults: 0,
      toolSchemas: 0,
      userText: 0,
    },
    residual: 0,
    residualShare: 0,
    truncated: false,
  };
}

function makeTurn(costTotal: number): Turn {
  const usage: NormalizedUsage = {
    cacheRead: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    inputUncached: 0,
    output: 0,
    raw: undefined,
  };
  const cost: CostBreakdown = {
    cacheRead: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
    input: costTotal,
    mode: "auto",
    output: 0,
    priced: true,
    total: costTotal,
  };
  return {
    composition: zeroComposition(),
    contentSpans: [],
    contextTotal: 0,
    cost,
    model: "claude-opus-5",
    role: "assistant",
    timestamp: new Date(0),
    usage,
  };
}

function makeSession(turns: Turn[]): Session {
  return {
    children: [],
    configSnapshot: { model: "claude-opus-5", modelChanges: [] },
    cwd: "/tmp/project",
    endedAt: new Date(0),
    events: [],
    harness: "claude-code",
    harnessVersion: "test",
    id: "session-1",
    startedAt: new Date(0),
    turns,
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
