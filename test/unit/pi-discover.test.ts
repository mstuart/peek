import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, expect, it } from "vitest";
import { discoverPiSessions } from "../../src/adapters/pi/discover.js";
import {
  activeLeaf,
  parsePiEntryTree,
  pathToRoot,
} from "../../src/adapters/pi/tree.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, "../fixtures/pi");
const SYSTEM_A_DIR = join(FIXTURES_ROOT, "system-a-v3/--Users-fake-project--");
const SYSTEM_B_DIR = join(FIXTURES_ROOT, "system-b-v4");

const CASE1_MAIN =
  "2026-08-01T10-00-00-000Z_cb5b132f-2542-40b3-a7c9-49ffc431e30b.jsonl";
const CASE2_BRANCHED =
  "2026-08-01T11-30-00-000Z_18351767-372f-4f0b-8053-b625fc378e36.jsonl";
const CASE3_COMPACTION =
  "2026-08-01T12-45-00-000Z_6d816cb4-9915-4741-9571-a436e36f68c5.jsonl";
const CASE4_MISC =
  "2026-08-01T13-15-00-000Z_26ec89e6-9ad9-4563-bbce-47c243e72c96.jsonl";
const CASE5_FORKED =
  "2026-08-01T14-00-00-000Z_700d9363-cf7c-40ee-8bb0-833bc99c6a6a.jsonl";
const CASE6_SYSTEM_B =
  "2026-08-01T16-00-00-000Z_b9f0fc61-c03e-49c7-a148-e1e7c660822c.jsonl";

function readLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

describe("discoverPiSessions", () => {
  it("finds the 5 System A files + 1 System B file under the fixtures root", async () => {
    const refs = await discoverPiSessions([FIXTURES_ROOT]);
    expect(refs).toHaveLength(6);
  });

  it("assigns harness/kind and decodes ids from the filename uuid", async () => {
    const refs = await discoverPiSessions([FIXTURES_ROOT]);
    const case1 = refs.find((r) => r.path.endsWith(CASE1_MAIN));
    expect(case1).toBeDefined();
    expect(case1?.harness).toBe("pi");
    expect(case1?.kind).toBe("main");
    expect(case1?.id).toBe("cb5b132f-2542-40b3-a7c9-49ffc431e30b");
    expect(case1?.sizeBytes).toBeGreaterThan(0);
    expect(case1?.mtime).toBeInstanceOf(Date);
  });

  it("decodes cwd from the --slug-- directory for System A sessions", async () => {
    const refs = await discoverPiSessions([FIXTURES_ROOT]);
    for (const name of [
      CASE1_MAIN,
      CASE2_BRANCHED,
      CASE3_COMPACTION,
      CASE4_MISC,
      CASE5_FORKED,
    ]) {
      const ref = refs.find((r) => r.path.endsWith(name));
      expect(ref?.cwd, name).toBe("/Users/fake/project");
    }
  });

  it("finds the System B file with its own uuid and no directory-decoded cwd", async () => {
    const refs = await discoverPiSessions([FIXTURES_ROOT]);
    const systemB = refs.find((r) => r.path.endsWith(CASE6_SYSTEM_B));
    expect(systemB).toBeDefined();
    expect(systemB?.id).toBe("b9f0fc61-c03e-49c7-a148-e1e7c660822c");
    expect(systemB?.cwd).toBeUndefined();
  });

  it("returns an empty array for a missing root, never throws", async () => {
    const refs = await discoverPiSessions([
      join(FIXTURES_ROOT, "does-not-exist"),
    ]);
    expect(refs).toEqual([]);
  });

  it("accepts explicit roots pointed directly at the system-a / system-b dirs", async () => {
    const refs = await discoverPiSessions([SYSTEM_A_DIR, SYSTEM_B_DIR]);
    expect(refs).toHaveLength(6);
  });
});

