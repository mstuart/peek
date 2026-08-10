// cli.ts's root-level command routing: bare `peek` (no subcommand) prints
// help and exits 0 (a friendly discoverability default, not an error);
// an unrecognized subcommand name is a real error — exits 1 with a message
// naming the bad command, per the install-gauntlet fix (previously both
// cases fell through the same `program.action(() => program.help())`
// catch-all and BOTH silently exited 0, so scripts couldn't detect a typo'd
// subcommand). Runs `src/cli.ts` through tsx's Node import hook (not
// dist/cli.js) so this test doesn't depend on a prior `npm run build`.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_PATTERN_1 = /Usage: peek/;
const TEST_PATTERN_2 = /peek --help/;
const TEST_PATTERN_3 = /unknown command 'frobnicate'/;
const TEST_PATTERN_4 = /Usage: peek list/;
const TEST_PATTERN_5 = /unknown command 'totally-not-a-command'/;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const CLI = join(REPO_ROOT, "src/cli.ts");

interface RunResult {
  status: number;
  stderr: string;
  stdout: string;
}

function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", CLI, ...args],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }
    );
    return { status: 0, stderr: "", stdout };
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string };
    return { status: e.status ?? 1, stderr: e.stderr, stdout: e.stdout };
  }
}

describe("peek (no subcommand)", () => {
  it("prints help and exits 0", () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(TEST_PATTERN_1);
  });
});

describe("peek <unknown subcommand>", () => {
  it("errors (exit 1) naming the bad command, instead of silently printing help", () => {
    const result = run(["totally-not-a-command"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(TEST_PATTERN_5);
    expect(result.stderr).toMatch(TEST_PATTERN_2);
    // The old bug: this used to print the full help text with exit 0.
    expect(result.stdout).not.toMatch(TEST_PATTERN_1);
  });

  it("still errors when the unknown command carries its own extra positional args", () => {
    const result = run(["frobnicate", "extra-arg"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(TEST_PATTERN_3);
  });
});

describe("peek <registered subcommand> --help", () => {
  it("exits 0 (sanity check: the root catch-all doesn't swallow real subcommands)", () => {
    const result = run(["list", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(TEST_PATTERN_4);
  });
});
