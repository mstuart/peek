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

// No other subcommands are registered above, so any leftover positional
// arguments here are either nothing (bare `peek`, exit 0 help) or an
// unrecognized command name (error, exit 1) — commander routes both cases
// through this single root action rather than its own command:* handler
// once a root .action() is defined, so the branch happens here instead.
// program.args (not a declared `.arguments()`) picks up the leftover tokens
// without adding a spurious "[args...]" to the --help usage line.
// allowExcessArguments: without it, commander's own zero-declared-args
// arity check on the root command rejects any leftover token BEFORE this
// action runs, with its generic "too many arguments" message instead of the
// actionable one below.
program.allowExcessArguments();
program.action(() => {
  const leftover = program.args;
  if (leftover.length === 0) {
    program.help();
    return;
  }
  process.stderr.write(`unknown command '${leftover[0]}' — run peek --help\n`);
  process.exitCode = 1;
});

program.parse(process.argv);
