// Claude Code session discovery (T1.3).
//
// Layout (docs/recon/claude-code.md § Directory layout):
//   <root>/<cwd-slug>/<sessionId>.jsonl                          main session
//   <root>/<cwd-slug>/<sessionId>/subagents/agent-<id>.jsonl     subagent (incl. nested
//                                                                  subagents/workflows/wf_<id>/...)
//   <root>/<cwd-slug>/<sessionId>/subagents/agent-<id>.meta.json ignored (parse()'s job)
//   <root>/<cwd-slug>/<sessionId>/tool-results/*                 ignored (offloaded content)
//   <root>/<cwd-slug>/<sessionId>/workflows/wf_<id>.json         ignored (not a transcript)
//
// A session directory may hold ONLY `subagents/` with no sibling top-level `.jsonl`
// (team/headless coordinators) — that must not produce a fabricated "main" SessionRef.

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SessionRef } from "../../model/types.js";

// Exported so commands/shared.ts's "no sessions found" messages can name the
// concrete root actually checked instead of a vague "check discovery roots".
export const DEFAULT_ROOT = path.join(homedir(), ".claude", "projects");

// The real slug format maps BOTH "/" and "-" in the source cwd to "-", so this decode
// is lossy and best-effort — it exists for display only, never re-derive a real path from it.
function decodeSlug(slug: string): string {
  return slug.replace(/-/g, "/");
}

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function walkSubagents(
  dir: string,
  parentId: string,
  cwd: string,
  refs: SessionRef[],
): Promise<void> {
  for (const entry of await readDirSafe(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Recurse into nested subagents/workflows/wf_<id>/... trees.
      await walkSubagents(full, parentId, cwd, refs);
      continue;
    }
    if (!entry.isFile()) continue;
    const match = /^agent-(.+)\.jsonl$/.exec(entry.name);
    if (!match) continue; // skips agent-*.meta.json and anything else
    const id = match[1] as string;
    let info: { size: number; mtime: Date };
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    refs.push({
      harness: "claude-code",
      id,
      path: full,
      cwd,
      sizeBytes: info.size,
      mtime: info.mtime,
      kind: "subagent",
      parentId,
    });
  }
}

async function walkSlugDir(
  slugDir: string,
  cwd: string,
  refs: SessionRef[],
): Promise<void> {
  for (const entry of await readDirSafe(slugDir)) {
    const full = path.join(slugDir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const id = entry.name.slice(0, -".jsonl".length);
      let info: { size: number; mtime: Date };
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      refs.push({
        harness: "claude-code",
        id,
        path: full,
        cwd,
        sizeBytes: info.size,
        mtime: info.mtime,
        kind: "main",
      });
      continue;
    }
    if (entry.isDirectory()) {
      // Only `subagents/` is a transcript source; `tool-results/` and `workflows/*.json`
      // are ignored by not being walked at all.
      await walkSubagents(path.join(full, "subagents"), entry.name, cwd, refs);
    }
  }
}

export async function discoverClaudeSessions(
  roots?: string[],
): Promise<SessionRef[]> {
  const rootDirs = roots ?? [DEFAULT_ROOT];
  const refs: SessionRef[] = [];

  for (const root of rootDirs) {
    for (const slugEntry of await readDirSafe(root)) {
      if (!slugEntry.isDirectory()) continue;
      const slugDir = path.join(root, slugEntry.name);
      await walkSlugDir(slugDir, decodeSlug(slugEntry.name), refs);
    }
  }

  // Sort by path ascending: deterministic even when fixtures/files share an mtime
  // (e.g. all checked out in the same commit), unlike an mtime-based sort.
  refs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return refs;
}
