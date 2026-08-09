// cli.ts's root-level command routing: bare `peek` (no subcommand) prints
// help and exits 0 (a friendly discoverability default, not an error);
// an unrecognized subcommand name is a real error — exits 1 with a message
// naming the bad command, per the install-gauntlet fix (previously both
// cases fell through the same `program.action(() => program.help())`
// catch-all and BOTH silently exited 0, so scripts couldn't detect a typo'd
// subcommand). Spawns `tsx src/cli.ts` directly (not dist/cli.js) so this
// test doesn't depend on a prior `npm run build`.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const TSX = join(REPO_ROOT, "node_modules/.bin/tsx");
const CLI = join(REPO_ROOT, "src/cli.ts");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync(TSX, [CLI, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string };
    return { status: e.status ?? 1, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("peek (no subcommand)", () => {
  it("prints help and exits 0", () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage: peek/);
  });
});

describe("peek <unknown subcommand>", () => {
  it("errors (exit 1) naming the bad command, instead of silently printing help", () => {
    const result = run(["totally-not-a-command"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown command 'totally-not-a-command'/);
    expect(result.stderr).toMatch(/peek --help/);
    // The old bug: this used to print the full help text with exit 0.
    expect(result.stdout).not.toMatch(/Usage: peek/);
  });

  it("still errors when the unknown command carries its own extra positional args", () => {
    const result = run(["frobnicate", "extra-arg"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown command 'frobnicate'/);
  });
});

describe("peek <registered subcommand> --help", () => {
  it("exits 0 (sanity check: the root catch-all doesn't swallow real subcommands)", () => {
    const result = run(["list", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage: peek list/);
  });
});
