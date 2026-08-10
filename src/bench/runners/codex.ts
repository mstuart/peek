// codex bench runner (Lane A, task A3). docs/DESIGN.md § Bench design > "Trial isolation".

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawnDetached } from "../proc.js";
import type { BenchRunner, TrialOutcome, TrialSpec } from "../types.js";

const DEFAULT_SESSIONS_ROOT = path.join(homedir(), ".codex", "sessions");

// Approval-mode pin (audit R-A1): `codex exec --help` on the installed codex-cli
// (0.134.0) exposes NO `-a`/`--ask-for-approval` flag on `exec` — the only
// approval-related flag on this version is `--dangerously-bypass-approvals-and-sandbox`,
// which also disables the sandbox entirely and is strictly MORE dangerous than
// `-s workspace-write` alone. `codex exec` has no TTY approval loop to begin with
// (it's the non-interactive subcommand), so the least-dangerous combination that
// still runs headless without hanging is `-s workspace-write` with NO extra approval
// flag. Verified with one real trial (see A3 orchestrator report for the transcript
// path and evidence): exit 0, no hang, workspace file created, rollout written with
// matching cwd. If a future codex-cli version reintroduces an explicit
// `--ask-for-approval never`-style flag, prefer it explicitly over relying on
// exec's implicit non-interactive default.
const CODEX_EXEC_ARGS = [
  "exec",
  "--skip-git-repo-check",
  "-s",
  "workspace-write",
] as const;

function dateDirParts(d: Date): [string, string, string] {
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return [yyyy, mm, dd];
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(dir, e.name));
}

/** Reads only the first line of a rollout file and extracts `payload.cwd` from
 * its `session_meta` record. Malformed/missing lines resolve to undefined
 * rather than throwing, so one bad file never aborts resolution of the rest. */
async function firstLineCwd(file: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    return;
  }
  const nlIdx = content.indexOf("\n");
  const firstLine = (nlIdx === -1 ? content : content.slice(0, nlIdx)).trim();
  if (!firstLine) {
    return;
  }
  try {
    const parsed = JSON.parse(firstLine) as { payload?: { cwd?: unknown } };
    const cwd = parsed.payload?.cwd;
    return typeof cwd === "string" ? cwd : undefined;
  } catch {
    // Ignore malformed first lines while scanning candidate transcripts.
  }
}

/**
 * Resolves the rollout file for a trial (audit R-A5). Scans the trial-start
 * date's `~/.codex/sessions/YYYY/MM/DD` directory, plus the following
 * calendar day (a trial that straddles local midnight writes into the next
 * day's directory), and matches each candidate rollout's line-1
 * `session_meta.payload.cwd` against `workspaceDir` EXACTLY. Never falls back
 * to "newest file" recency matching — that's not race-free across concurrent
 * runs sharing the same sessions root. Among exact matches, returns the
 * newest by mtime. No match (or no candidates) resolves to undefined.
 *
 * `sessionsRoot` defaults to `~/.codex/sessions` and is overridable for tests.
 */
export async function resolveCodexRollout(
  workspaceDir: string,
  trialStart: Date,
  sessionsRoot: string = DEFAULT_SESSIONS_ROOT
): Promise<string | undefined> {
  const nextDay = new Date(trialStart.getTime() + 24 * 60 * 60 * 1000);
  const dirs = [
    ...new Set(
      [dateDirParts(trialStart), dateDirParts(nextDay)].map((parts) =>
        path.join(sessionsRoot, ...parts)
      )
    ),
  ];

  const candidates: string[] = [];
  for (const dir of dirs) {
    // biome-ignore lint/performance/noAwaitInLoops: Bound filesystem traversal across session directories.
    candidates.push(...(await listJsonlFiles(dir)));
  }

  let best: { file: string; mtimeMs: number } | undefined;
  for (const file of candidates) {
    // biome-ignore lint/performance/noAwaitInLoops: Candidate inspection is intentionally bounded.
    const cwd = await firstLineCwd(file);
    if (cwd !== workspaceDir) {
      continue;
    }
    let mtimeMs: number;
    try {
      ({ mtimeMs } = await stat(file));
    } catch {
      continue;
    }
    if (!best || mtimeMs > best.mtimeMs) {
      best = { file, mtimeMs };
    }
  }
  return best?.file;
}

/** Pure arg assembly, split out from `run()` so flag composition is testable
 * without spawning a real `codex` process. `trial.perTrialBudgetUsd` is
 * intentionally unused: `codex exec` has no native per-trial budget flag
 * (spec: "no native budget flag") — the per-trial timeout is the only
 * per-trial cost rail for this harness. */
export function buildCodexArgs(trial: TrialSpec): string[] {
  const args: string[] = [...CODEX_EXEC_ARGS];
  if (trial.model) {
    args.push("-m", trial.model);
  }
  args.push(trial.task.prompt);
  return args;
}

export const codexRunner: BenchRunner = {
  harness: "codex",

  async run(trial: TrialSpec): Promise<TrialOutcome> {
    const args = buildCodexArgs(trial);
    const startedAt = new Date();
    const proc = await spawnDetached("codex", args, {
      cwd: trial.workspaceDir,
      timeoutMs: trial.timeoutS * 1000,
    });
    const wallMs = Date.now() - startedAt.getTime();

    const sessionPath = await resolveCodexRollout(
      trial.workspaceDir,
      startedAt
    );

    return {
      exitCode: proc.exitCode,
      timedOut: proc.timedOut,
      wallMs,
      ...(sessionPath === undefined ? {} : { sessionPath }),
      stderrTail: proc.stderrTail,
    };
  },
};
