// `peek bench` (A4 deliverable #4, docs/DESIGN.md § Bench design).
// Three subcommands:
//   - `peek bench run --suite <dir> --config-a <dir|current> --config-b <dir|current>`
//     — loads the suite (suite.ts), resolves the two config variants, picks
//     a runner (bench/runners/*.ts) by --harness, prints the upfront
//     estimate + confirm prompt (skip with --yes), runs run.ts's orchestrate
//     loop, prints per-trial progress to stderr, and a final A/B comparison
//     table (compare.ts) to stdout.
//   - `peek bench report <results.jsonl> [-o out.html]` — replays the same
//     comparison from a saved results file; text table always, HTML with -o.
//   - `peek bench clean` — sweeps orphaned trial workspaces
//     (workspace.ts's sweepOrphans).

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import pc from "picocolors";
import {
  buildCompareTable,
  type CompareDeltaRow,
  type CompareTable,
} from "../bench/compare.js";
import { renderBenchReportHtml } from "../bench/reportHtml.js";
import {
  createResultsWriter,
  type ResultsWriter,
  readResults,
} from "../bench/results.js";
import {
  type ConfigVariant,
  formatEstimateLine,
  type OrchestrateResult,
  orchestrate,
} from "../bench/run.js";
import { claudeRunner } from "../bench/runners/claude.js";
import { codexRunner } from "../bench/runners/codex.js";
import { loadSuite } from "../bench/suite.js";
import {
  computeSuiteHash,
  formatTrustPrompt,
  isSuiteTrusted,
  trustSuite,
} from "../bench/trust.js";
import type { BenchRunner } from "../bench/types.js";
import { sweepOrphans } from "../bench/workspace.js";
import type { HarnessId } from "../model/types.js";
import { serializeJSON } from "../render/json.js";
import { formatNumber, renderTable } from "../render/table.js";

// ---------------------------------------------------------------------------
// Small local helpers (mirrors of patterns already used in report.ts/cost.ts
// — not exported from either, so re-declared here rather than reaching
// across a command module boundary for a few lines of formatting/version
// lookup).
// ---------------------------------------------------------------------------

const RUNNABLE_HARNESS_IDS: readonly HarnessId[] = ["claude-code", "codex"];
const YES_RE = /^y(es)?$/i;

function parseBenchHarnessOption(value: string): HarnessId {
  if ((RUNNABLE_HARNESS_IDS as readonly string[]).includes(value)) {
    return value as HarnessId;
  }
  throw new Error(
    `--harness must be one of ${RUNNABLE_HARNESS_IDS.join(", ")} (got: ${value}` +
      `${value === "pi" ? " — pi is deferred to v2.1" : ""})`
  );
}

