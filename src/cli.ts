#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerBenchCommand } from "./commands/bench.js";
import { registerCompactionsCommand } from "./commands/compactions.js";
import { runContextCommand } from "./commands/context.js";
import { registerCostCommand } from "./commands/cost.js";
import { registerDiffCommand } from "./commands/diff.js";
import { registerListCommand } from "./commands/list.js";
import { registerPricingCommand } from "./commands/pricing.js";
import { registerReportCommand } from "./commands/report.js";
import type { HarnessId } from "./model/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
) as { version: string };

const HARNESS_IDS: readonly HarnessId[] = ["claude-code", "codex", "pi"];

function parseHarness(value: string): HarnessId {
  if ((HARNESS_IDS as readonly string[]).includes(value)) {
    return value as HarnessId;
  }
  throw new Error(
    `--harness must be one of ${HARNESS_IDS.join(", ")} (got: ${value})`,
  );
}

function parseTurn(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--turn must be a positive integer (got: ${value})`);
  }
  return n;
}

const program = new Command();

program
  .name("peek")
  .description(
    "Cross-harness context and cost inspector for AI coding agent sessions.",
  )
  .version(pkg.version);

program
  .command("context [sessionIdOrPath]")
  .description(
    "Historical per-turn context composition for a session (residual honestly labeled). " +
      "With no argument, resolves to the most recently modified session.",
  )
  .option(
    "--harness <harness>",
    "restrict to one harness: claude-code | codex | pi",
    parseHarness,
  )
  .option(
    "--cwd <path>",
    "restrict to sessions discovered from this working directory",
  )
  .option("--json", "emit the full computed structure as JSON")
  .option(
    "--turn <n>",
    "show one turn's span-level breakdown (1-indexed)",
    parseTurn,
  )
  .action(async (sessionIdOrPath: string | undefined, opts) => {
    try {
      const commandOpts: Parameters<typeof runContextCommand>[1] = {
        json: Boolean(opts.json),
      };
      if (opts.harness !== undefined) {
        commandOpts.harness = opts.harness as HarnessId;
      }
      if (opts.cwd !== undefined) commandOpts.cwd = opts.cwd as string;
      if (opts.turn !== undefined) commandOpts.turn = opts.turn as number;
      await runContextCommand(sessionIdOrPath, commandOpts);
    } catch (err) {
      process.stderr.write(
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    }
  });

registerListCommand(program);
registerCostCommand(program);
registerCompactionsCommand(program);
registerDiffCommand(program);
registerReportCommand(program);
registerBenchCommand(program);
registerPricingCommand(program);

// No other subcommands yet — bare `peek` prints help.
program.action(() => {
  program.help();
});

program.parse(process.argv);
