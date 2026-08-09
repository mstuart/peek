// `peek pricing refresh` — the explicit opt-in network path for DESIGN.md accounting rule 4's
// models.dev fallback tier (pricing/refresh.ts's refreshPricingSnapshot). This is the ONLY CLI
// entry point that touches the network for pricing purposes; every other command reads the
// vendored LiteLLM snapshot and/or the cache this command writes.

import type { Command } from "commander";
import { refreshPricingSnapshot } from "../pricing/refresh.js";

export async function runPricingRefreshCommand(): Promise<void> {
  const result = await refreshPricingSnapshot();
  process.stdout.write(
    `Fetched ${result.modelCount} priced models from models.dev (${result.fetchedAt}).\n` +
      `Wrote cache: ${result.outputPath}\n`,
  );
}

export function registerPricingCommand(program: Command): void {
  const pricing = program
    .command("pricing")
    .description("Pricing snapshot maintenance.");

  pricing
    .command("refresh")
    .description(
      "Fetch a fresh models.dev pricing snapshot and cache it for the offline fallback " +
        "lookup used when the vendored LiteLLM snapshot misses a model. Explicit opt-in " +
        "network access — nothing else in peek fetches pricing data.",
    )
    .action(async () => {
      try {
        await runPricingRefreshCommand();
      } catch (err) {
        process.stderr.write(
          `${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });
}
