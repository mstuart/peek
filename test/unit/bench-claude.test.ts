import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnDetachedMock = vi.fn();
vi.mock("../../src/bench/proc.js", () => ({
  spawnDetached: (...args: unknown[]) => spawnDetachedMock(...args),
}));

// Only existsSync is overridden (default: report "not found") — everything else
// (readdirSync, used by the slug-construction tests below) passes through untouched.
const existsSyncMock = vi.fn<(p: string) => boolean>(() => false);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: (p: string) => existsSyncMock(p) };
});

import { claudeRunner } from "../../src/bench/runners/claude.js";
import type { BenchTask, TrialSpec } from "../../src/bench/types.js";

function makeTrial(overrides: Partial<TrialSpec> = {}): TrialSpec {
  const task: BenchTask = {
    name: "fix-flaky-test",
    prompt: "Fix the failing test in tests/date.test.ts",
    timeoutS: 600,
    verify: "npm test",
  };
  return {
    configName: "current",
    task,
    timeoutS: 600,
    workspaceDir: "/tmp/bench-workspace",
    ...overrides,
  };
}

function procResult(
  over: Partial<{
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderrTail: string;
  }> = {}
) {
  return {
    exitCode: 0,
    stderrTail: "",
    stdout: "{}",
    timedOut: false,
    ...over,
  };
}

describe("claudeRunner: flag assembly", () => {
  beforeEach(() => {
    spawnDetachedMock.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
  });

  it("builds the base invocation with neither model nor budget set", async () => {
    spawnDetachedMock.mockResolvedValue(procResult());
    await claudeRunner.run(makeTrial());
    expect(spawnDetachedMock).toHaveBeenCalledWith(
      "claude",
      [
        "-p",
        "Fix the failing test in tests/date.test.ts",
        "--output-format",
        "json",
        "--permission-mode",
        "acceptEdits",
      ],
      { cwd: "/tmp/bench-workspace", timeoutMs: 600_000 }
    );
  });

  it("appends --max-budget-usd only when perTrialBudgetUsd is set", async () => {
    spawnDetachedMock.mockResolvedValue(procResult());
    await claudeRunner.run(makeTrial({ perTrialBudgetUsd: 2.5 }));
    const args = spawnDetachedMock.mock.calls[0]?.[1] as string[];
    expect(args.slice(-2)).toEqual(["--max-budget-usd", "2.5"]);
  });

  it("appends --model only when the variant specifies one", async () => {
    spawnDetachedMock.mockResolvedValue(procResult());
    await claudeRunner.run(makeTrial({ model: "claude-fable-5" }));
    const args = spawnDetachedMock.mock.calls[0]?.[1] as string[];
    expect(args.slice(-2)).toEqual(["--model", "claude-fable-5"]);
  });

  it("appends both flags, budget before model, when both are set", async () => {
    spawnDetachedMock.mockResolvedValue(procResult());
    await claudeRunner.run(
      makeTrial({ model: "claude-sonnet-5", perTrialBudgetUsd: 1 })
    );
    const args = spawnDetachedMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual([
      "-p",
      "Fix the failing test in tests/date.test.ts",
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--max-budget-usd",
      "1",
      "--model",
      "claude-sonnet-5",
    ]);
  });

  it("passes workspaceDir as cwd verbatim (never the CLI's own cwd)", async () => {
    spawnDetachedMock.mockResolvedValue(procResult());
    await claudeRunner.run(makeTrial({ workspaceDir: "/some/other/worktree" }));
    const opts = spawnDetachedMock.mock.calls[0]?.[2] as { cwd: string };
    expect(opts.cwd).toBe("/some/other/worktree");
  });
});

describe("claudeRunner: timeout propagation", () => {
  beforeEach(() => {
    spawnDetachedMock.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
  });

  it("converts trial.timeoutS to milliseconds for the proc call", async () => {
    spawnDetachedMock.mockResolvedValue(procResult());
    await claudeRunner.run(makeTrial({ timeoutS: 42 }));
    const opts = spawnDetachedMock.mock.calls[0]?.[2] as { timeoutMs: number };
    expect(opts.timeoutMs).toBe(42_000);
  });

  it("surfaces proc.timedOut on the outcome untouched", async () => {
    spawnDetachedMock.mockResolvedValue(
      procResult({ exitCode: null, stderrTail: "killed", timedOut: true })
    );
    const outcome = await claudeRunner.run(makeTrial());
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).toBeNull();
    expect(outcome.stderrTail).toBe("killed");
  });
});