describe("parsePiEntryTree — System A", () => {
  it("builds header + entries map by id with parentId links", () => {
    const lines = readLines(join(SYSTEM_A_DIR, CASE1_MAIN));
    const result = parsePiEntryTree(lines);
    expect(result.systemB).toBe(false);
    if (result.systemB) {
      throw new Error("unreachable");
    }
    assert(result.tree);
    expect(result.tree.header.id).toBe("cb5b132f-2542-40b3-a7c9-49ffc431e30b");
    expect(result.tree.header.cwd).toBe("/Users/fake/project");
    expect(result.tree.entries.get("e1000002")?.parentId).toBe("e1000001");
    expect(result.warnings).toEqual([]);
  });

  it("reconstructs the branched tree: two children of b1000002, active leaf b1000005", () => {
    const lines = readLines(join(SYSTEM_A_DIR, CASE2_BRANCHED));
    const result = parsePiEntryTree(lines);
    if (result.systemB || !result.tree) {
      throw new Error("expected a tree");
    }

    const children = [...result.tree.entries.values()].filter(
      (e) => e.parentId === "b1000002"
    );
    expect(
      children.map((e) => e.id).sort((left, right) => left.localeCompare(right))
    ).toEqual(["b1000003", "b1000004"]);

    expect(activeLeaf(result.tree.entries)).toBe("b1000005");
  });

  it("pathToRoot from the active leaf crosses the branch point via b1000004, not b1000003", () => {
    const lines = readLines(join(SYSTEM_A_DIR, CASE2_BRANCHED));
    const result = parsePiEntryTree(lines);
    if (result.systemB || !result.tree) {
      throw new Error("expected a tree");
    }

    const leaf = activeLeaf(result.tree.entries);
    expect(leaf).toBeDefined();
    const path = pathToRoot(result.tree.entries, leaf as string);
    expect(path).toEqual(["b1000001", "b1000002", "b1000004", "b1000005"]);
    expect(path).not.toContain("b1000003");
  });

  it("walks past a mid-tree compaction entry without breaking the parent chain", () => {
    const lines = readLines(join(SYSTEM_A_DIR, CASE3_COMPACTION));
    const result = parsePiEntryTree(lines);
    if (result.systemB || !result.tree) {
      throw new Error("expected a tree");
    }

    const leaf = activeLeaf(result.tree.entries);
    expect(leaf).toBe("c1000007");
    const path = pathToRoot(result.tree.entries, leaf as string);
    expect(path).toEqual([
      "c1000001",
      "c1000002",
      "c1000003",
      "c1000004",
      "c1000005",
      "c1000006",
      "c1000007",
    ]);
  });

  it("links misc entry types (branch_summary/custom/custom_message/label/session_info) into the tree", () => {
    const lines = readLines(join(SYSTEM_A_DIR, CASE4_MISC));
    const result = parsePiEntryTree(lines);
    if (result.systemB || !result.tree) {
      throw new Error("expected a tree");
    }

    expect(result.tree.entries.get("d1000003")?.type).toBe("branch_summary");
    expect(result.tree.entries.get("d1000004")?.type).toBe("custom");
    expect(result.tree.entries.get("d1000005")?.type).toBe("custom_message");
    expect(result.tree.entries.get("d1000006")?.type).toBe("label");
    expect(result.tree.entries.get("d1000007")?.type).toBe("session_info");
  });

  it("warns (not throws) on an unknown entry type and still links it into the tree", () => {
    const lines = readLines(join(SYSTEM_A_DIR, CASE4_MISC));
    const result = parsePiEntryTree(lines);
    if (result.systemB || !result.tree) {
      throw new Error("expected a tree");
    }

    const unknown = result.tree.entries.get("d1000008");
    expect(unknown?.type).toBe("future_entry");
    expect(activeLeaf(result.tree.entries)).toBe("d1000008");

    const warning = result.warnings.find(
      (w) => w.code === "pi-unknown-entry-type"
    );
    expect(warning).toBeDefined();
    expect(warning?.recordType).toBe("future_entry");
  });

  it("carries parentSession through on the forked session header", () => {
    const lines = readLines(join(SYSTEM_A_DIR, CASE5_FORKED));
    const result = parsePiEntryTree(lines);
    if (result.systemB || !result.tree) {
      throw new Error("expected a tree");
    }

    expect(result.tree.header.parentSession).toContain(
      "cb5b132f-2542-40b3-a7c9-49ffc431e30b"
    );
  });
});

describe("parsePiEntryTree — System B detection", () => {
  // Lane D (docs/DESIGN.md § Other v2 subsystems): System B is now a supported, fully-parsed
  // format (src/adapters/pi/systemB.ts) — parsePiEntryTree's job here is
  // purely to detect (route to systemB.ts) and signal that, with no warning
  // of its own; systemB.ts's own parse warnings are covered in
  // test/unit/pi-systemb.test.ts.
  it("detects a System B (harness v4) header and returns a routing marker, no warning", () => {
    const lines = readLines(join(SYSTEM_B_DIR, CASE6_SYSTEM_B));
    const result = parsePiEntryTree(lines);
    expect(result.systemB).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

describe("parsePiEntryTree — malformed input", () => {
  it("warns and returns a null tree for an empty file", () => {
    const result = parsePiEntryTree([]);
    expect(result.systemB).toBe(false);
    if (result.systemB) {
      throw new Error("unreachable");
    }
    expect(result.tree).toBeNull();
    expect(result.warnings).toHaveLength(1);
  });

  it("warns and continues past a malformed JSON entry line", () => {
    const header = readLines(join(SYSTEM_A_DIR, CASE1_MAIN))[0] as string;
    const result = parsePiEntryTree([
      header,
      '{"type":"message","id":"z1","parentId":null,"timestamp":"2026-08-01T00:00:00.000Z"}',
      "not valid json",
      '{"type":"message","id":"z2","parentId":"z1","timestamp":"2026-08-01T00:00:01.000Z"}',
    ]);
    if (result.systemB || !result.tree) {
      throw new Error("expected a tree");
    }
    expect(result.tree.entries.size).toBe(2);
    expect(result.warnings.some((w) => w.code === "pi-malformed-entry")).toBe(
      true
    );
  });
});
