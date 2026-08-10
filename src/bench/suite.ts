// Bench task suite loader (docs/DESIGN.md § Bench design "Task suite"). Reads
// `.peek/bench/*.json` — one task per file, JSON (not YAML — zero new
// runtime deps per the spec). `verify` exit 0 = success; there is no
// LLM-judge in v2.0, so `verify` is required same as `prompt`/`name`.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface BenchTask {
  name: string;
  prompt: string;
  setup?: string[];
  timeoutS?: number;
  verify: string;
}

function requireNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  file: string
): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`bench task missing required "${key}": ${file}`);
  }
  return value;
}

function validateTask(raw: unknown, file: string): BenchTask {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`bench task file is not a JSON object: ${file}`);
  }
  const obj = raw as Record<string, unknown>;

  const name = requireNonEmptyString(obj, "name", file);
  const prompt = requireNonEmptyString(obj, "prompt", file);
  const verify = requireNonEmptyString(obj, "verify", file);

  let setup: string[] | undefined;
  if (obj.setup !== undefined) {
    if (
      !(
        Array.isArray(obj.setup) &&
        obj.setup.every((s) => typeof s === "string")
      )
    ) {
      throw new Error(
        `bench task "setup" must be an array of strings: ${file}`
      );
    }
    setup = obj.setup as string[];
  }

  let timeoutS: number | undefined;
  if (obj.timeoutS !== undefined) {
    if (
      typeof obj.timeoutS !== "number" ||
      !Number.isFinite(obj.timeoutS) ||
      obj.timeoutS <= 0
    ) {
      throw new Error(
        `bench task "timeoutS" must be a positive number: ${file}`
      );
    }
    ({ timeoutS } = obj);
  }

  return {
    name,
    prompt,
    verify,
    ...(setup === undefined ? {} : { setup }),
    ...(timeoutS === undefined ? {} : { timeoutS }),
  };
}

/**
 * Loads every `*.json` file directly under `dir` as a BenchTask, validating
 * each (missing `name`/`prompt`/`verify` throws, naming the offending file).
 * Returns tasks sorted by `name` (deterministic regardless of filename).
 */
export async function loadSuite(dir: string): Promise<BenchTask[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    throw new Error(`bench suite directory not found: ${dir}`, {
      cause: error,
    });
  }

  const files = entries.filter((f) => f.endsWith(".json")).sort();
  const tasks: BenchTask[] = [];

  for (const file of files) {
    const full = join(dir, file);
    // biome-ignore lint/performance/noAwaitInLoops: Preserve deterministic validation order and errors.
    const text = await readFile(full, "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `bench task file is not valid JSON: ${full} (${err instanceof Error ? err.message : String(err)})`,
        { cause: err }
      );
    }
    tasks.push(validateTask(raw, full));
  }

  return tasks.sort((a, b) => a.name.localeCompare(b.name));
}
