// Suite trust store (docs/DESIGN.md § Bench design "Safety/cost rails" — closes a gap: `--yes`
// removed the only human gate standing between `peek bench run` and executing arbitrary shell
// commands from a task suite file). direnv-style: before running anything, `peek bench run`
// computes a canonical content hash of the suite (every task file's setup/verify shell command
// strings, plus any non-"current" config variant's overlay files — both are code-equivalent
// inputs that end up running with the invoking user's OS permissions) and checks it against a
// persisted trust store. A first-seen or CHANGED suite requires an explicit trust decision;
// `--yes` (which only skips the cost-estimate confirm in commands/bench.ts) never bypasses this.

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ConfigVariant } from "./run.js";
import type { BenchTask } from "./suite.js";

// ---------------------------------------------------------------------------
// Store: `${XDG_CACHE_HOME ?? ~/.cache}/peek/trusted-suites.json` — sibling to
// cache/totals.ts's totals-v1.jsonl and pricing/modelsDev.ts's models-dev.json in the same
// peek cache dir. `{hash: {firstTrustedAt, suitePath}}`.
// ---------------------------------------------------------------------------

export interface TrustStoreEntry {
  firstTrustedAt: string; // ISO
  suitePath: string;
}

export type TrustStore = Record<string, TrustStoreEntry>;

function resolveTrustStorePath(override?: string): string {
  if (override) {
    return override;
  }
  const base = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(base, "peek", "trusted-suites.json");
}

// This file records which arbitrary-shell-command suites the user has trusted — tightened to
// owner-only (0700 dir / 0600 file), same rationale and pattern as cache/totals.ts's permission
// hardening: another account on a shared machine shouldn't be able to read or race-modify it.
// mkdir's/writeFile's `mode` option only applies to a path that doesn't yet exist, so an
// explicit chmod after every create/write (and on load, for a store left loose by a peek
// version predating this fix) is required to actually guarantee the tightened mode.
const STORE_DIR_MODE = 0o700;
const STORE_FILE_MODE = 0o600;

/** Best-effort chmod — failure is silently ignored (see cache/totals.ts's identical helper):
 * this is host-local convenience state, never worth crashing `peek bench run` over. */
async function tightenPerms(targetPath: string, mode: number): Promise<void> {
  try {
    await chmod(targetPath, mode);
  } catch {
    // best-effort — ignore
  }
}

function isValidStore(value: unknown): value is TrustStore {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every((v) => {
    if (typeof v !== "object" || v === null) {
      return false;
    }
    const e = v as Record<string, unknown>;
    return (
      typeof e.firstTrustedAt === "string" && typeof e.suitePath === "string"
    );
  });
}

/** Loads the trust store. Never throws: a missing file yields an empty store; corrupt JSON or
 * the wrong shape also yields an empty store (never a crash over a convenience file — worst
 * case is re-prompting for trust). Tightens pre-existing loose permissions on a successful
 * read, mirroring cache/totals.ts's load-time tightening. */
export async function loadTrustStore(
  storePathOverride?: string
): Promise<TrustStore> {
  const storePath = resolveTrustStorePath(storePathOverride);
  let raw: string;
  try {
    raw = await readFile(storePath, "utf8");
  } catch {
    return {}; // missing/unreadable — start with an empty store
  }
  await tightenPerms(storePath, STORE_FILE_MODE);
  await tightenPerms(path.dirname(storePath), STORE_DIR_MODE);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {}; // corrupt JSON — silently ignored
  }
  return isValidStore(parsed) ? parsed : {};
}

/** Whether `hash` has already been trusted. */
export async function isSuiteTrusted(
  hash: string,
  storePathOverride?: string
): Promise<boolean> {
  const store = await loadTrustStore(storePathOverride);
  return hash in store;
}

/** Records `hash` as trusted (a pre-existing entry's `firstTrustedAt` is preserved — re-trusting
 * an already-trusted hash, e.g. via a repeated `--trust-suite` run, is a no-op on the timestamp). */
export async function trustSuite(
  hash: string,
  suitePath: string,
  storePathOverride?: string
): Promise<void> {
  const storePath = resolveTrustStorePath(storePathOverride);
  const store = await loadTrustStore(storePathOverride);
  if (!(hash in store)) {
    store[hash] = { firstTrustedAt: new Date().toISOString(), suitePath };
  }

  const dir = path.dirname(storePath);
  await mkdir(dir, { mode: STORE_DIR_MODE, recursive: true });
  await tightenPerms(dir, STORE_DIR_MODE);
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: STORE_FILE_MODE,
  });
  await tightenPerms(storePath, STORE_FILE_MODE);
}

