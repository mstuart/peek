// Trial workspace lifecycle (docs/DESIGN.md § Lane A "Trial isolation").
// Each trial runs in a fresh `git worktree` of the target repo (detached
// HEAD at the current commit) when the target is a git repo, or a
// recursive copy otherwise. Destroy is best-effort and crash-safety is the
// *caller's* job (try/finally around create/run/destroy) — sweepOrphans
// exists precisely because callers can still crash before their finally
// runs; it's what `peek bench clean` drives.

import { cp, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { type SpawnDetachedResult, spawnDetached } from "./proc.js";

export interface Workspace {
  dir: string;
  id: string;
  /** true = created via `git worktree` (destroy via `git worktree remove`);
   * false = plain recursive copy (destroy via `rm -rf`). */
  isWorktree: boolean;
  repoDir: string;
}

export interface SetupResult {
  ok: boolean;
  /** The first setup command that failed, when !ok. */
  failedCommand?: string;
  exitCode?: number | null;
  stderrTail?: string;
}

const GIT_TIMEOUT_MS = 60_000;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(repoDir: string): Promise<boolean> {
  return pathExists(join(repoDir, ".git"));
}

/**
 * Creates a fresh trial workspace under `scratchRoot/<id>`: a detached-HEAD
 * `git worktree` of `repoDir` when it's a git repo, else a recursive copy.
 */
export async function createWorkspace(
  repoDir: string,
  scratchRoot: string,
  id: string,
): Promise<Workspace> {
  const dir = join(scratchRoot, id);

  if (await isGitRepo(repoDir)) {
    const result = await spawnDetached(
      "git",
      ["worktree", "add", "--detach", dir, "HEAD"],
      { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `git worktree add failed (exit ${result.exitCode}): ${result.stderrTail}`,
      );
    }
    return { dir, id, isWorktree: true, repoDir };
  }

  await cp(repoDir, dir, { recursive: true });
  return { dir, id, isWorktree: false, repoDir };
}

/** Destroys a trial workspace. Best-effort: `git worktree remove --force`
 * falls back to `rm -rf` if git itself refuses. */
export async function destroyWorkspace(ws: Workspace): Promise<void> {
  if (ws.isWorktree) {
    const result = await spawnDetached(
      "git",
      ["worktree", "remove", "--force", ws.dir],
      { cwd: ws.repoDir, timeoutMs: GIT_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      await rm(ws.dir, { recursive: true, force: true });
    }
    return;
  }
  await rm(ws.dir, { recursive: true, force: true });
}

/**
 * Runs each setup command through `/bin/sh -c` in the workspace, in order.
 * Stops at the first nonzero exit — the caller marks the trial failed-setup.
 */
export async function runSetup(
  ws: Workspace,
  setup: string[],
  timeoutMs: number,
): Promise<SetupResult> {
  for (const cmd of setup) {
    const result: SpawnDetachedResult = await spawnDetached(
      "/bin/sh",
      ["-c", cmd],
      { cwd: ws.dir, timeoutMs },
    );
    if (result.exitCode !== 0) {
      return {
        ok: false,
        failedCommand: cmd,
        exitCode: result.exitCode,
        stderrTail: result.stderrTail,
      };
    }
  }
  return { ok: true };
}

function parseWorktreeListPorcelain(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.push(line.slice("worktree ".length).trim());
    }
  }
  return paths;
}

function isInsideScratchRoot(candidate: string, scratchRoot: string): boolean {
  const rel = relative(scratchRoot, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Sweeps orphaned trial workspaces left behind by a crash: known `git
 * worktree` entries under `scratchRoot` are removed via `git worktree
 * remove --force` (+ `git worktree prune` to drop stale admin state), then
 * anything still left directly under `scratchRoot` (leftover copy-mode
 * workspaces, or worktree dirs git no longer tracks) is `rm -rf`'d. Returns
 * the list of paths removed. Used by `peek bench clean`.
 */
export async function sweepOrphans(
  scratchRoot: string,
  repoDir: string,
): Promise<string[]> {
  const removed = new Set<string>();

  // `git worktree list` reports realpath-resolved paths (e.g. macOS's
  // /var/folders/... is a symlink to /private/var/folders/...), so compare
  // against scratchRoot's realpath too — a plain string-prefix check
  // against the unresolved path silently misses every orphan on macOS.
  let resolvedScratchRoot = scratchRoot;
  try {
    resolvedScratchRoot = await realpath(scratchRoot);
  } catch {
    // scratchRoot doesn't exist yet — nothing to resolve, nothing to sweep
    // from git's side either.
  }

  if (await isGitRepo(repoDir)) {
    const listResult = await spawnDetached(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS },
    );
    const worktreePaths = parseWorktreeListPorcelain(listResult.stdout);
    for (const wtPath of worktreePaths) {
      if (!isInsideScratchRoot(wtPath, resolvedScratchRoot)) continue;
      const rmResult = await spawnDetached(
        "git",
        ["worktree", "remove", "--force", wtPath],
        { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS },
      );
      // Report the removal using the caller's (unresolved) scratchRoot
      // form rather than git's realpath'd one, so results are consistent
      // with what the caller passed in and with the readdir-based pass
      // below. Safe: every workspace we create lives directly at
      // `scratchRoot/<id>`, so the basename round-trips.
      if (rmResult.exitCode === 0) {
        removed.add(join(scratchRoot, basename(wtPath)));
      }
    }
    await spawnDetached("git", ["worktree", "prune"], {
      cwd: repoDir,
      timeoutMs: GIT_TIMEOUT_MS,
    });
  }

  let entries: string[] = [];
  try {
    entries = await readdir(scratchRoot);
  } catch {
    return [...removed];
  }
  for (const entry of entries) {
    const full = join(scratchRoot, entry);
    await rm(full, { recursive: true, force: true });
    removed.add(full);
  }

  return [...removed];
}
