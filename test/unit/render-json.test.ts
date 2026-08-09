import { describe, expect, it } from "vitest";
import { serializeJSON } from "../../src/render/json.js";

describe("serializeJSON", () => {
  it("serializes Dates as ISO-8601 strings", () => {
    const out = serializeJSON({ at: new Date("2026-08-08T12:00:00.000Z") });
    expect(JSON.parse(out)).toEqual({ at: "2026-08-08T12:00:00.000Z" });
  });

  it("2-space indents and omits undefined properties, like JSON.stringify", () => {
    const out = serializeJSON({ a: 1, b: undefined, c: { d: 2 } });
    expect(out).toBe(
      JSON.stringify({ a: 1, b: undefined, c: { d: 2 } }, null, 2),
    );
    expect(JSON.parse(out)).toEqual({ a: 1, c: { d: 2 } });
  });

  it("round-trips nested Dates inside arrays", () => {
    const out = serializeJSON([{ at: new Date(0) }, { at: new Date(1000) }]);
    expect(JSON.parse(out)).toEqual([
      { at: "1970-01-01T00:00:00.000Z" },
      { at: "1970-01-01T00:00:01.000Z" },
    ]);
  });
});
