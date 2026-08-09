import { cp } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: false,
  dts: false,
  async onSuccess() {
    // The pricing snapshot is a static asset the compiled lookup resolves at
    // dist/data/<snapshot>.json (cleanroom blocker #1) — tsup never copies it.
    await cp("src/pricing/data", "dist/data", { recursive: true });
  },
});
