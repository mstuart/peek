import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../..");

function readJson(path: string) {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
}

describe("package distribution metadata", () => {
  it("publishes the scoped package while exposing the peek CLI command", () => {
    const pkg = readJson("package.json");

    expect(pkg.name).toBe("@mstuart/peek");
    expect(pkg.bin).toEqual({ peek: "dist/cli.js" });
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/mstuart/peek.git",
    });
    expect(pkg.bugs?.url).toBe("https://github.com/mstuart/peek/issues");
    expect(pkg.homepage).toBe("https://github.com/mstuart/peek#readme");
    expect(pkg.publishConfig?.access).toBe("public");
  });

  it("keeps package-lock metadata synchronized with package.json", () => {
    const pkg = readJson("package.json");
    const lock = readJson("package-lock.json");

    expect(lock.name).toBe(pkg.name);
    expect(lock.packages[""].name).toBe(pkg.name);
    expect(lock.packages[""].version).toBe(pkg.version);
  });
});
