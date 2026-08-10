import { cp } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: false,
  entry: ["src/cli.ts"],
  format: ["esm"],
  async onSuccess() {
    // The pricing snapshot is a static asset the compiled lookup resolves at
    // dist/data/<snapshot>.json (cleanroom blocker #1) — tsup never copies it.
    await cp("src/pricing/data", "dist/data", { recursive: true });
  },
  outDir: "dist",
  platform: "node",
  sourcemap: false,
  target: "node20",
});
