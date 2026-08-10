// Lane A1 gate (docs/DESIGN.md § Bench design) — unit tests for the
// four bench-infra modules: proc.ts (spawn/timeout/group-kill contract),
// suite.ts (task-file loading + validation), config.ts (variant overlay),
// workspace.ts (worktree/copy lifecycle + orphan sweep). Mirrors
// test/unit/cache.test.ts's tmpdir/mkdtempSync conventions.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyConfig } from "../../src/bench/config.js";
import { spawnDetached } from "../../src/bench/proc.js";
import { loadSuite } from "../../src/bench/suite.js";
import {
  createWorkspace,
  destroyWorkspace,
  runSetup,
  sweepOrphans,
} from "../../src/bench/workspace.js";

const TEST_PATTERN_1 = /not valid JSON/;
const TEST_PATTERN_2 = /setup/;
const TEST_PATTERN_3 = /not found/;
const TEST_PATTERN_4 = /invalid JSON/;
const TEST_PATTERN_5 = /verify/;

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Polling must wait between sequential predicate checks.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "file.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
}

// ---------------------------------------------------------------------------
// proc.ts
// ---------------------------------------------------------------------------

describe("spawnDetached", () => {
  it("captures exit code, stdout, and stderr for a normal exit", async () => {
    const result = await spawnDetached(
      "/bin/sh",
      ["-c", "echo out; echo err 1>&2; exit 7"],
      { cwd: tmpdir(), timeoutMs: 5000 }
    );
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("out\n");
    expect(result.stderrTail).toBe("err\n");
  });

  it("never rejects on nonzero exit", async () => {
    const result = await spawnDetached("/bin/sh", ["-c", "exit 1"], {
      cwd: tmpdir(),
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(1);
  });

  it("truncates stderrTail to the last 2KB", async () => {
    const result = await spawnDetached(
      "/bin/sh",
      ["-c", "yes err | head -c 5000 1>&2"],
      { cwd: tmpdir(), timeoutMs: 5000 }
    );
    const bytes = Buffer.byteLength(result.stderrTail, "utf8");
    expect(bytes).toBeLessThanOrEqual(2048);
    expect(result.stderrTail).not.toContain("out");
  });

  it("resolves (never rejects) when the command doesn't exist", async () => {
    const result = await spawnDetached("/definitely/not/a/real/command", [], {
      cwd: tmpdir(),
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  it("group-kills on timeout, killing the grandchild too", async () => {
    const dir = tmpDir("peek-bench-proc-");
    const shPidFile = join(dir, "sh.pid");
    const grandchildPidFile = join(dir, "grandchild.pid");
    const script = [
      `echo $$ > "${shPidFile}"`,
      "sleep 30 &",
      `echo $! > "${grandchildPidFile}"`,
      "wait",
    ].join("\n");

    const resultPromise = spawnDetached("/bin/sh", ["-c", script], {
      cwd: dir,
      timeoutMs: 300,
    });

    // Wait for both pid files to appear before the timeout fires.
    await waitUntil(
      () => existsSync(shPidFile) && existsSync(grandchildPidFile),
      2000
    );

    const result = await resultPromise;
    expect(result.timedOut).toBe(true);

    const shPid = Number(readFileSync(shPidFile, "utf8").trim());
    const grandchildPid = Number(
      readFileSync(grandchildPidFile, "utf8").trim()
    );

    await waitUntil(() => !(isAlive(shPid) || isAlive(grandchildPid)), 3000);
    expect(isAlive(shPid)).toBe(false);
    expect(isAlive(grandchildPid)).toBe(false);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// suite.ts
// ---------------------------------------------------------------------------

describe("loadSuite", () => {
  it("loads and sorts tasks by name (not filename)", async () => {
    const dir = tmpDir("peek-bench-suite-");
    writeFileSync(
      join(dir, "z-file.json"),
      JSON.stringify({
        name: "a-task",
        prompt: "do a",
        verify: "true",
      })
    );
    writeFileSync(
      join(dir, "a-file.json"),
      JSON.stringify({
        name: "b-task",
        prompt: "do b",
        setup: ["echo setup"],
        timeoutS: 60,
        verify: "true",
      })
    );

    const tasks = await loadSuite(dir);
    expect(tasks.map((t) => t.name)).toEqual(["a-task", "b-task"]);
    expect(tasks[1]).toEqual({
      name: "b-task",
      prompt: "do b",
      setup: ["echo setup"],
      timeoutS: 60,
      verify: "true",
    });
  });

  it("throws naming the file when name/prompt/verify is missing", async () => {
    const dir = tmpDir("peek-bench-suite-");
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ name: "x", prompt: "y" }));

    await expect(loadSuite(dir)).rejects.toThrow(TEST_PATTERN_5);
    await expect(loadSuite(dir)).rejects.toThrow(file);
  });

  it("throws on invalid JSON", async () => {
    const dir = tmpDir("peek-bench-suite-");
    writeFileSync(join(dir, "broken.json"), "{ not json");
    await expect(loadSuite(dir)).rejects.toThrow(TEST_PATTERN_1);
  });

  it("throws when setup is not an array of strings", async () => {
    const dir = tmpDir("peek-bench-suite-");
    writeFileSync(
      join(dir, "task.json"),
      JSON.stringify({ name: "x", prompt: "y", setup: [1], verify: "true" })
    );
    await expect(loadSuite(dir)).rejects.toThrow(TEST_PATTERN_2);
  });

  it("throws for a missing suite directory", async () => {
    await expect(
      loadSuite(join(tmpdir(), "peek-bench-suite-does-not-exist"))
    ).rejects.toThrow(TEST_PATTERN_3);
  });
});

// ---------------------------------------------------------------------------
// config.ts
// ---------------------------------------------------------------------------

describe("applyConfig", () => {
  it("is a no-op for 'current'", async () => {
    const workspaceDir = tmpDir("peek-bench-ws-");
    const result = await applyConfig("current", workspaceDir);
    expect(result).toEqual({ appliedFiles: [] });
    expect("model" in result).toBe(false);
  });

  it("overlays CLAUDE.md, AGENTS.md, .claude/settings.json, and model", async () => {
    const variantDir = tmpDir("peek-bench-variant-");
    const workspaceDir = tmpDir("peek-bench-ws-");
    writeFileSync(join(variantDir, "CLAUDE.md"), "claude rules");
    writeFileSync(join(variantDir, "AGENTS.md"), "agent rules");
    await mkdir(join(variantDir, ".claude"), { recursive: true });
    writeFileSync(
      join(variantDir, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash"] } })
    );
    writeFileSync(join(variantDir, "model"), "claude-opus-5\n");

    // Pre-existing file must be overwritten, not merged.
    writeFileSync(join(workspaceDir, "CLAUDE.md"), "OLD");

    const result = await applyConfig(variantDir, workspaceDir);

    expect(result.model).toBe("claude-opus-5");
    expect(
      result.appliedFiles.sort((left, right) => left.localeCompare(right))
    ).toEqual(
      ["CLAUDE.md", "AGENTS.md", join(".claude", "settings.json")].sort()
    );
    expect(await readFile(join(workspaceDir, "CLAUDE.md"), "utf8")).toBe(
      "claude rules"
    );
    expect(await readFile(join(workspaceDir, "AGENTS.md"), "utf8")).toBe(
      "agent rules"
    );
    const settings = JSON.parse(
      await readFile(join(workspaceDir, ".claude", "settings.json"), "utf8")
    );
    expect(settings).toEqual({ permissions: { allow: ["Bash"] } });
  });

  it("only applies files present in the variant dir", async () => {
    const variantDir = tmpDir("peek-bench-variant-");
    const workspaceDir = tmpDir("peek-bench-ws-");
    writeFileSync(join(variantDir, "CLAUDE.md"), "only this");

    const result = await applyConfig(variantDir, workspaceDir);

    expect(result.appliedFiles).toEqual(["CLAUDE.md"]);
    expect("model" in result).toBe(false);
    expect(existsSync(join(workspaceDir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(workspaceDir, ".claude", "settings.json"))).toBe(
      false
    );
  });

  it("hard-fails loudly on invalid settings.json and writes nothing", async () => {
    const variantDir = tmpDir("peek-bench-variant-");
    const workspaceDir = tmpDir("peek-bench-ws-");
    await mkdir(join(variantDir, ".claude"), { recursive: true });
    writeFileSync(
      join(variantDir, ".claude", "settings.json"),
      "{ not valid json"
    );

    await expect(applyConfig(variantDir, workspaceDir)).rejects.toThrow(
      TEST_PATTERN_4
    );
    expect(existsSync(join(workspaceDir, ".claude", "settings.json"))).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// workspace.ts
// ---------------------------------------------------------------------------

describe("workspace lifecycle", () => {
  it("creates and destroys a git-worktree workspace", async () => {
    const repoDir = tmpDir("peek-bench-repo-");
    initGitRepo(repoDir);
    const scratchRoot = tmpDir("peek-bench-scratch-");

    const ws = await createWorkspace(repoDir, scratchRoot, "trial-1");
    expect(ws.isWorktree).toBe(true);
    expect(existsSync(ws.dir)).toBe(true);
    expect(readFileSync(join(ws.dir, "file.txt"), "utf8")).toBe("hello\n");

    const list = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoDir,
    }).toString();
    expect(list).toContain(ws.dir);

    // detached HEAD: symbolic-ref fails
    expect(() =>
      execFileSync("git", ["symbolic-ref", "-q", "HEAD"], {
        cwd: ws.dir,
        stdio: "pipe",
      })
    ).toThrow();

    await destroyWorkspace(ws);
    expect(existsSync(ws.dir)).toBe(false);
    const listAfter = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoDir,
    }).toString();
    expect(listAfter).not.toContain(ws.dir);
  });

  it("creates and destroys a copy workspace for a non-git dir", async () => {
    const repoDir = tmpDir("peek-bench-nongit-");
    writeFileSync(join(repoDir, "file.txt"), "plain\n");
    const scratchRoot = tmpDir("peek-bench-scratch-");

    const ws = await createWorkspace(repoDir, scratchRoot, "trial-1");
    expect(ws.isWorktree).toBe(false);
    expect(readFileSync(join(ws.dir, "file.txt"), "utf8")).toBe("plain\n");

    await destroyWorkspace(ws);
    expect(existsSync(ws.dir)).toBe(false);
  });

  it("runs setup commands via /bin/sh -c, stopping at the first failure", async () => {
    const repoDir = tmpDir("peek-bench-repo-");
    initGitRepo(repoDir);
    const scratchRoot = tmpDir("peek-bench-scratch-");
    const ws = await createWorkspace(repoDir, scratchRoot, "trial-1");

    try {
      const ok = await runSetup(ws, ["touch a.txt"], 5000);
      expect(ok).toEqual({ ok: true });
      expect(existsSync(join(ws.dir, "a.txt"))).toBe(true);

      const fail = await runSetup(
        ws,
        ["touch b.txt", "exit 2", "touch c.txt"],
        5000
      );
      expect(fail.ok).toBe(false);
      expect(fail.failedCommand).toBe("exit 2");
      expect(fail.exitCode).toBe(2);
      expect(existsSync(join(ws.dir, "b.txt"))).toBe(true);
      expect(existsSync(join(ws.dir, "c.txt"))).toBe(false);
    } finally {
      await destroyWorkspace(ws);
    }
  });

  it("sweeps orphaned git-worktree and copy-mode workspaces", async () => {
    const repoDir = tmpDir("peek-bench-repo-");
    initGitRepo(repoDir);
    const scratchRoot = tmpDir("peek-bench-scratch-");

    // Simulate a crash: create a workspace and never destroy it.
    const ws = await createWorkspace(repoDir, scratchRoot, "orphan-1");
    expect(existsSync(ws.dir)).toBe(true);

    // Also simulate a leftover copy-mode dir git doesn't know about.
    const strayDir = join(scratchRoot, "stray-copy");
    mkdirSync(strayDir, { recursive: true });
    writeFileSync(join(strayDir, "marker.txt"), "x");

    const removed = await sweepOrphans(scratchRoot, repoDir);

    expect(removed).toContain(ws.dir);
    expect(removed).toContain(strayDir);
    expect(existsSync(ws.dir)).toBe(false);
    expect(existsSync(strayDir)).toBe(false);

    const list = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoDir,
    }).toString();
    expect(list).not.toContain(ws.dir);
  });
});