function parsePositiveInt(flag: string) {
  return (value: string): number => {
    const n = Number.parseInt(value, 10);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${flag} must be a positive integer (got: ${value})`);
    }
    return n;
  };
}

function parsePositiveNumber(flag: string) {
  return (value: string): number => {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`${flag} must be a positive number (got: ${value})`);
    }
    return n;
  };
}

function readPeekVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i += 1) {
    const candidate = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === "peek-agent" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // keep walking
    }
    dir = path.dirname(dir);
  }
  return "unknown";
}

const RUNNERS: Partial<Record<HarnessId, BenchRunner>> = {
  "claude-code": claudeRunner,
  codex: codexRunner,
};

function runnerFor(harness: HarnessId): BenchRunner {
  const runner = RUNNERS[harness];
  if (!runner) {
    throw new Error(
      `no bench runner wired for harness "${harness}" (pi is deferred to v2.1 — the BenchRunner interface is harness-agnostic but no pi runner exists yet)`
    );
  }
  return runner;
}

/** `--config-a`/`--config-b <dir|current>` -> a named ConfigVariant. Name is
 * the resolved dir's basename ("current" stays "current"). */
function resolveConfigVariant(arg: string): ConfigVariant {
  if (arg === "current") {
    return { dir: "current", name: "current" };
  }
  return { dir: path.resolve(arg), name: path.basename(path.resolve(arg)) };
}

/** Disambiguates configA/configB when they'd otherwise share a display name
 * (e.g. two different directories both named "variant", or both "current"
 * somehow) — compare.ts groups by name, so a collision would silently merge
 * two distinct configs' trials into one cell. */
function resolveConfigPair(
  aArg: string,
  bArg: string
): [ConfigVariant, ConfigVariant] {
  const a = resolveConfigVariant(aArg);
  const b = resolveConfigVariant(bArg);
  if (a.name === b.name) {
    return [
      { ...a, name: `${a.name}-a` },
      { ...b, name: `${b.name}-b` },
    ];
  }
  return [a, b];
}

// ---------------------------------------------------------------------------
// Comparison table -> text (renderTable).
// ---------------------------------------------------------------------------

function deltaLabel(label: string): string {
  if (label.startsWith("+")) {
    return pc.green(label);
  }
  if (label.startsWith("-")) {
    return pc.red(label);
  }
  return label;
}

/** Exported for tests only (bench-compare.test.ts's "report table structure"
 * coverage) — production callers go through printCompareTable. */
export function deltaRowToCells(row: CompareDeltaRow): string[] {
  return [
    row.taskName,
    row.a.successRateLabel,
    row.b.successRateLabel,
    deltaLabel(row.successDeltaLabel),
    row.a.medianWallLabel,
    row.b.medianWallLabel,
    deltaLabel(row.wallDeltaLabel),
    row.a.medianTokensLabel,
    row.b.medianTokensLabel,
    deltaLabel(row.tokensDeltaLabel),
    row.a.medianCostLabel,
    row.b.medianCostLabel,
    deltaLabel(row.costDeltaLabel),
    row.a.compactionTotalLabel,
    row.b.compactionTotalLabel,
    deltaLabel(row.compactionDeltaLabel),
  ];
}

export function printCompareTable(table: CompareTable): void {
  process.stdout.write(
    `\npeek bench — ${pc.bold(table.configA)} (a) vs ${pc.bold(table.configB)} (b)\n\n`
  );

  if (table.missing.length > 0) {
    process.stdout.write(
      pc.yellow(
        `note: ${table.missing.length} task(s) missing from one side — ${table.missing
          .map(
            (m) =>
              `${m.taskName} (no trials for ${m.missingConfig === "a" ? table.configA : table.configB})`
          )
          .join(", ")}\n\n`
      )
    );
  }

  const columns = [
    { header: "task" },
    { align: "right" as const, header: "success a" },
    { align: "right" as const, header: "success b" },
    { header: "Δ" },
    { align: "right" as const, header: "wall a" },
    { align: "right" as const, header: "wall b" },
    { header: "Δ" },
    { align: "right" as const, header: "tokens a" },
    { align: "right" as const, header: "tokens b" },
    { header: "Δ" },
    { align: "right" as const, header: "cost a" },
    { align: "right" as const, header: "cost b" },
    { header: "Δ" },
    { align: "right" as const, header: "compactions a" },
    { align: "right" as const, header: "compactions b" },
    { header: "Δ" },
  ];

  const rows = table.deltas.map(deltaRowToCells);
  if (table.overall) {
    rows.push(deltaRowToCells(table.overall.delta));
  }

  if (rows.length === 0) {
    process.stdout.write(pc.dim("no task ran under both configs\n"));
    return;
  }
  process.stdout.write(`${renderTable(columns, rows)}\n`);
}

// ---------------------------------------------------------------------------
// `peek bench run`
// ---------------------------------------------------------------------------

async function confirmRun(promptText: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${promptText} [y/N] `);
    return YES_RE.test(answer.trim());
  } finally {
    rl.close();
  }
}

export interface BenchRunCommandOptions {
  configA: string;
  configB: string;
  harness?: HarnessId;
  json?: boolean;
  maxCost?: number;
  repo?: string; // test-only escape hatch; defaults to process.cwd()
  suite: string;
  timeout?: number;
  trials?: number;
  /** Test-only escape hatch: overrides the XDG trust-store path (see bench/trust.ts). */
  trustStorePathOverride?: string;
  /** Trusts this suite (records its content hash) without the interactive trust prompt — the
   * only way to get past a first-seen/changed suite non-interactively. Distinct from `--yes`,
   * which only skips the cost-estimate confirm below and never bypasses the trust gate. */
  trustSuite?: boolean;
  yes?: boolean;
}

