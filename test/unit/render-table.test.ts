import { describe, expect, it } from "vitest";
import {
  formatCompact,
  formatNumber,
  renderBar,
  renderTable,
} from "../../src/render/table.js";

describe("formatNumber", () => {
  it("groups thousands with commas", () => {
    expect(formatNumber(12_345)).toBe("12,345");
    expect(formatNumber(1_000_000)).toBe("1,000,000");
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(42)).toBe("42");
  });

  it("preserves the sign on negative numbers", () => {
    expect(formatNumber(-12_345)).toBe("-12,345");
  });
});

describe("formatCompact", () => {
  it("renders sub-1000 values as plain digits", () => {
    expect(formatCompact(823)).toBe("823");
    expect(formatCompact(0)).toBe("0");
  });

  it("renders k/M ranges with one decimal", () => {
    expect(formatCompact(37_481)).toBe("37.5k");
    expect(formatCompact(1_200_000)).toBe("1.2M");
  });

  it("preserves the sign on negative values", () => {
    expect(formatCompact(-2500)).toBe("-2.5k");
  });
});

describe("renderBar", () => {
  it("fills proportionally to the 0..1 share, at the default width", () => {
    expect(renderBar(0)).toBe("░░░░░░░░ 0%");
    expect(renderBar(1)).toBe("████████ 100%");
    expect(renderBar(0.5)).toBe("████░░░░ 50%");
  });

  it("clamps the drawn bar but not the printed percentage for out-of-range shares", () => {
    expect(renderBar(-0.2)).toBe("░░░░░░░░ -20%");
    expect(renderBar(1.5)).toBe("████████ 150%");
  });

  it("supports a custom width", () => {
    expect(renderBar(0.5, 4)).toBe("██░░ 50%");
  });
});

describe("renderTable", () => {
  it("right-aligns a numeric column so shorter values line up at the same column position", () => {
    const table = renderTable(
      [
        { align: "left", header: "name" },
        { align: "right", header: "tokens" },
      ],
      [
        ["userText", "10"],
        ["assistantTextLong", "1,729"],
      ]
    );
    // Header uses picocolors (may carry ANSI codes depending on TTY
    // detection) — only the two plain data rows are asserted on here.
    const lines = table.split("\n").slice(1);
    const nameWidth = "assistantTextLong".length;
    const tokensWidth = "tokens".length;
    expect(lines).toEqual([
      `${"userText".padEnd(nameWidth)}  ${"10".padStart(tokensWidth)}`,
      `${"assistantTextLong".padEnd(nameWidth)}  ${"1,729".padStart(tokensWidth)}`,
    ]);
  });
});
