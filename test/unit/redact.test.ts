import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWLIST_KEYS,
  createRedactContext,
  normalizeKey,
  redactRecord,
} from "../../scripts/redact.js";

// Recursively replaces every leaf value with its JS type tag (or "array"),
// so two structures can be compared for identical shape independent of content.
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { __array__: value.map(shapeOf) };
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shapeOf(v);
    }
    return out;
  }
  return value === null ? "null" : typeof value;
}

const SHARED_TOOL_ID = "toolu_0123456789abcdef0123456789abcdef";
const LONG_TEXT =
  "The quick brown fox jumps over the lazy dog while the distinguished engineer reviews a pull request.";
const COMPACTION_TEXT =
  "This session is being continued from a previous conversation that ran out of context. The user asked to redact a fixture and we are scrambling it now for privacy reasons before landing it in the repo.";

function buildSample() {
  return {
    recordA: {
      cwd: "/Users/mark/git/peek",
      gitBranch: "main",
      message: {
        content: [
          {
            id: SHARED_TOOL_ID,
            input: { command: LONG_TEXT },
            name: "Bash",
            type: "tool_use",
          },
          { text: COMPACTION_TEXT, type: "text" },
        ],
        model: "claude-sonnet-5",
        role: "assistant",
        usage: {
          cache_read_input_tokens: 6789,
          input_tokens: 12_345,
          output_tokens: 42,
        },
      },
      sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      timestamp: "2026-08-08T15:13:23.000Z",
      type: "assistant",
      uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    },
    recordB: {
      message: {
        content: [
          {
            content: LONG_TEXT,
            is_error: false,
            tool_use_id: SHARED_TOOL_ID,
            type: "tool_result",
          },
        ],
        role: "user",
      },
      timestamp: "2026-08-08T15:13:24.000Z",
      toolUseResult: { interrupted: false, stderr: "", stdout: LONG_TEXT },
      type: "user",
      uuid: "11111111-2222-3333-4444-555555555555",
    },
  };
}