/**
 * Suite trust gate — runs BEFORE the cost estimate/`--yes` confirm, and `--yes` does not skip
 * it (see bench/trust.ts header). A trusted hash (unchanged suite + config overlays) proceeds
 * silently; a first-seen or changed suite either records trust via `--trust-suite` or prompts
 * interactively; a non-interactive session without `--trust-suite` hard-aborts rather than
 * silently running untrusted shell commands.
 *
 * Exported for tests only (bench-trust.test.ts's flag/TTY decision-matrix coverage, which needs
 * to exercise this without running a real agent through the rest of runBenchRunCommand) —
 * production callers go through runBenchRunCommand.
 */
export async function ensureSuiteTrusted(
  options: BenchRunCommandOptions,
  suite: Awaited<ReturnType<typeof loadSuite>>,
  configA: ConfigVariant,
  configB: ConfigVariant
): Promise<boolean> {
  const hash = await computeSuiteHash(options.suite, [configA, configB]);
  if (await isSuiteTrusted(hash, options.trustStorePathOverride)) {
    return true;
  }

  if (options.trustSuite) {
    await trustSuite(hash, options.suite, options.trustStorePathOverride);
    return true;
  }

  process.stderr.write(
    `${await formatTrustPrompt(options.suite, suite, [configA, configB])}\n`
  );
  const trusted = await confirmRun("Trust this suite?"); // confirmRun appends " [y/N] " itself
  if (!trusted) {
    if (process.stdin.isTTY) {
      process.stderr.write("aborted — suite not trusted\n");
    } else {
      process.stderr.write(
        "aborted — this suite is not yet trusted and stdin is not a TTY; re-run with --trust-suite to trust it non-interactively\n"
      );
    }
    process.exitCode = 1;
    return false;
  }
  await trustSuite(hash, options.suite, options.trustStorePathOverride);
  return true;
}

export async function runBenchRunCommand(
  options: BenchRunCommandOptions
): Promise<void> {
  const harness = options.harness ?? "claude-code";
  const runner = runnerFor(harness);
  const suite = await loadSuite(options.suite);
  if (suite.length === 0) {
    throw new Error(`no task files (*.json) found under ${options.suite}`);
  }
  const [configA, configB] = resolveConfigPair(
    options.configA,
    options.configB
  );

  if (!(await ensureSuiteTrusted(options, suite, configA, configB))) {
    return; // ensureSuiteTrusted already set process.exitCode and printed the abort reason
  }

  const trials = options.trials ?? 1;
  const repoDir = options.repo ?? process.cwd();

  const estimateLine = formatEstimateLine(suite.length, trials, 2);
  process.stderr.write(`${estimateLine}\n`);

  if (!options.yes) {
    const confirmed = await confirmRun("Proceed?");
    if (!confirmed) {
      process.stderr.write("aborted — pass --yes to skip this prompt\n");
      process.exitCode = 1;
      return;
    }
  }

  const resultsWriter: ResultsWriter = await createResultsWriter();
  process.stderr.write(`writing results to ${resultsWriter.path}\n`);

  const orchestrateOpts: Parameters<typeof orchestrate>[0] = {
    configs: [configA, configB],
    harness,
    onProgress: (event) => {
      if (event.kind === "trial-start") {
        process.stderr.write(
          `[${event.trialIndex + 1}] ${event.taskName} / ${event.configName} — starting\n`
        );
      } else if (event.kind === "trial-end") {
        const r = event.result;
        const status = r.verify.passed ? pc.green("pass") : pc.red("fail");
        process.stderr.write(
          `  -> ${status} (exit ${r.exitCode ?? "null"}${r.timedOut ? ", timed out" : ""}, wall ${(r.wallMs / 1000).toFixed(1)}s)\n`
        );
      } else {
        process.stderr.write(pc.yellow(`aborted: ${event.reason}\n`));
      }
    },
    repoDir,
    resultsWriter,
    runner,
    suite,
    trials,
  };
  if (options.timeout !== undefined) {
    orchestrateOpts.timeoutS = options.timeout;
  }
  if (options.maxCost !== undefined) {
    orchestrateOpts.maxCostUsd = options.maxCost;
  }

  const outcome: OrchestrateResult = await orchestrate(orchestrateOpts);

  const table = buildCompareTable(outcome.results, configA.name, configB.name);

  if (options.json) {
    process.stdout.write(
      `${serializeJSON({ aborted: outcome.aborted, abortReason: outcome.abortReason, resultsPath: resultsWriter.path, table })}\n`
    );
    return;
  }
  if (outcome.aborted) {
    process.stdout.write(pc.yellow(`\nrun aborted: ${outcome.abortReason}\n`));
  }
  printCompareTable(table);
  process.stdout.write(`\nresults: ${resultsWriter.path}\n`);
}

