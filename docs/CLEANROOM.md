# Clean-room packaging validation

Pre-publish confidence check performed on a clean rsync'd copy of the repo (no `.git`,
`node_modules`, or `dist` carried over), run entirely outside the working tree. Nothing was
published; `private: true` was left untouched and no `npm publish` was executed.

## Environment

- Host: darwin (macOS)
- Node: v24.13.0 (repo requires `engines.node >= 20` — satisfied)
- npm: 11.13.0
- Working copy: rsync of `/Users/mark/git/peek` → scratchpad `cleanroom/src-copy/`

## Steps and results

1. **Install** — `npm ci` succeeded against the committed lockfile (no mismatch, no fallback to
   `npm install` needed). Installed 93 packages. `npm audit` reports 5 vulnerabilities (3
   moderate, 1 high, 1 critical), all transitive through `vitest`'s dev-only `esbuild`/`vite`
   chain (GHSA-67mh-4wv8-2f99, dev-server-only issue). None touch the two runtime
   `dependencies` (`commander`, `picocolors`), so this doesn't affect what ships.

2. **Lint** — `npm run lint` (`biome check .`) **fails**: one import-order error in
   `src/commands/list.ts` (`Command` type import and `homedir` import out of order). Autofixable
   via `biome check --fix --unsafe`, not applied here since this run must not touch the repo.

3. **Test** — `npm test` (`vitest run`) with `PEEK_LOCAL` unset: **291 passed, 2 skipped** across
   22 test files. The 2 skips are `test/local.integration.test.ts`, which correctly gates on
   `PEEK_LOCAL` and skips when absent — confirms integration tests don't run against real local
   data by default.

4. **Build** — `npm run build` (`tsup`) succeeded, producing `dist/cli.js` (83.2 KB) and
   `dist/cli.js.map` (244.6 KB). Nothing else lands in `dist/`.

5. **`npm pack`** — tarball contains exactly 5 files:
   `LICENSE`, `README.md`, `dist/cli.js`, `dist/cli.js.map`, `package.json`.
   Nothing unwanted ships (no fixtures, no test files, no scratch/docs). But this is short of
   what `package.json`'s `files` field promises — see blocker #1 below.

6. **Install from tarball** — `npm install -g <tarball> --prefix cleanroom/prefix` succeeded
   (3 packages added). Bin resolution is correct: `prefix/bin/peek` symlinks to
   `../lib/node_modules/peek-agent/dist/cli.js`, which has a working `#!/usr/bin/env node`
   shebang.

7. **Runtime smoke test** —
   - `peek --version` → `0.1.0`, exit 0.
   - `peek context <fixture.jsonl>` (fixture from `test/fixtures/claude-code/v2.1.104/`) →
     correct turn-by-turn context table output, exit 0.
   - Note: the currently shipped CLI only exposes one command (`context`), and it doesn't touch
     the pricing/cost-lookup module, so blocker #1 below does not currently cause any visible
     runtime failure.

## Publish-blockers (ranked)

1. **[High] Pricing data never ships, and its `files` glob doesn't resolve.**
   `package.json` declares `"files": ["dist", "pricing/data"]`, but there is no `pricing/`
   directory at the repo root — pricing data lives at `src/pricing/data/litellm-2026-08-08.json`.
   npm silently drops the non-matching glob (no error), so the snapshot is absent from every
   `npm pack`/`npm publish` tarball. Separately, `src/pricing/lookup.ts` loads the snapshot via
   `path.join(__dirname, "data", SNAPSHOT_FILENAME)` relative to the *compiled* module — i.e. it
   expects `dist/data/litellm-2026-08-08.json` — but `tsup` only bundles `.ts` and never copies
   static assets into `dist/`. Both the `files` entry and the runtime path are wrong for the
   actual build layout; fixing one without the other still leaves this broken. The module's own
   header comment already flags this as unaddressed ("Packaging... is a build-config concern for
   a later task, not addressed here"). Currently masked because no shipped command calls into
   pricing yet — this will start failing the moment a `cost`/pricing-consuming command ships.

2. **[Blocking by design] `"private": true`.** `npm publish` will refuse to publish as long as
   this flag is set. Presumably intentional pre-release gating — flagging so it's a deliberate
   decision at publish time, not an oversight.

3. **[Low] Lint is red.** `biome check .` fails on one import-order violation in
   `src/commands/list.ts`. Trivial autofix available (`biome check --fix --unsafe`), but a red
   lint script is a bad look if `lint` is ever wired into a prepublish/CI gate.

4. **[Informational] Source map ships in the tarball.** `dist/cli.js.map` (244.6 KB) is included
   as an unavoidable consequence of `sourcemap: true` in `tsup.config.ts` plus the broad `dist`
   entry in `files`. Not wrong, but worth a conscious call — it roughly triples the package size
   for a CLI tool where map files aren't typically useful to consumers.

5. **[Dev-only, not shipped] 5 `npm audit` findings** (3 moderate/1 high/1 critical), all
   transitive through `vitest → vite → esbuild`, dev-tooling only. Does not affect the published
   package's runtime dependency tree (`commander`, `picocolors` only). Worth a `vitest` bump at
   some point but not a publish blocker.