describe("redactRecord", () => {
  it("preserves structure, keys, and numbers exactly", () => {
    const sample = buildSample();
    const ctx = createRedactContext();
    const redacted = redactRecord(sample, ctx) as typeof sample;

    expect(shapeOf(redacted)).toEqual(shapeOf(sample));
    expect(redacted.recordA.message.usage).toEqual(
      sample.recordA.message.usage
    );
  });

  it("preserves the length of scrambled free-text strings", () => {
    const ctx = createRedactContext();
    const redacted = redactRecord(buildSample(), ctx) as ReturnType<
      typeof buildSample
    >;
    const scrambledCommand = (
      redacted.recordA.message.content[0] as { input: { command: string } }
    ).input.command;
    expect(scrambledCommand.length).toBe(LONG_TEXT.length);
    expect(scrambledCommand).not.toBe(LONG_TEXT);
  });

  it("maps identical input strings to identical outputs, everywhere they appear", () => {
    const ctx = createRedactContext();
    const redacted = redactRecord(buildSample(), ctx) as ReturnType<
      typeof buildSample
    >;

    const scrambledCommand = (
      redacted.recordA.message.content[0] as { input: { command: string } }
    ).input.command;
    const scrambledStdout = redacted.recordB.toolUseResult.stdout;
    const scrambledInlineContent = (
      redacted.recordB.message.content[0] as { content: string }
    ).content;

    // toolUseResult.stdout and the inline tool_result.content were byte-identical
    // in the source (docs/recon/claude-code.md) — must remain byte-identical.
    expect(scrambledStdout).toBe(scrambledInlineContent);
    // Same free text reused elsewhere (recordA's tool_use input) also matches.
    expect(scrambledCommand).toBe(scrambledStdout);
  });

  it("remaps ids consistently across every occurrence, to a different value", () => {
    const ctx = createRedactContext();
    const redacted = redactRecord(buildSample(), ctx) as ReturnType<
      typeof buildSample
    >;

    const toolUseId = (redacted.recordA.message.content[0] as { id: string })
      .id;
    const toolResultId = (
      redacted.recordB.message.content[0] as { tool_use_id: string }
    ).tool_use_id;

    expect(toolUseId).toBe(toolResultId);
    expect(toolUseId).not.toBe(SHARED_TOOL_ID);
    expect(toolUseId.startsWith("toolu_")).toBe(true);
    expect(toolUseId.length).toBe(SHARED_TOOL_ID.length);

    // uuid reused as both `uuid` and `sessionId` on recordA also stays consistent.
    expect(redacted.recordA.uuid).toBe(redacted.recordA.sessionId);
    expect(redacted.recordA.uuid).not.toBe(sampleUuid());
  });

  it("preserves the compaction-detection prefix, scrambling only the remainder", () => {
    const ctx = createRedactContext();
    const redacted = redactRecord(buildSample(), ctx) as ReturnType<
      typeof buildSample
    >;
    const { text } = redacted.recordA.message.content[1] as { text: string };

    expect(text.startsWith("This session is being continued")).toBe(true);
    expect(text.length).toBe(COMPACTION_TEXT.length);
    expect(text).not.toBe(COMPACTION_TEXT);
  });

  it("passes through allowlisted enum fields, timestamps, and numbers unchanged", () => {
    const sample = buildSample();
    const ctx = createRedactContext();
    const redacted = redactRecord(sample, ctx) as typeof sample;

    expect(redacted.recordA.type).toBe("assistant");
    expect(redacted.recordA.message.role).toBe("assistant");
    expect(redacted.recordA.message.model).toBe("claude-sonnet-5");
    expect(redacted.recordA.timestamp).toBe("2026-08-08T15:13:23.000Z");
    expect(redacted.recordB.message.content[0]?.is_error).toBe(false);
  });

  it("leaves no original substring longer than 8 characters in scrambled/remapped output", () => {
    const sample = buildSample();
    const ctx = createRedactContext();
    const redacted = redactRecord(sample, ctx);
    const serialized = JSON.stringify(redacted);

    const sensitiveSubstrings = [
      LONG_TEXT.slice(0, 20),
      LONG_TEXT.slice(20, 40),
      COMPACTION_TEXT.slice(50, 70), // outside the preserved prefix
      SHARED_TOOL_ID,
      sampleUuid(),
      "/Users/mark/git/peek",
    ];
    for (const needle of sensitiveSubstrings) {
      expect(serialized.includes(needle)).toBe(false);
    }
  });

  it("remaps paths, cwd, and gitBranch consistently and stably", () => {
    const ctx = createRedactContext();
    const redacted = redactRecord(buildSample(), ctx) as ReturnType<
      typeof buildSample
    >;

    expect(redacted.recordA.cwd).not.toBe("/Users/mark/git/peek");
    expect(redacted.recordA.cwd.startsWith("/Users/")).toBe(true);
    expect(redacted.recordA.gitBranch).not.toBe("main");
    expect(redacted.recordA.gitBranch.length).toBe("main".length);

    // Re-running on a second record with the same cwd yields the same fake path.
    const second = { cwd: "/Users/mark/git/peek" };
    const redactedSecond = redactRecord(second, ctx) as typeof second;
    expect(redactedSecond.cwd).toBe(redacted.recordA.cwd);
  });

  it("recurses into Codex-shaped JSON-string function_call.arguments", () => {
    const record = {
      payload: {
        arguments: JSON.stringify({
          command: LONG_TEXT,
          cwd: "/Users/mark/git/peek",
        }),
        name: "shell",
        type: "function_call",
      },
      timestamp: "2026-08-08T15:13:23.000Z",
      type: "response_item",
    };
    const ctx = createRedactContext();
    const redacted = redactRecord(record, ctx) as typeof record;

    expect(typeof redacted.payload.arguments).toBe("string");
    const parsedBack = JSON.parse(redacted.payload.arguments) as {
      command: string;
      cwd: string;
    };
    expect(parsedBack.command.length).toBe(LONG_TEXT.length);
    expect(parsedBack.command).not.toBe(LONG_TEXT);
    expect(parsedBack.cwd.startsWith("/Users/")).toBe(true);
    expect(parsedBack.cwd).not.toBe("/Users/mark/git/peek");
  });

  it("preserves nested structural tags mid-string, scrambling only the content between them", () => {
    const agentsFileContents =
      "Run tests with npm test. Never commit directly to main. Use conventional commits for every change.";
    const original = `# AGENTS.md instructions for /Users/mark/git/peek\n\n<INSTRUCTIONS>\n${agentsFileContents}\n</INSTRUCTIONS>`;
    const ctx = createRedactContext();
    const redacted = redactRecord({ text: original }, ctx) as {
      text: string;
    };

    // Structure preserved: leading prefix, nested tags, and their ordering.
    expect(redacted.text.startsWith("# AGENTS.md instructions")).toBe(true);
    expect(redacted.text.includes("<INSTRUCTIONS>")).toBe(true);
    expect(redacted.text.includes("</INSTRUCTIONS>")).toBe(true);
    expect(redacted.text.indexOf("<INSTRUCTIONS>")).toBeLessThan(
      redacted.text.indexOf("</INSTRUCTIONS>")
    );
    // Content between the tags is scrambled, not the original file contents.
    expect(redacted.text.includes(agentsFileContents)).toBe(false);
    expect(redacted.text.includes(agentsFileContents.slice(0, 20))).toBe(false);
    // Total length preserved.
    expect(redacted.text.length).toBe(original.length);
    // No content survival anywhere in the serialized output.
    expect(JSON.stringify(redacted)).not.toContain(agentsFileContents);
  });

  it("preserves environment_context nested sub-tags (cwd/shell/current_date/timezone)", () => {
    const original =
      "<environment_context>\n<cwd>/Users/mark/git/peek</cwd>\n<shell>zsh</shell>\n<current_date>2026-08-08</current_date>\n<timezone>America/Los_Angeles</timezone>\n</environment_context>";
    const ctx = createRedactContext();
    const redacted = redactRecord({ text: original }, ctx) as {
      text: string;
    };

    for (const tag of [
      "<environment_context>",
      "</environment_context>",
      "<cwd>",
      "</cwd>",
      "<shell>",
      "</shell>",
      "<current_date>",
      "</current_date>",
      "<timezone>",
      "</timezone>",
    ]) {
      expect(redacted.text.includes(tag)).toBe(true);
    }
    expect(redacted.text.includes("/Users/mark/git/peek")).toBe(false);
    expect(redacted.text.length).toBe(original.length);
  });

  it("preserves function_call.name (tool-call context) but scrambles a standalone name field", () => {
    const record = {
      arguments: JSON.stringify({ command: "cat a.txt" }),
      call_id: "call_abc123",
      name: "exec_command",
      type: "function_call",
    };
    const standalone = { name: "John Smith" };
    const ctx = createRedactContext();

    const redactedCall = redactRecord(record, ctx) as typeof record;
    const redactedStandalone = redactRecord(
      standalone,
      ctx
    ) as typeof standalone;

    expect(redactedCall.name).toBe("exec_command");
    expect(redactedStandalone.name).not.toBe("John Smith");
  });

  it("preserves input_schema-adjacent tool-spec name fields", () => {
    const toolSpec = {
      description: "Reads a file from disk",
      input_schema: { properties: {}, type: "object" },
      name: "read_file",
    };
    const ctx = createRedactContext();
    const redacted = redactRecord(toolSpec, ctx) as typeof toolSpec;

    expect(redacted.name).toBe("read_file");
  });

  it("is deterministic across separate redaction runs for tag-preserving and tool-name fixes", () => {
    const record = {
      call: {
        arguments: JSON.stringify({ cmd: "ls" }),
        call_id: "call_xyz789",
        name: "exec_command",
      },
      text: "# AGENTS.md instructions for /Users/mark/git/peek\n\n<INSTRUCTIONS>\nAlways write tests before code. Keep functions small and focused on one job.\n</INSTRUCTIONS>",
    };

    const redactedFirst = redactRecord(
      record,
      createRedactContext()
    ) as typeof record;
    const redactedSecond = redactRecord(
      record,
      createRedactContext()
    ) as typeof record;

    expect(redactedFirst).toEqual(redactedSecond);
    expect(redactedFirst.call.name).toBe("exec_command");
  });

  // Privacy audit (docs/PRIVACY-AUDIT.md) gap 1: an allowlisted key name no
  // longer guarantees passthrough — the value must also be enum-shaped.
  it("scrambles allowlisted-key values that carry free text instead of an enum (Gap 1 probe)", () => {
    const record = {
      other: {
        source: "reported by mark stuart via internal ticket",
      },
      tool_result: {
        status: "Blocked pending review from mark@company.com re: acquisition",
      },
    };
    const ctx = createRedactContext();
    const redacted = redactRecord(record, ctx) as typeof record;

    expect(redacted.tool_result.status).not.toBe(record.tool_result.status);
    expect(redacted.tool_result.status).not.toContain("mark@company.com");
    expect(redacted.tool_result.status.length).toBe(
      record.tool_result.status.length
    );
    expect(redacted.other.source).not.toBe(record.other.source);
    expect(redacted.other.source).not.toContain("mark stuart");
  });

  // Gap 3: Codex's real (flattened, non-nested) git field names must be
  // remapped like a path/identifier, not left to the short-string threshold.
  it("remaps Codex's flattened branch field instead of threshold-passing it (Gap 3 probe)", () => {
    const record = {
      payload: {
        branch: "mstuart",
        commit_hash: "abc1234",
        repository_url: "https://github.com/example/x.git",
      },
    };
    const ctx = createRedactContext();
    const redacted = redactRecord(record, ctx) as typeof record;

    expect(redacted.payload.branch).not.toBe("mstuart");
    expect(redacted.payload.branch.length).toBe("mstuart".length);
    expect(redacted.payload.repository_url).not.toBe(
      record.payload.repository_url
    );

    // Same value, same fake output wherever `branch` appears.
    const second = redactRecord({ branch: "mstuart" }, ctx) as {
      branch: string;
    };
    expect(second.branch).toBe(redacted.payload.branch);
  });

  // Gap 2: short strings are only allowed through when they're enum-shaped
  // (no spaces/symbols) — legitimate short enum values must still survive.
  it("still passes through short, space-free enum values (Gap 2 tightened, legitimate enums preserved)", () => {
    const record = {
      model_provider: "openai",
      role: "user",
      status: "managed",
      type: "function_call",
    };
    const ctx = createRedactContext();
    const redacted = redactRecord(record, ctx) as typeof record;

    expect(redacted).toEqual(record);
  });

  it("scrambles short strings that contain spaces or non-identifier characters (Gap 2 fix)", () => {
    const record = { note: "hi mark" };
    const ctx = createRedactContext();
    const redacted = redactRecord(record, ctx) as typeof record;

    expect(redacted.note).not.toBe("hi mark");
    expect(redacted.note.length).toBe("hi mark".length);
  });
});

