import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("package version", () => {
  it("is a valid semver string", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
    ) as { version: string };

    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
