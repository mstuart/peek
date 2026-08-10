import path from "node:path";
import { assert, describe, expect, it } from "vitest";
import { discoverCodexSessions } from "../../src/adapters/codex/discover.js";
import { parseCodexSession } from "../../src/adapters/codex/parse.js";
import type { SessionRef, Span } from "../../src/model/types.js";

const FIXTURES_ROOT = path.join(import.meta.dirname, "../fixtures/codex");

function refs(): Promise<SessionRef[]> {
  return discoverCodexSessions([FIXTURES_ROOT]);
}

function findRef(all: SessionRef[], id: string): SessionRef {
  const ref = all.find((r) => r.id === id);
  if (!ref) {
    throw new Error(`fixture ref not found: ${id}`);
  }
  return ref;
}

function onlySpan(spans: Span[] | undefined): Span {
  assert(spans);
  expect(spans).toHaveLength(1);
  return spans[0] as Span;
}

describe("response_item -> Turn assembly — v0.134/full-turn.jsonl", () => {
  it("produces 7 Turns, one per response_item record", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "full-turn"));
    expect(session.turns).toHaveLength(7);
  });

  it("user message -> plain userText (not an AGENTS.md/environment_context injection)", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "full-turn"));
    const turn = session.turns.at(0);
    expect(turn?.role).toBe("user");
    const span = onlySpan(turn?.contentSpans);
    expect(span.category).toBe("userText");
    expect(span.turnRole).toBe("user");
    expect(span.text).toBe(
      "Fetch the open issues for org/repo and read src/config.ts, then summarize what's blocking the v2 release."
    );
  });

  it("reasoning -> one thinking span from summary[]; encrypted_content produces NO span", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "full-turn"));
    const turn = session.turns.at(1);
    expect(turn?.role).toBe("assistant");
    const span = onlySpan(turn?.contentSpans);
    expect(span.category).toBe("thinking");
    expect(span.text).toBe(
      "Checking config.ts for the release-blocking feature flags before summarizing the open issues."
    );
  });

  it("namespaced function_call -> toolCallArgs span with mcpServer, charCount over the raw arguments string", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "full-turn"));
    const turn = session.turns.at(2);
    expect(turn?.role).toBe("assistant");
    const span = onlySpan(turn?.contentSpans);
    const rawArgs = '{"repo": "org/repo", "query": "release blocking"}';
    expect(span.category).toBe("toolCallArgs");
    expect(span.toolName).toBe("search_code");
    expect(span.mcpServer).toBe("github");
    expect(span.charCount).toBe(rawArgs.length);
    expect(span.text).toBe(rawArgs);
  });

  it("string-shaped function_call_output -> toolResults span linked to the namespaced call via call_id", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "full-turn"));
    const turn = session.turns.at(3);
    expect(turn?.role).toBe("user");
    const span = onlySpan(turn?.contentSpans);
    const output =
      "Found 3 open issues:\n- #142 flaky auth test\n- #150 release checklist\n- #161 config schema migration";
    expect(span.category).toBe("toolResults");
    expect(span.toolName).toBe("search_code");
    expect(span.mcpServer).toBe("github");
    expect(span.charCount).toBe(output.length);
  });

  it("plain (non-namespaced) function_call -> toolCallArgs span with no mcpServer", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "full-turn"));
    const turn = session.turns.at(4);
    const span = onlySpan(turn?.contentSpans);
    const rawArgs = '{"path": "src/config.ts"}';
    expect(span.category).toBe("toolCallArgs");
    expect(span.toolName).toBe("read_file");
    expect(span.mcpServer).toBeUndefined();
    expect(span.charCount).toBe(rawArgs.length);
  });

  it("{content_items:[...]}-shaped function_call_output -> toolResults span, concatenated text, linked via call_id", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "full-turn"));
    const turn = session.turns.at(5);
    const span = onlySpan(turn?.contentSpans);
    const contentItemsText =
      "export const FEATURE_FLAGS = {\n  v2Release: false,\n};\n";
    expect(span.category).toBe("toolResults");
    expect(span.toolName).toBe("read_file");
    expect(span.mcpServer).toBeUndefined();
    expect(span.charCount).toBe(contentItemsText.length);
  });

  it("assistant message -> assistantText span from output_text content", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "full-turn"));
    const turn = session.turns.at(6);
    expect(turn?.role).toBe("assistant");
    const span = onlySpan(turn?.contentSpans);
    expect(span.category).toBe("assistantText");
    expect(span.text).toContain("The v2 release is blocked by 3 open issues");
  });

  it("every Turn but the final one carries zeroed usage; the token_count-closing turn carries real usage (T4.5, see codex-usage.test.ts)", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "full-turn"));
    for (const turn of session.turns.slice(0, -1)) {
      expect(turn.usage.inputUncached).toBe(0);
      expect(turn.usage.cacheRead).toBe(0);
      expect(turn.usage.cacheWrite5m).toBe(0);
      expect(turn.usage.cacheWrite1h).toBe(0);
      expect(turn.usage.output).toBe(0);
      expect(turn.contextTotal).toBe(0);
      expect(turn.usage.raw).toBeDefined();
    }
    const finalTurn = session.turns.at(-1);
    expect(finalTurn?.contextTotal).toBe(18_420);
  });
});