// ---------------------------------------------------------------------------
// `peek bench report`
// ---------------------------------------------------------------------------

export interface BenchReportCommandOptions {
  configA?: string;
  configB?: string;
  json?: boolean;
  output?: string;
}

/** First two distinct configNames in file order — used when --config-a/
 * --config-b aren't given explicitly. */
function inferConfigPair(
  results: readonly { configName: string }[]
): [string, string] {
  const seen: string[] = [];
  for (const r of results) {
    if (!seen.includes(r.configName)) {
      seen.push(r.configName);
    }
    if (seen.length === 2) {
      break;
    }
  }
  const [a, b] = seen;
  if (a === undefined || b === undefined) {
    throw new Error(
      `results file has fewer than 2 distinct configs — pass --config-a/--config-b explicitly, or check the file (found: ${seen.join(", ") || "none"})`
    );
  }
  return [a, b];
}

export async function runBenchReportCommand(
  resultsPath: string,
  options: BenchReportCommandOptions
): Promise<void> {
  const { results, warnings } = await readResults(resultsPath);
  if (warnings.length > 0) {
    process.stderr.write(
      pc.yellow(
        `warning: ${warnings.length} unparseable line(s) in ${resultsPath} (torn/partial run?) — ` +
          `lines: ${warnings.map((w) => w.line).join(", ")}\n`
      )
    );
  }

  const [configA, configB] =
    options.configA !== undefined && options.configB !== undefined
      ? [options.configA, options.configB]
      : inferConfigPair(results);

  const table = buildCompareTable(results, configA, configB);

  if (options.json) {
    process.stdout.write(`${serializeJSON(table)}\n`);
  } else {
    printCompareTable(table);
  }

  if (options.output !== undefined) {
    const html = renderBenchReportHtml(table, {
      generatedAtISO: new Date().toISOString(),
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Results may be empty when rendering a partial run.
      harness: results[0]?.harness ?? "unknown",
      peekVersion: readPeekVersion(),
    });
    await writeFile(options.output, html, "utf8");
    process.stdout.write(`${path.resolve(options.output)}\n`);
  }
}

// ---------------------------------------------------------------------------
// `peek bench clean`
// ---------------------------------------------------------------------------

export interface BenchCleanCommandOptions {
  repo?: string;
  scratchRoot?: string;
}

export async function runBenchCleanCommand(
  options: BenchCleanCommandOptions
): Promise<void> {
  const { defaultScratchRoot } = await import("../bench/run.js");
  const repoDir = options.repo ?? process.cwd();
  const scratchRoot = options.scratchRoot ?? defaultScratchRoot();
  const removed = await sweepOrphans(scratchRoot, repoDir);
  if (removed.length === 0) {
    process.stdout.write("nothing to clean\n");
    return;
  }
  process.stdout.write(
    `removed ${formatNumber(removed.length)} orphaned workspace(s):\n`
  );
  for (const p of removed) {
    process.stdout.write(`  ${p}\n`);
  }
}

// ---------------------------------------------------------------------------
// Command registration.
// ---------------------------------------------------------------------------

