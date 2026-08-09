// Canonical process-spawn contract (docs/DESIGN.md § Bench design "Task suite" /
// "Trial isolation") shared by every bench runner (owned here — claude,
// codex, and workspace setup-command execution all go through this single
// function). Spawns detached (fresh process group) so a timeout can
// group-kill without ever touching the caller's own group or leaking
// grandchildren an agent harness spawns (audit R-A2: claude spawns
// MCP-server children in the inherited group; a bare `kill(pid)` leaks them,
// and group-killing an *inherited* group can kill the orchestrator itself —
// detached:true + `kill(-pid)` avoids both failure modes).

import { type ChildProcess, spawn } from "node:child_process";

const STDERR_TAIL_BYTES = 2048;
const KILL_ESCALATION_MS = 10_000;

export interface SpawnDetachedOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface SpawnDetachedResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderrTail: string;
}

/** Keeps only the last `maxBytes` UTF-8 bytes of `tail + chunk`. */
function appendTail(tail: string, chunk: string, maxBytes: number): string {
  const combined = tail + chunk;
  const buf = Buffer.from(combined, "utf8");
  if (buf.byteLength <= maxBytes) return combined;
  return buf.subarray(buf.byteLength - maxBytes).toString("utf8");
}

/**
 * Spawns `cmd` detached (fresh process group) and waits for exit or
 * `timeoutMs`. Never rejects — a spawn failure, nonzero exit, or timeout all
 * resolve normally so callers branch on the result instead of try/catch.
 *
 * On timeout: SIGTERM to the whole process group (`kill(-pid, ...)`), then
 * SIGKILL after 10s if the group hasn't exited yet.
 */
export function spawnDetached(
  cmd: string,
  args: string[],
  options: SpawnDetachedOptions,
): Promise<SpawnDetachedResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderrTail = "";
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    function finish(exitCode: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode, timedOut, stdout, stderrTail });
    }

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderrTail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    function killGroup(signal: NodeJS.Signals): void {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // process group already gone — nothing to do
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = appendTail(
        stderrTail,
        chunk.toString("utf8"),
        STDERR_TAIL_BYTES,
      );
    });

    child.on("error", (err) => {
      stderrTail = appendTail(stderrTail, err.message, STDERR_TAIL_BYTES);
      finish(null);
    });

    // "close" (not "exit") — waits for stdio streams to finish flushing so
    // stdout/stderrTail are complete before we resolve.
    child.on("close", (code) => {
      finish(code);
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => {
        killGroup("SIGKILL");
      }, KILL_ESCALATION_MS);
    }, options.timeoutMs);
  });
}
