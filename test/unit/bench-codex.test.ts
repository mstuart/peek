// Lane A, task A3 gate — codex bench runner unit tests.
//
// Covers only what's unit-testable without a real `codex` process (per the
// A3 brief, real-trial evidence lives in the orchestrator report, not here):
// cwd-match rollout resolution against synthetic fixtures, flag assembly,
// and the midnight-crossing two-day scan.

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  resolveCodexRollout,
} from "../../src/bench/runners/codex.js";
import type { TrialSpec } from "../../src/bench/types.js";

function trialSpec(overrides: Partial<TrialSpec> = {}): TrialSpec {
  return {
    task: {
      name: "fix-flaky-test",
      prompt: "Fix the failing test in tests/date.test.ts",
      verify: "npm test",
      timeoutS: 600,
    },
    configName: "current",
    workspaceDir: "/workspaces/target-trial",
    timeoutS: 600,
    ...overrides,
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "peek-bench-codex-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeRollout(
  dir: string,
  fileName: string,
  cwd: string | undefined,
  mtime: Date,
): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, fileName);
  const line1 =
    cwd === undefined
      ? JSON.stringify({
          timestamp: mtime.toISOString(),
          type: "session_meta",
          payload: {},
        })
      : JSON.stringify({
          timestamp: mtime.toISOString(),
          type: "session_meta",
          payload: { cwd },
        });
  writeFileSync(file, `${line1}\n{"type":"other"}\n`);
  utimesSync(file, mtime, mtime);
}

describe("resolveCodexRollout — cwd-match resolution", () => {
  it("returns the file whose line-1 session_meta.payload.cwd matches, among several candidates with different cwds", async () => {
    const trialStart = new Date("2026-08-08T17:00:00.000Z");
    const dayDir = join(root, "2026", "08", "08");
    writeRollout(
      dayDir,
      "rollout-a.jsonl",
      "/workspaces/other-trial-a",
      new Date("2026-08-08T16:00:00.000Z"),
    );
    writeRollout(
      dayDir,
      "rollout-b.jsonl",
      "/workspaces/target-trial",
      new Date("2026-08-08T17:05:00.000Z"),
    );
    writeRollout(
      dayDir,
      "rollout-c.jsonl",
      "/workspaces/other-trial-c",
      new Date("2026-08-08T17:10:00.000Z"),
    );

    const resolved = await resolveCodexRollout(
      "/workspaces/target-trial",
      trialStart,
      root,
    );
    expect(resolved).toBe(join(dayDir, "rollout-b.jsonl"));
  });

  it("picks the newest by mtime when multiple candidates share the matching cwd", async () => {
    const trialStart = new Date("2026-08-08T17:00:00.000Z");
    const dayDir = join(root, "2026", "08", "08");
    writeRollout(
      dayDir,
      "rollout-older.jsonl",
      "/workspaces/target-trial",
      new Date("2026-08-08T17:01:00.000Z"),
    );
    writeRollout(
      dayDir,
      "rollout-newer.jsonl",
      "/workspaces/target-trial",
      new Date("2026-08-08T17:09:00.000Z"),
    );

    const resolved = await resolveCodexRollout(
      "/workspaces/target-trial",
      trialStart,
      root,
    );
    expect(resolved).toBe(join(dayDir, "rollout-newer.jsonl"));
  });

  it("resolves to undefined when no candidate's cwd matches", async () => {
    const trialStart = new Date("2026-08-08T17:00:00.000Z");
    const dayDir = join(root, "2026", "08", "08");
    writeRollout(
      dayDir,
      "rollout-a.jsonl",
      "/workspaces/other-trial-a",
      new Date("2026-08-08T17:01:00.000Z"),
    );
    writeRollout(
      dayDir,
      "rollout-b.jsonl",
      "/workspaces/other-trial-b",
      new Date("2026-08-08T17:02:00.000Z"),
    );

    const resolved = await resolveCodexRollout(
      "/workspaces/target-trial",
      trialStart,
      root,
    );
    expect(resolved).toBeUndefined();
  });

  it("resolves to undefined when the sessions directory has no candidates at all", async () => {
    const trialStart = new Date("2026-08-08T17:00:00.000Z");
    const resolved = await resolveCodexRollout(
      "/workspaces/target-trial",
      trialStart,
      root,
    );
    expect(resolved).toBeUndefined();
  });

  it("ignores a malformed first line instead of throwing", async () => {
    const trialStart = new Date("2026-08-08T17:00:00.000Z");
    const dayDir = join(root, "2026", "08", "08");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(join(dayDir, "rollout-broken.jsonl"), "not json\n{}\n");
    writeRollout(
      dayDir,
      "rollout-good.jsonl",
      "/workspaces/target-trial",
      new Date("2026-08-08T17:05:00.000Z"),
    );

    const resolved = await resolveCodexRollout(
      "/workspaces/target-trial",
      trialStart,
      root,
    );
    expect(resolved).toBe(join(dayDir, "rollout-good.jsonl"));
  });

  it("scans the next calendar day's directory too, for a trial that crosses local midnight", async () => {
    const trialStart = new Date("2026-08-08T23:55:00.000Z");
    const nextDayDir = join(root, "2026", "08", "09");
    writeRollout(
      nextDayDir,
      "rollout-past-midnight.jsonl",
      "/workspaces/target-trial",
      new Date("2026-08-09T00:02:00.000Z"),
    );

    const resolved = await resolveCodexRollout(
      "/workspaces/target-trial",
      trialStart,
      root,
    );
    expect(resolved).toBe(join(nextDayDir, "rollout-past-midnight.jsonl"));
  });

  it("does not match a same-cwd rollout sitting outside the two scanned days", async () => {
    const trialStart = new Date("2026-08-08T17:00:00.000Z");
    const farDir = join(root, "2026", "08", "05");
    writeRollout(
      farDir,
      "rollout-stale.jsonl",
      "/workspaces/target-trial",
      new Date("2026-08-05T17:00:00.000Z"),
    );

    const resolved = await resolveCodexRollout(
      "/workspaces/target-trial",
      trialStart,
      root,
    );
    expect(resolved).toBeUndefined();
  });
});

describe("buildCodexArgs — flag assembly", () => {
  it("assembles the pinned exec invocation with no extra approval flag, prompt last", () => {
    const args = buildCodexArgs(trialSpec());
    expect(args).toEqual([
      "exec",
      "--skip-git-repo-check",
      "-s",
      "workspace-write",
      "Fix the failing test in tests/date.test.ts",
    ]);
  });

  it("inserts -m <model> before the prompt when a variant specifies a model", () => {
    const args = buildCodexArgs(trialSpec({ model: "o3" }));
    expect(args).toEqual([
      "exec",
      "--skip-git-repo-check",
      "-s",
      "workspace-write",
      "-m",
      "o3",
      "Fix the failing test in tests/date.test.ts",
    ]);
  });

  it("omits -m entirely when no model is specified", () => {
    const args = buildCodexArgs(trialSpec());
    expect(args).not.toContain("-m");
  });

  it("does not emit any budget-related flag, even when perTrialBudgetUsd is set (no native flag for codex)", () => {
    const args = buildCodexArgs(trialSpec({ perTrialBudgetUsd: 0.5 }));
    expect(args.join(" ")).not.toMatch(/budget/i);
  });
});