// ---------------------------------------------------------------------------
// Canonical suite hash.
// ---------------------------------------------------------------------------

// Mirrors config.ts's OVERLAY_FILES list (not exported there) — the files a non-"current"
// config variant can overlay into a trial workspace. Re-declared here rather than reaching
// across a command module boundary, the same convention commands/bench.ts's own header comment
// documents for its small local helpers.
const CONFIG_OVERLAY_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  path.join(".claude", "settings.json"),
  "model",
];

interface HashEntry {
  data: Buffer;
  key: string;
}

async function suiteFileEntries(suiteDir: string): Promise<HashEntry[]> {
  let names: string[];
  try {
    names = await readdir(suiteDir);
  } catch {
    return [];
  }
  const files = names.filter((f) => f.endsWith(".json")).sort();
  const entries: HashEntry[] = [];
  for (const file of files) {
    entries.push({
      // biome-ignore lint/performance/noAwaitInLoops: Preserve deterministic hash-entry ordering.
      data: await readFile(path.join(suiteDir, file)),
      key: `suite/${file}`,
    });
  }
  return entries;
}

async function configFileEntries(
  config: ConfigVariant,
  role: "a" | "b"
): Promise<HashEntry[]> {
  if (config.dir === "current") {
    return [];
  }
  const entries: HashEntry[] = [];
  for (const rel of CONFIG_OVERLAY_FILES) {
    try {
      entries.push({
        // biome-ignore lint/performance/noAwaitInLoops: Preserve deterministic hash-entry ordering.
        data: await readFile(path.join(config.dir, rel)),
        key: `config-${role}/${rel}`,
      });
    } catch {
      // not present in this variant — skip, mirrors config.ts's fileExists check
    }
  }
  return entries;
}

/**
 * Canonical content hash of one `peek bench run` invocation's inputs: every suite task file's
 * raw bytes (suite dir, `*.json`, sorted by filename) plus every non-"current" config variant's
 * overlay files (CLAUDE.md/AGENTS.md/.claude/settings.json/model, each read as raw bytes when
 * present). This — not the suite's directory path — is what a trust decision is keyed on:
 * editing a single setup/verify command, or swapping config-b's overlay, changes the hash and
 * forces a re-prompt (direnv-style), even when the CLI invocation's flags stay identical.
 */
export async function computeSuiteHash(
  suiteDir: string,
  configs: readonly [ConfigVariant, ConfigVariant]
): Promise<string> {
  const entries = [
    ...(await suiteFileEntries(suiteDir)),
    ...(await configFileEntries(configs[0], "a")),
    ...(await configFileEntries(configs[1], "b")),
  ].sort((x, y) => x.key.localeCompare(y.key));

  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.key);
    hash.update("\0");
    hash.update(entry.data);
    hash.update("\0");
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Trust prompt text — printed before the interactive y/N confirm.
// ---------------------------------------------------------------------------

async function existingOverlayFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const rel of CONFIG_OVERLAY_FILES) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Keep optional overlay probing bounded and ordered.
      await stat(path.join(dir, rel));
      found.push(rel);
    } catch {
      // not present — skip
    }
  }
  return found;
}

/**
 * Renders the trust prompt body: every task's setup/verify command verbatim, the task count,
 * and which config overlay files would be applied. The point is the user can SEE every shell
 * command about to run with their OS permissions before trusting a hash, not just a hex string.
 */
export async function formatTrustPrompt(
  suiteDir: string,
  suite: readonly BenchTask[],
  configs: readonly [ConfigVariant, ConfigVariant]
): Promise<string> {
  const lines: string[] = [];
  lines.push(
    `peek bench run hasn't trusted this suite before (or it changed): ${suiteDir}`
  );
  lines.push("");
  lines.push(`${suite.length} task${suite.length === 1 ? "" : "s"}:`);
  for (const task of suite) {
    lines.push(`  ${task.name}`);
    for (const cmd of task.setup ?? []) {
      lines.push(`    setup:  ${cmd}`);
    }
    lines.push(`    verify: ${task.verify}`);
  }

  const roles: readonly ["a" | "b", ConfigVariant][] = [
    ["a", configs[0]],
    ["b", configs[1]],
  ];
  for (const [role, config] of roles) {
    if (config.dir === "current") {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Preserve deterministic prompt section ordering.
    const files = await existingOverlayFiles(config.dir);
    lines.push("");
    lines.push(`config-${role} (${config.name}): ${config.dir}`);
    lines.push(
      files.length > 0
        ? `  config files: ${files.join(", ")}`
        : "  config files: (none found)"
    );
  }

  lines.push("");
  lines.push(
    "These commands will run with your user's permissions. Trust this suite?"
  );
  return lines.join("\n");
}