// Privacy audit regression guard: re-running the redactor (with the Gap 1/2
// fixes) on the ALREADY-REDACTED real-capture fixtures must leave every
// allowlisted field byte-identical. All real allowlisted values in these
// fixtures are enum-shaped (no spaces), so the new enum-shape guard must not
// touch them — if it did, the shipped fixtures would need regeneration.
describe("real-capture fixtures stay stable under the tightened allowlist rules", () => {
  const fixturePaths = [
    "test/fixtures/codex/v0.134/real-capture-redacted.jsonl",
    "test/fixtures/codex/v0.134/real-capture-tools-redacted.jsonl",
  ];

  function collectAllowlisted(
    value: unknown,
    key: string | undefined,
    path: string,
    out: Record<string, string>
  ): void {
    if (value === null || typeof value !== "object") {
      if (
        typeof value === "string" &&
        key &&
        ALLOWLIST_KEYS.has(normalizeKey(key))
      ) {
        out[path] = value;
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        collectAllowlisted(item, key, `${path}[${index}]`, out);
      });
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectAllowlisted(v, k, `${path}.${k}`, out);
    }
  }

  it("leaves allowlisted key values unchanged when re-redacting the shipped fixtures", () => {
    for (const relPath of fixturePaths) {
      const raw = readFileSync(join(process.cwd(), relPath), "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);

      for (const line of lines) {
        const parsed = JSON.parse(line);
        const before: Record<string, string> = {};
        collectAllowlisted(parsed, undefined, "", before);

        const ctx = createRedactContext();
        const redacted = redactRecord(parsed, ctx);
        const after: Record<string, string> = {};
        collectAllowlisted(redacted, undefined, "", after);

        expect(after).toEqual(before);
      }
    }
  });
});

function sampleUuid(): string {
  return "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
}
