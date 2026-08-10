// Config-variant overlay (docs/DESIGN.md § Bench design "Config variants"). A
// variant dir may contain CLAUDE.md, AGENTS.md, .claude/settings.json (a
// COMPLETE file, not a fragment — Claude Code never merges within one file
// and silently ignores invalid settings files in headless mode, so a
// partial overlay would silently drop keys and a malformed one would
// silently no-op; audit R-A4 requires we hard-fail loudly instead), and a
// one-line `model` file. Applying overlays a copy into the trial workspace
// only — the user's real config is never touched.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface AppliedConfig {
  appliedFiles: string[];
  model?: string;
}

const SETTINGS_REL_PATH = join(".claude", "settings.json");
const OVERLAY_FILES = ["CLAUDE.md", "AGENTS.md", SETTINGS_REL_PATH];

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** R-A4: JSON-validate settings.json content, hard-failing loudly — the CLI
 * itself won't tell you a settings file is malformed. */
function validateSettingsJson(text: string, path: string): void {
  try {
    JSON.parse(text);
  } catch (err) {
    throw new Error(
      `invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

/**
 * Overlays `variantDir`'s config files onto `workspaceDir` (a trial
 * workspace's repo root). `variantDir === "current"` is a no-op — baseline
 * means "whatever the repo already has". Settings.json is JSON-validated on
 * read AND after write (R-A4): a write that produced unreadable JSON (e.g.
 * a truncated copy) fails the trial loudly rather than silently no-op'ing.
 */
export async function applyConfig(
  variantDir: string | "current",
  workspaceDir: string
): Promise<AppliedConfig> {
  if (variantDir === "current") {
    return { appliedFiles: [] };
  }

  const appliedFiles: string[] = [];

  for (const rel of OVERLAY_FILES) {
    const src = join(variantDir, rel);
    // biome-ignore lint/performance/noAwaitInLoops: Overlay precedence requires ordered application.
    if (!(await fileExists(src))) {
      continue;
    }

    const contents = await readFile(src, "utf8");
    if (rel === SETTINGS_REL_PATH) {
      validateSettingsJson(contents, src);
    }

    const dest = join(workspaceDir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, contents, "utf8");

    if (rel === SETTINGS_REL_PATH) {
      const written = await readFile(dest, "utf8");
      validateSettingsJson(written, dest);
    }

    appliedFiles.push(rel);
  }

  let model: string | undefined;
  const modelPath = join(variantDir, "model");
  if (await fileExists(modelPath)) {
    const trimmed = (await readFile(modelPath, "utf8")).trim();
    if (trimmed === "") {
      throw new Error(`empty "model" file: ${modelPath}`);
    }
    model = trimmed;
  }

  return {
    ...(model === undefined ? {} : { model }),
    appliedFiles,
  };
}
