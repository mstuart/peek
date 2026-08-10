// Codex session discovery (T4.3).
//
// Layout (docs/recon/codex.md § Where sessions live): default root
// `~/.codex/sessions/{yyyy}/{mm}/{dd}/rollout-{ISO8601-dashes}-{uuidv7}.jsonl`
// — the trailing uuidv7 is the thread id and becomes SessionRef.id.
//
// The synthetic + real-capture fixtures under test/fixtures/codex live in
// flat, non-dated directories with descriptive filenames (basic-session,
// full-turn, ...) rather than the real `rollout-*` naming, so this walks
// recursively for ANY `.jsonl` file under the given root(s) instead of
// filtering on a `rollout-` prefix — both the real date-tree layout and the
// flat fixture layout resolve the same way. Filenames carrying the real
// trailing-uuid shape still get that uuid as id; filenames without one
// (fixtures) fall back to the filename stem.
//
// Codex has no subagent concept discoverable from the JSONL tree itself
// (state_5.sqlite's `thread_spawn_edges` table records parent/child but
// isn't read here) — every ref this produces is kind "main".

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SessionRef } from "../../model/types.js";

// Exported so commands/shared.ts's "no sessions found" messages can name the
// concrete root actually checked instead of a vague "check discovery roots".
export const DEFAULT_ROOT = path.join(homedir(), ".codex", "sessions");

// Trailing uuid (v4/v7 share the 8-4-4-4-12 hex shape) immediately before
// `.jsonl`, e.g. rollout-2026-08-08T15-13-23-019fe370-1c75-7323-a8c7-
// 3db2a673d0ce.jsonl -> 019fe370-1c75-7323-a8c7-3db2a673d0ce.
const TRAILING_UUID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function idFromFilename(fileName: string): string {
  const match = TRAILING_UUID_RE.exec(fileName);
  if (match?.[1]) {
    return match[1];
  }
  // Synthetic/real-capture fixtures use descriptive names with no uuid —
  // fall back to the filename stem so discovery still works uniformly.
  return fileName.endsWith(".jsonl")
    ? fileName.slice(0, -".jsonl".length)
    : fileName;
}

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function walk(dir: string, refs: SessionRef[]): Promise<void> {
  for (const entry of await readDirSafe(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // biome-ignore lint/performance/noAwaitInLoops: Keep recursive filesystem traversal bounded.
      await walk(full, refs);
      continue;
    }
    if (!(entry.isFile() && entry.name.endsWith(".jsonl"))) {
      continue;
    }

    let info: { size: number; mtime: Date };
    try {
      info = await stat(full);
    } catch {
      continue;
    }

    refs.push({
      harness: "codex",
      id: idFromFilename(entry.name),
      kind: "main",
      mtime: info.mtime,
      path: full,
      sizeBytes: info.size,
    });
  }
}

/**
 * Discover codex rollout session files under the given roots (or the
 * default `~/.codex/sessions/` layout). Missing roots resolve to an empty
 * array — never throws.
 */
export async function discoverCodexSessions(
  roots?: string[]
): Promise<SessionRef[]> {
  const rootDirs = roots ?? [DEFAULT_ROOT];
  const refs: SessionRef[] = [];

  for (const root of rootDirs) {
    // biome-ignore lint/performance/noAwaitInLoops: Keep recursive filesystem traversal bounded.
    await walk(root, refs);
  }

  // Sort by path ascending: deterministic even when fixtures/files share an
  // mtime (e.g. all checked out in the same commit), unlike an mtime sort.
  refs.sort((a, b) => {
    if (a.path < b.path) {
      return -1;
    }
    return a.path > b.path ? 1 : 0;
  });
  return refs;
}