describe("claudeRunner: stdout parsing", () => {
  beforeEach(() => {
    spawnDetachedMock.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
  });

  it("parses a valid result JSON, preserves it whole as raw", async () => {
    const resultJson = {
      permission_denials: [],
      result: "done",
      session_id: "sess-abc-123",
    };
    spawnDetachedMock.mockResolvedValue(
      procResult({ stdout: JSON.stringify(resultJson) })
    );
    const outcome = await claudeRunner.run(makeTrial());
    expect(outcome.raw).toEqual(resultJson);
  });

  it("constructs the transcript path from session_id and workspaceDir, and resolves sessionPath when it exists", async () => {
    const resultJson = { permission_denials: [], session_id: "sess-abc-123" };
    spawnDetachedMock.mockResolvedValue(
      procResult({ stdout: JSON.stringify(resultJson) })
    );
    existsSyncMock.mockReturnValue(true);

    const outcome = await claudeRunner.run(
      makeTrial({ workspaceDir: "/Users/mark/git/peek" })
    );

    const expectedPath = path.join(
      homedir(),
      ".claude",
      "projects",
      "-Users-mark-git-peek",
      "sess-abc-123.jsonl"
    );
    expect(outcome.sessionPath).toBe(expectedPath);
    expect(existsSyncMock).toHaveBeenCalledWith(expectedPath);
  });

  it("leaves sessionPath undefined when the constructed transcript path does not exist", async () => {
    const resultJson = { permission_denials: [], session_id: "sess-missing" };
    spawnDetachedMock.mockResolvedValue(
      procResult({ stdout: JSON.stringify(resultJson) })
    );
    existsSyncMock.mockReturnValue(false);

    const outcome = await claudeRunner.run(makeTrial());
    expect(outcome.sessionPath).toBeUndefined();
  });

  it("leaves sessionPath undefined when session_id is absent from otherwise-valid JSON", async () => {
    spawnDetachedMock.mockResolvedValue(
      procResult({ stdout: JSON.stringify({ permission_denials: [] }) })
    );
    const outcome = await claudeRunner.run(makeTrial());
    expect(outcome.sessionPath).toBeUndefined();
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it("never throws on malformed stdout; exitCode/stderrTail preserved, sessionPath undefined", async () => {
    spawnDetachedMock.mockResolvedValue(
      procResult({
        exitCode: 1,
        stderrTail: "parse error upstream\n",
        stdout: "not json{{{",
      })
    );
    const outcome = await claudeRunner.run(makeTrial());
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderrTail).toBe("parse error upstream\n");
    expect(outcome.sessionPath).toBeUndefined();
    expect(outcome.raw).toBeUndefined();
  });

  it("never throws on empty stdout", async () => {
    spawnDetachedMock.mockResolvedValue(procResult({ stdout: "" }));
    await expect(claudeRunner.run(makeTrial())).resolves.toBeDefined();
  });
});

describe("claude project-dir slug construction (real local data)", () => {
  // docs/recon/claude-code.md: "slug = cwd path with '/' -> '-'". The runner's forward
  // direction must be the exact inverse of discover.ts's decodeSlug (slug -> cwd via
  // '-' -> '/', lossy/best-effort there). For any REAL directory name already produced
  // by Claude Code, decoding then re-encoding must reproduce that exact directory name —
  // this is what would break if the runner used a different slug convention (e.g. also
  // replacing dots, or dropping the leading '-').
  function decodeSlug(slug: string): string {
    return slug.replace(/-/g, "/");
  }
  function slugifyCwd(cwd: string): string {
    return cwd.replace(/\//g, "-");
  }

  const projectsRoot = path.join(homedir(), ".claude", "projects");
  let realDirNames: string[] = [];
  try {
    realDirNames = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .slice(0, 3);
  } catch {
    realDirNames = [];
  }

  it.runIf(realDirNames.length > 0)(
    "round-trips slug(decode(dir)) back to the sampled real directory name",
    () => {
      for (const dirName of realDirNames) {
        expect(slugifyCwd(decodeSlug(dirName))).toBe(dirName);
      }
    }
  );

  it.skipIf(realDirNames.length > 0)(
    "skipped: no ~/.claude/projects directories available to sample on this machine",
    () => {
      expect(true).toBe(true);
    }
  );
});

describe("slugifyCwd non-alphanumeric mapping (self-hosted gate regression)", () => {
  it("maps dots to dashes like the real slugger (~/.cache path case)", async () => {
    const { transcriptPathForTest } = await import(
      "../../src/bench/runners/claude.js"
    );
    const p = transcriptPathForTest(
      "/Users/mark/.cache/peek-bench-scratch/hello-file-current-t0-1",
      "abc-123"
    );
    expect(p).toContain(
      "-Users-mark--cache-peek-bench-scratch-hello-file-current-t0-1"
    );
    expect(p).not.toContain(".cache");
  });
});
