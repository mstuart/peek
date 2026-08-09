import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverCodexSessions } from "../../src/adapters/codex/discover.js";
import type { CodexToolSchema } from "../../src/adapters/codex/meta.js";
import { parseCodexSession } from "../../src/adapters/codex/parse.js";
import {
  extractCliVersion,
  readCodexRecords,
} from "../../src/adapters/codex/records.js";
import type { SessionRef } from "../../src/model/types.js";

const FIXTURES_ROOT = path.join(__dirname, "../fixtures/codex");

async function refs(): Promise<SessionRef[]> {
  return discoverCodexSessions([FIXTURES_ROOT]);
}

function findRef(all: SessionRef[], id: string): SessionRef {
  const ref = all.find((r) => r.id === id);
  if (!ref) throw new Error(`fixture ref not found: ${id}`);
  return ref;
}

describe("discoverCodexSessions", () => {
  it("finds all 6 fixture files under test/fixtures/codex with ids from filenames", async () => {
    const all = await refs();
    expect(all.map((r) => r.id).sort()).toEqual(
      [
        "basic-session",
        "compaction",
        "full-turn",
        "real-capture-redacted",
        "real-capture-tools-redacted",
        "unknown-variant",
      ].sort(),
    );
    for (const ref of all) {
      expect(ref.harness).toBe("codex");
      expect(ref.kind).toBe("main");
      expect(ref.sizeBytes).toBeGreaterThan(0);
      expect(ref.mtime).toBeInstanceOf(Date);
    }
  });

  it("does not pick up the README.md (non-.jsonl)", async () => {
    const all = await refs();
    expect(all.some((r) => r.path.endsWith("README.md"))).toBe(false);
  });

  it("returns an empty array for a missing root, never throws", async () => {
    const all = await discoverCodexSessions([
      path.join(FIXTURES_ROOT, "does-not-exist"),
    ]);
    expect(all).toEqual([]);
  });

  it("extracts the trailing uuid as id for real rollout-*.jsonl filenames, in a date-tree layout", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "codex-discover-"));
    try {
      const dayDir = path.join(tmpRoot, "2026", "08", "08");
      await mkdir(dayDir, { recursive: true });
      const uuid = "019fe370-1c75-7323-a8c7-3db2a673d0ce";
      await writeFile(
        path.join(dayDir, `rollout-2026-08-08T15-13-23-${uuid}.jsonl`),
        '{"timestamp":"2026-08-08T15:13:23.000Z","type":"session_meta","payload":{}}\n',
      );

      const found = await discoverCodexSessions([tmpRoot]);
      expect(found).toHaveLength(1);
      expect(found[0]?.id).toBe(uuid);
      expect(found[0]?.kind).toBe("main");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("readCodexRecords / extractCliVersion", () => {
  it("extracts cli_version from the first session_meta record", async () => {
    const all = await refs();
    const ref = findRef(all, "basic-session");
    const { records } = await readCodexRecords(ref.path);
    expect(extractCliVersion(records)).toBe("0.88.0");
  });
});

describe("parseCodexSession — v0.88/basic-session.jsonl", () => {
  it("parses with 0 warnings", async () => {
    const all = await refs();
    const ref = findRef(all, "basic-session");
    const { warnings } = await parseCodexSession(ref);
    expect(warnings).toHaveLength(0);
  });

  it("harnessVersion is 0.88.0", async () => {
    const all = await refs();
    const ref = findRef(all, "basic-session");
    const { session } = await parseCodexSession(ref);
    expect(session.harnessVersion).toBe("0.88.0");
  });

  it("systemPrompt is present (~500-char base_instructions.text)", async () => {
    const all = await refs();
    const ref = findRef(all, "basic-session");
    const { session } = await parseCodexSession(ref);
    expect(session.configSnapshot.systemPrompt).toBeDefined();
    expect(session.configSnapshot.systemPrompt?.length ?? 0).toBeGreaterThan(
      300,
    );
  });

  it("projectInstructions comes from turn_context.user_instructions", async () => {
    const all = await refs();
    const ref = findRef(all, "basic-session");
    const { session } = await parseCodexSession(ref);
    expect(session.configSnapshot.projectInstructions).toContain(
      "AGENTS.md instructions for",
    );
  });

  it("gitBranch is main (git sub-object shape)", async () => {
    const all = await refs();
    const ref = findRef(all, "basic-session");
    const { session } = await parseCodexSession(ref);
    expect(session.gitBranch).toBe("main");
  });

  it("no dynamic_tools -> toolSchemas is undefined", async () => {
    const all = await refs();
    const ref = findRef(all, "basic-session");
    const { session } = await parseCodexSession(ref);
    expect(session.configSnapshot.toolSchemas).toBeUndefined();
  });
});

describe("parseCodexSession — v0.134/full-turn.jsonl", () => {
  it("parses with 0 warnings", async () => {
    const all = await refs();
    const ref = findRef(all, "full-turn");
    const { warnings } = await parseCodexSession(ref);
    expect(warnings).toHaveLength(0);
  });

  it("toolSchemas contains 3 flattened tools: 1 plain + 2 namespaced (serverName github)", async () => {
    const all = await refs();
    const ref = findRef(all, "full-turn");
    const { session } = await parseCodexSession(ref);
    expect(session.configSnapshot.toolSchemas).toBeDefined();

    const tools = JSON.parse(
      session.configSnapshot.toolSchemas as string,
    ) as CodexToolSchema[];
    expect(tools).toHaveLength(3);

    const plain = tools.find((t) => t.name === "read_file");
    expect(plain).toBeDefined();
    expect(plain?.serverName).toBeUndefined();

    const namespaced = tools.filter((t) => t.serverName === "github");
    expect(namespaced.map((t) => t.name).sort()).toEqual([
      "create_issue",
      "search_code",
    ]);
  });

  it("gitBranch is main (flattened field shape)", async () => {
    const all = await refs();
    const ref = findRef(all, "full-turn");
    const { session } = await parseCodexSession(ref);
    expect(session.gitBranch).toBe("main");
  });

  it("model comes from the single turn_context, no ModeChange emitted", async () => {
    const all = await refs();
    const ref = findRef(all, "full-turn");
    const { session } = await parseCodexSession(ref);
    expect(session.configSnapshot.model).toBe("gpt-5.5");
    expect(session.configSnapshot.modelChanges).toHaveLength(0);
  });

  it("turns are assembled from response_items, one per record (T4.4)", async () => {
    const all = await refs();
    const ref = findRef(all, "full-turn");
    const { session } = await parseCodexSession(ref);
    // 7 response_item lines: user message, reasoning, function_call x2,
    // function_call_output x2, assistant message. See codex-items.test.ts
    // for per-Turn span assertions.
    expect(session.turns).toHaveLength(7);
  });
});

describe("parseCodexSession — v0.134/real-capture-redacted.jsonl", () => {
  it("does not throw and parses with 0 warnings", async () => {
    const all = await refs();
    const ref = findRef(all, "real-capture-redacted");
    const { warnings } = await parseCodexSession(ref);
    expect(warnings).toHaveLength(0);
  });

  it("cli_version is 0.134.0", async () => {
    const all = await refs();
    const ref = findRef(all, "real-capture-redacted");
    const { session } = await parseCodexSession(ref);
    expect(session.harnessVersion).toBe("0.134.0");
  });

  it("systemPrompt is non-empty", async () => {
    const all = await refs();
    const ref = findRef(all, "real-capture-redacted");
    const { session } = await parseCodexSession(ref);
    expect(session.configSnapshot.systemPrompt?.length ?? 0).toBeGreaterThan(0);
  });

  it("no user_instructions in the real capture -> projectInstructions undefined", async () => {
    const all = await refs();
    const ref = findRef(all, "real-capture-redacted");
    const { session } = await parseCodexSession(ref);
    expect(session.configSnapshot.projectInstructions).toBeUndefined();
  });

  it("no git in a non-repo cwd -> gitBranch undefined", async () => {
    const all = await refs();
    const ref = findRef(all, "real-capture-redacted");
    const { session } = await parseCodexSession(ref);
    expect(session.gitBranch).toBeUndefined();
  });

  it("0.134 turn_context field set (current_date/timezone/permission_profile/...) does not crash extraction", async () => {
    const all = await refs();
    const ref = findRef(all, "real-capture-redacted");
    const { session } = await parseCodexSession(ref);
    expect(session.configSnapshot.model).toBe("gpt-5.5");
  });
});

describe("parseCodexSession — v0.134/unknown-variant.jsonl", () => {
  // Per task spec: this fixture's unknown shapes are at the PAYLOAD level
  // ("future_item" response_item, "agent_status_update" event_msg) — the
  // top-level LINE `type` for both records ("response_item"/"event_msg")
  // is known at the T4.3 dispatch layer, so record-level dispatch itself
  // produces 0 unknown-record-type warnings. T4.4 validates response_item's
  // payload.type and warns "unknown-response-item" for "future_item" (see
  // codex-items.test.ts for the dedicated case). T4.5 now validates
  // event_msg's payload.type the same way and warns "unknown-event-msg" for
  // "agent_status_update" (see codex-usage.test.ts for the dedicated case)
  // — so this fixture now produces exactly 2 warnings total, one per
  // unrecognized payload-level variant.
  it("parses with exactly 2 warnings (unknown-response-item + unknown-event-msg, one per unhandled payload variant)", async () => {
    const all = await refs();
    const ref = findRef(all, "unknown-variant");
    const { warnings } = await parseCodexSession(ref);
    expect(warnings).toHaveLength(2);
    const codes = warnings.map((w) => w.code).sort();
    expect(codes).toEqual(["unknown-event-msg", "unknown-response-item"]);
  });

  it("does not throw and still extracts session_meta/turn_context fields", async () => {
    const all = await refs();
    const ref = findRef(all, "unknown-variant");
    const { session } = await parseCodexSession(ref);
    expect(session.harnessVersion).toBe("0.134.0");
    expect(session.gitBranch).toBe("main");
    expect(session.configSnapshot.model).toBe("gpt-5.5");
  });
});
