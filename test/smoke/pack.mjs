import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname;
const tempRoot = mkdtempSync(join(tmpdir(), "peek-pack-smoke-"));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

try {
  const packJson = JSON.parse(
    run("npm", [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      tempRoot,
    ])
  );
  const tarball = join(tempRoot, packJson[0].filename);
  const installRoot = join(tempRoot, "install");

  run("npm", ["init", "-y"], { cwd: tempRoot });
  run("mkdir", ["-p", installRoot], { cwd: tempRoot });
  run("npm", ["init", "-y"], { cwd: installRoot });
  run("npm", ["install", "--no-audit", "--no-fund", tarball], {
    cwd: installRoot,
  });

  const installedPkg = JSON.parse(
    readFileSync(
      join(installRoot, "node_modules", "@mstuart", "peek", "package.json"),
      "utf8"
    )
  );
  if (installedPkg.name !== "@mstuart/peek") {
    throw new Error(
      `expected installed package @mstuart/peek, got ${installedPkg.name}`
    );
  }
  if (installedPkg.bin?.peek !== "dist/cli.js") {
    throw new Error("expected installed package to expose the peek CLI binary");
  }
  if (installedPkg.main || installedPkg.exports) {
    throw new Error(
      "package unexpectedly declares a public JS API; add an API smoke test before publishing it"
    );
  }

  const version = run("npx", ["peek", "--version"], {
    cwd: installRoot,
  }).trim();
  if (version !== installedPkg.version) {
    throw new Error(
      `expected peek --version ${installedPkg.version}, got ${version}`
    );
  }

  const help = run("npx", ["peek", "--help"], { cwd: installRoot });
  if (!(help.includes("Usage: peek") && help.includes("Commands:"))) {
    throw new Error(
      "packed CLI help did not expose the expected public interface"
    );
  }
} finally {
  rmSync(tempRoot, { force: true, recursive: true });
}
