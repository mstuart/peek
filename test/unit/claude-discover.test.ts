import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "../../src/adapters/claude/discover.js";

const FIXTURES_ROOT = path.join(import.meta.dirname, "../fixtures/claude-code");

describe("discoverClaudeSessions", () => {
  it("finds all 9 main sessions in v2.1.104, each kind main", async () => {
    const refs = await discoverClaudeSessions([FIXTURES_ROOT]);
    const v104 = refs.filter((r) =>
      r.path.includes(`${path.sep}v2.1.104${path.sep}`)
    );

    expect(v104).toHaveLength(9);
    for (const ref of v104) {
      expect(ref.kind).toBe("main");
      expect(ref.harness).toBe("claude-code");
      expect(ref.parentId).toBeUndefined();
      expect(ref.sizeBytes).toBeGreaterThan(0);
      expect(ref.mtime).toBeInstanceOf(Date);
    }
    const ids = v104
      .map((r) => r.id)
      .sort((left, right) => left.localeCompare(right));
    expect(ids).toEqual(
      [
        "cache-heavy",
        "cache-miss-reason",
        "compaction",
        "iterations-multi",
        "normal-turns",
        "sidechain-replay",
        "streaming-split",
        "tool-use-names",
        "unknown-type-and-model",
      ].sort()
    );
  });

  it("finds all three v2.1.225 main sessions (0001, 0003, streaming-split-compaction) with kind main", async () => {
    const refs = await discoverClaudeSessions([FIXTURES_ROOT]);
    const mains = refs.filter(
      (r) =>
        r.kind === "main" && r.path.includes(`${path.sep}v2.1.225${path.sep}`)
    );

    expect(
      mains.map((r) => r.id).sort((left, right) => left.localeCompare(right))
    ).toEqual([
      "20000000-2000-4200-8200-200000000001",
      "20000000-2000-4200-8200-200000000003",
      "streaming-split-compaction",
    ]);
  });

  it("finds the Task-spawned subagent under session 0001, linked via parentId", async () => {
    const refs = await discoverClaudeSessions([FIXTURES_ROOT]);
    const subagent = refs.find((r) => r.id === "abc123");

    expect(subagent).toBeDefined();
    expect(subagent?.kind).toBe("subagent");
    expect(subagent?.parentId).toBe("20000000-2000-4200-8200-200000000001");
  });

  it("finds the subagents-only session's subagent ref with parentId 0002 and fabricates NO main ref for 0002", async () => {
    const refs = await discoverClaudeSessions([FIXTURES_ROOT]);
    const subagent = refs.find((r) => r.id === "def456");

    expect(subagent).toBeDefined();
    expect(subagent?.kind).toBe("subagent");
    expect(subagent?.parentId).toBe("20000000-2000-4200-8200-200000000002");

    const fabricatedMain = refs.find(
      (r) =>
        r.kind === "main" && r.id === "20000000-2000-4200-8200-200000000002"
    );
    expect(fabricatedMain).toBeUndefined();
  });

  it("does not treat the offloaded tool-results dir under session 0003 as a session", async () => {
    const refs = await discoverClaudeSessions([FIXTURES_ROOT]);
    const offloaded = refs.find((r) => r.path.includes("tool-results"));

    expect(offloaded).toBeUndefined();
  });

  it("does not treat agent-*.meta.json files as sessions", async () => {
    const refs = await discoverClaudeSessions([FIXTURES_ROOT]);
    const metaAsSession = refs.find((r) => r.path.endsWith(".meta.json"));

    expect(metaAsSession).toBeUndefined();
  });

  it("returns exactly 14 refs total across both fixture versions", async () => {
    const refs = await discoverClaudeSessions([FIXTURES_ROOT]);
    expect(refs).toHaveLength(14);
  });

  it("sorts refs by path ascending, stably", async () => {
    const refs = await discoverClaudeSessions([FIXTURES_ROOT]);
    const paths = refs.map((r) => r.path);
    const sorted = [...paths].sort();
    expect(paths).toEqual(sorted);
  });

  it("returns an empty array for a missing root, never throws", async () => {
    const refs = await discoverClaudeSessions([
      path.join(FIXTURES_ROOT, "does-not-exist"),
    ]);
    expect(refs).toEqual([]);
  });

  it("returns an empty array when no roots are discoverable and default root is absent", async () => {
    // Exercises the missing-root path without touching the real ~/.claude/projects.
    const refs = await discoverClaudeSessions([
      path.join(FIXTURES_ROOT, "also-missing-a"),
      path.join(FIXTURES_ROOT, "also-missing-b"),
    ]);
    expect(refs).toEqual([]);
  });
});