describe("response_item -> Turn assembly — v0.88/basic-session.jsonl", () => {
  it("produces 4 Turns: developer, AGENTS.md injection, environment_context, task text", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "basic-session"));
    expect(session.turns).toHaveLength(4);
  });

  it("developer message -> instructionInjection span, turnRole/role system", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "basic-session"));
    const turn = session.turns.at(0);
    expect(turn?.role).toBe("system");
    const span = onlySpan(turn?.contentSpans);
    expect(span.category).toBe("instructionInjection");
    expect(span.turnRole).toBe("system");
    expect(span.text).toContain("sandboxed environment");
  });

  it("AGENTS.md-injection user message (wrapped in <INSTRUCTIONS>) -> instructionInjection span, not truncated", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "basic-session"));
    const turn = session.turns.at(1);
    expect(turn?.role).toBe("user");
    const span = onlySpan(turn?.contentSpans);
    expect(span.category).toBe("instructionInjection");
    expect(span.text?.startsWith("<INSTRUCTIONS>")).toBe(true);
    expect(span.text).toContain("# AGENTS.md instructions for");
    // turn_context's truncation_policy.limit is 10000 bytes; this fixture's
    // AGENTS.md content is far shorter, so it was not capped.
    expect(span.truncated).toBe(false);
  });

  it("<environment_context> user message -> instructionInjection span", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "basic-session"));
    const turn = session.turns.at(2);
    expect(turn?.role).toBe("user");
    const span = onlySpan(turn?.contentSpans);
    expect(span.category).toBe("instructionInjection");
    expect(span.text?.startsWith("<environment_context>")).toBe(true);
  });

  it("task user message -> plain userText span", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(findRef(all, "basic-session"));
    const turn = session.turns.at(3);
    expect(turn?.role).toBe("user");
    const span = onlySpan(turn?.contentSpans);
    expect(span.category).toBe("userText");
    expect(span.text).toBe(
      "Add input validation to the signup form and cover it with a unit test."
    );
  });
});

describe("response_item -> Turn assembly — v0.134/unknown-variant.jsonl", () => {
  it("known user message -> 1 Turn; unknown response_item -> exactly 1 unknown-response-item warning, no Turn", async () => {
    const all = await refs();
    const { session, warnings } = await parseCodexSession(
      findRef(all, "unknown-variant")
    );
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]?.role).toBe("user");

    const itemWarnings = warnings.filter(
      (w) => w.code === "unknown-response-item"
    );
    expect(itemWarnings).toHaveLength(1);
    expect(itemWarnings[0]?.message).toContain("future_item");

    // The event_msg "agent_status_update" unknown variant is validated by
    // T4.5's layer (usage.ts) — see codex-usage.test.ts for the dedicated
    // "unknown-event-msg" case and codex-meta.test.ts for the combined
    // 2-warning total on this fixture.
    expect(warnings).toHaveLength(2);
  });
});

describe("response_item -> Turn assembly — v0.134/real-capture-redacted.jsonl", () => {
  it("parses the 4 real message items into 4 Turns with no crash and no warnings", async () => {
    const all = await refs();
    const { session, warnings } = await parseCodexSession(
      findRef(all, "real-capture-redacted")
    );
    expect(warnings).toHaveLength(0);
    expect(session.turns).toHaveLength(4);
    for (const turn of session.turns) {
      expect(turn.contentSpans.length).toBeGreaterThan(0);
    }
  });

  it("developer message's multiple content blocks each become their own instructionInjection span", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(
      findRef(all, "real-capture-redacted")
    );
    const turn = session.turns.at(0);
    expect(turn?.role).toBe("system");
    expect(turn?.contentSpans).toHaveLength(4);
    for (const span of turn?.contentSpans ?? []) {
      expect(span.category).toBe("instructionInjection");
    }
  });

  it("<environment_context> user message is detected as instructionInjection", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(
      findRef(all, "real-capture-redacted")
    );
    const turn = session.turns.at(1);
    expect(turn?.role).toBe("user");
    const span = onlySpan(turn?.contentSpans);
    expect(span.category).toBe("instructionInjection");
  });

  it("assistant message -> assistantText span", async () => {
    const all = await refs();
    const { session } = await parseCodexSession(
      findRef(all, "real-capture-redacted")
    );
    const turn = session.turns.at(3);
    expect(turn?.role).toBe("assistant");
    const span = onlySpan(turn?.contentSpans);
    expect(span.category).toBe("assistantText");
    expect(span.text).toBe("ok");
  });
});
