// Privacy-fix gate: results.ts's append() must never persist a trial's full
// raw harness result JSON (which carries the agent's response text) to
// bench-results/results.jsonl. Mirrors bench-infra.test.ts's tmpdir
// conventions.

import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createResultsWriter,
  parseResultsJsonl,
} from "../../src/bench/results.js";
import type { TrialResult } from "../../src/bench/types.js";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function baseResult(raw: unknown): TrialResult {
  return {
    configName: "config-a",
    exitCode: 0,
    harness: "claude-code",
    raw,
    startedAt: "2026-08-09T00:00:00.000Z",
    stderrTail: "",
    taskName: "task-a",
    timedOut: false,
    trialIndex: 0,
    verify: { exitCode: 0, passed: true },
    wallMs: 1234,
  };
}

describe("results.ts — raw redaction on write", () => {
  it("drops `result` (the agent's response text) and any other non-allowlisted field", async () => {
    const dir = tmpDir("peek-bench-results-");
    const writer = await createResultsWriter({
      baseDir: dir,
      timestamp: new Date(0),
    });

    const raw = {
      arbitrary_free_text_field: "some other content that should never persist",
      duration_api_ms: 3800,
      duration_ms: 4200,
      is_error: false,
      num_turns: 3,
      permission_denials: [],
      result:
        "Here is the full agent response, verbatim, including anything the user asked about in the workspace.",
      session_id: "sess-123",
      subtype: "success",
      total_cost_usd: 0.42,
      type: "result",
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    await writer.append(baseResult(raw));

    const raw2 = await readFile(writer.path, "utf8");
    expect(raw2).not.toContain("full agent response");
    expect(raw2).not.toContain("arbitrary_free_text_field");
    expect(raw2).not.toContain("should never persist");

    const { results, warnings } = parseResultsJsonl(raw2);
    expect(warnings).toEqual([]);
    expect(results).toHaveLength(1);
    const persistedRaw = results[0]?.raw as Record<string, unknown>;
    expect(persistedRaw.rawRedacted).toBe(true);
    expect(persistedRaw.result).toBeUndefined();
    expect(persistedRaw.arbitrary_free_text_field).toBeUndefined();
    // Safe/allowlisted fields survive.
    expect(persistedRaw.session_id).toBe("sess-123");
    expect(persistedRaw.total_cost_usd).toBe(0.42);
    expect(persistedRaw.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(persistedRaw.is_error).toBe(false);
  });

  it("handles a missing/undefined raw (setup-failure trials) without throwing", async () => {
    const dir = tmpDir("peek-bench-results-");
    const writer = await createResultsWriter({
      baseDir: dir,
      timestamp: new Date(0),
    });
    await writer.append(baseResult(undefined));

    const raw = await readFile(writer.path, "utf8");
    const { results, warnings } = parseResultsJsonl(raw);
    expect(warnings).toEqual([]);
    expect(results[0]?.raw).toBeUndefined();
  });
});