export function registerBenchCommand(program: Command): void {
  const bench = program
    .command("bench")
    .description(
      "Config A/B regression bench: re-run your own task suite under two config variants " +
        "and diff the results (success rate, tokens, cost, compactions) via peek's own adapters."
    );

  bench
    .command("run")
    .description(
      "Run a task suite under two config variants and compare. Prints an upfront cost/run " +
        "estimate and a confirm prompt (skip with --yes). A first-run or changed suite ALSO " +
        "requires a separate trust confirmation (every setup/verify command shown verbatim) " +
        "before anything executes — --yes does not skip this; use --trust-suite for " +
        "non-interactive runs."
    )
    .requiredOption(
      "--suite <dir>",
      "directory of .peek/bench/*.json task files"
    )
    .requiredOption(
      "--config-a <dir|current>",
      '"current" = the repo\'s own config, unmodified'
    )
    .requiredOption(
      "--config-b <dir|current>",
      "the second config variant to compare against a"
    )
    .option(
      "--harness <harness>",
      "claude-code | codex (pi deferred to v2.1) — default claude-code",
      parseBenchHarnessOption
    )
    .option(
      "--trials <n>",
      "trials per task per config — default 1",
      parsePositiveInt("--trials")
    )
    .option(
      "--timeout <seconds>",
      "override every task's timeoutS",
      parsePositiveInt("--timeout")
    )
    .option(
      "--max-cost <usd>",
      "abort BETWEEN trials once running parsed spend reaches this ceiling (best-effort)",
      parsePositiveNumber("--max-cost")
    )
    .option(
      "--yes",
      "skip the cost-estimate confirm prompt (NOT the trust prompt below)"
    )
    .option(
      "--trust-suite",
      "trust this suite's content hash (setup/verify commands + config overlays) without " +
        "the interactive prompt — required to run a first-seen/changed suite non-interactively"
    )
    .option(
      "--json",
      "emit the full computed structure as JSON instead of a text table"
    )
    .action(async (opts) => {
      try {
        const commandOpts: BenchRunCommandOptions = {
          configA: opts.configA as string,
          configB: opts.configB as string,
          json: Boolean(opts.json),
          suite: opts.suite as string,
          trustSuite: Boolean(opts.trustSuite),
          yes: Boolean(opts.yes),
        };
        if (opts.harness !== undefined) {
          commandOpts.harness = opts.harness as HarnessId;
        }
        if (opts.trials !== undefined) {
          commandOpts.trials = opts.trials as number;
        }
        if (opts.timeout !== undefined) {
          commandOpts.timeout = opts.timeout as number;
        }
        if (opts.maxCost !== undefined) {
          commandOpts.maxCost = opts.maxCost as number;
        }
        await runBenchRunCommand(commandOpts);
      } catch (err) {
        process.stderr.write(
          `${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exitCode = 1;
      }
    });

  bench
    .command("report <resultsPath>")
    .description(
      "Renders an A/B comparison from a saved results.jsonl (text table; HTML with -o)."
    )
    .option(
      "--config-a <name>",
      'config name to use as "a" (default: first seen in the file)'
    )
    .option(
      "--config-b <name>",
      'config name to use as "b" (default: second seen in the file)'
    )
    .option(
      "-o, --output <path>",
      "also write a self-contained HTML report to this path"
    )
    .option(
      "--json",
      "emit the full computed structure as JSON instead of a text table"
    )
    .action(async (resultsPath: string, opts) => {
      try {
        const commandOpts: BenchReportCommandOptions = {
          json: Boolean(opts.json),
        };
        if (opts.configA !== undefined) {
          commandOpts.configA = opts.configA as string;
        }
        if (opts.configB !== undefined) {
          commandOpts.configB = opts.configB as string;
        }
        if (opts.output !== undefined) {
          commandOpts.output = opts.output as string;
        }
        await runBenchReportCommand(resultsPath, commandOpts);
      } catch (err) {
        process.stderr.write(
          `${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exitCode = 1;
      }
    });

  bench
    .command("clean")
    .description(
      "Sweeps orphaned trial workspaces left behind by a crashed bench run."
    )
    .option("--repo <dir>", "target repo root — default: current directory")
    .option(
      "--scratch-root <dir>",
      "scratch root to sweep — default: ~/.cache/peek/bench-scratch"
    )
    .action(async (opts) => {
      try {
        const commandOpts: BenchCleanCommandOptions = {};
        if (opts.repo !== undefined) {
          commandOpts.repo = opts.repo as string;
        }
        if (opts.scratchRoot !== undefined) {
          commandOpts.scratchRoot = opts.scratchRoot as string;
        }
        await runBenchCleanCommand(commandOpts);
      } catch (err) {
        process.stderr.write(
          `${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exitCode = 1;
      }
    });
}
