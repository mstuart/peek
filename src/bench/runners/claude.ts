// claude-code bench runner (Lane A, task A2). docs/DESIGN.md § Bench design > "Trial isolation".

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnDetached } from "../proc.js";
import type { BenchRunner, TrialOutcome, TrialSpec } from "../types.js";

// Slug = every NON-ALPHANUMERIC char -> "-", not just "/" (measured 2026-08-09,
// self-hosted bench gate: a workspace under ~/.cache/... produced the real dir
// `-Users-mark--cache-peek-bench-scratch-...` — the "." maps to "-" too; a
// slash-only slugify built a nonexistent path and every trial lost its totals).
// This is the FORWARD direction (cwd -> slug); discover.ts's decodeSlug is the lossy
// inverse used for display only. Transcript path is CONSTRUCTED, never discovered
// (audit R-A3: the slug is not collision-free, so directory discovery is forbidden —
// the session-id path, built from the verified session_id in the result JSON, is exact).
function slugifyCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Exported for tests only (slug regression coverage). */
export function transcriptPathForTest(
  workspaceDir: string,
  sessionId: string
): string {
  return transcriptPath(workspaceDir, sessionId);
}

function transcriptPath(workspaceDir: string, sessionId: string): string {
  return path.join(
    homedir(),
    ".claude",
    "projects",
    slugifyCwd(workspaceDir),
    `${sessionId}.jsonl`
  );
}

export const claudeRunner: BenchRunner = {
  harness: "claude-code",

  async run(trial: TrialSpec): Promise<TrialOutcome> {
    const args = [
      "-p",
      trial.task.prompt,
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
    ];
    if (trial.perTrialBudgetUsd !== undefined) {
      args.push("--max-budget-usd", String(trial.perTrialBudgetUsd));
    }
    if (trial.model) {
      args.push("--model", trial.model);
    }

    const startedAt = Date.now();
    const proc = await spawnDetached("claude", args, {
      cwd: trial.workspaceDir,
      timeoutMs: trial.timeoutS * 1000,
    });
    const wallMs = Date.now() - startedAt;

    // Malformed stdout must never throw — fall through with raw/sessionId left unset
    // and let exitCode/stderrTail carry the forensic trail.
    let raw: unknown;
    let sessionId: string | undefined;
    try {
      const parsed = JSON.parse(proc.stdout) as Record<string, unknown>;
      raw = parsed;
      if (typeof parsed.session_id === "string") {
        sessionId = parsed.session_id;
      }
    } catch {
      // leave raw/sessionId unset
    }

    let sessionPath: string | undefined;
    if (sessionId) {
      const candidate = transcriptPath(trial.workspaceDir, sessionId);
      if (existsSync(candidate)) {
        sessionPath = candidate;
      }
      // Missing file: sessionPath stays undefined; proc's stderrTail is preserved as-is
      // (not rewritten) so the trial record still carries whatever the process reported.
    }

    return {
      exitCode: proc.exitCode,
      timedOut: proc.timedOut,
      wallMs,
      ...(sessionPath === undefined ? {} : { sessionPath }),
      raw,
      stderrTail: proc.stderrTail,
    };
  },
};
