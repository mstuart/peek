// pi session discovery. Filesystem walk only — no file content is read/parsed
// here (System A vs. System B detection happens in tree.ts at parse time).
// See docs/recon/pi.md § "System A" for the on-disk layout this decodes:
//   $PI_AGENT_DIR ?? ~/.pi/agent + /sessions/--<cwd-with-/-replaced-by-->--/
//   <ISO-ts-colons-dots-to-dashes>_<uuid>.jsonl

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SessionRef } from "../../model/types.js";

const SESSION_FILENAME_RE =
  /^[^_]+_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const SLUG_DIR_RE = /^--(.+)--$/;

// Exported so commands/shared.ts's "no sessions found" messages can name the
// concrete root actually checked (honoring $PI_AGENT_DIR) instead of a vague
// "check discovery roots".
export function defaultRoot(): string {
  const base = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(base, "sessions");
}

/** `--Users-fake-project--` -> `/Users/fake/project`. Lossy for cwd path
 * segments that themselves contain hyphens (recon does not resolve this). */
function decodeCwdSlug(dirName: string): string | undefined {
  const match = SLUG_DIR_RE.exec(dirName);
  const slug = match?.[1];
  if (!slug) {
    return;
  }
  return `/${slug.split("-").join("/")}`;
}

async function collectJsonlFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // biome-ignore lint/performance/noAwaitInLoops: Keep recursive filesystem traversal bounded.
      files.push(...(await collectJsonlFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(full);
    }
  }
  return files;
}

/** Discover pi CLI (System A) and pi-agent-core (System B) session files
 * under the given roots (or the default `~/.pi/agent/sessions/` layout).
 * Missing roots resolve to an empty array — never throws. */
export async function discoverPiSessions(
  roots?: string[]
): Promise<SessionRef[]> {
  const searchRoots = roots && roots.length > 0 ? roots : [defaultRoot()];
  const refs: SessionRef[] = [];

  for (const root of searchRoots) {
    // biome-ignore lint/performance/noAwaitInLoops: Keep recursive filesystem traversal bounded.
    const files = await collectJsonlFiles(root);
    for (const filePath of files) {
      const match = SESSION_FILENAME_RE.exec(basename(filePath));
      const id = match?.[1];
      if (!id) {
        continue;
      }

      let sizeBytes: number;
      let mtime: Date;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: Keep filesystem metadata reads bounded.
        ({ mtime, size: sizeBytes } = await stat(filePath));
      } catch {
        continue;
      }

      const cwd = decodeCwdSlug(basename(dirname(filePath)));
      const ref: SessionRef = {
        harness: "pi",
        id,
        kind: "main",
        mtime,
        path: filePath,
        sizeBytes,
      };
      if (cwd !== undefined) {
        ref.cwd = cwd;
      }
      refs.push(ref);
    }
  }

  return refs;
}
