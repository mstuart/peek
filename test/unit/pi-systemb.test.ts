import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePiSession } from "../../src/adapters/pi/parse.js";
import { parseSystemBSession } from "../../src/adapters/pi/systemB.js";
import type { CompactionEvent, SessionRef } from "../../src/model/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, "../fixtures/pi");
const SYSTEM_B_DIR = join(FIXTURES_ROOT, "system-b-v4");

const CASE6_SYSTEM_B: SessionRef = {
  harness: "pi",
  id: "b9f0fc61-c03e-49c7-a148-e1e7c660822c",
  path: join(
    SYSTEM_B_DIR,
    "2026-08-01T16-00-00-000Z_b9f0fc61-c03e-49c7-a148-e1e7c660822c.jsonl",
  ),
  sizeBytes: 0,
  mtime: new Date(0),
  kind: "main",
};

function isCompaction(e: { kind: string }): e is CompactionEvent {
  return e.kind === "compaction";
}

const COMPACTION_SUMMARY =
  "User asked why billing tests fail; found a missing null check in calculateInvoiceTotal, fix in progress.";

describe("parsePiSession — case 6: System B (harness v4), full realistic fixture", () => {
  it("no longer detect-and-skip: parses a real session (harnessVersion/id/cwd from the header, turns populated)", async () => {
    const { session } = await parsePiSession(CASE6_SYSTEM_B);
    expect(session.harness).toBe("pi");
    expect(session.harnessVersion).toBe("4");
    expect(session.id).toBe("b9f0fc61-c03e-49c7-a148-e1e7c660822c");
    expect(session.cwd).toBe("/Users/fake/project");
    expect(session.startedAt).toEqual(new Date(1785600000000));
    expect(session.turns.length).toBeGreaterThan(0);
  });

  it("walks the active ('main') lane's leaf to produce 6 turns: user/assistant/user/assistant/user/assistant", async () => {
    const { session } = await parsePiSession(CASE6_SYSTEM_B);
    expect(session.turns).toHaveLength(6);
    expect(session.turns.map((t) => t.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("warns '1 other lane(s) ignored' — the 'explore' lane's last move (seq 5) loses to 'main's (seq 18)", async () => {
    const { warnings } = await parsePiSession(CASE6_SYSTEM_B);
    const laneWarning = warnings.find(
      (w) => w.code === "pi-systemb-multiple-lanes",
    );
    expect(laneWarning?.message).toBe("1 other lane(s) ignored");
  });

  it("computes usage/contextTotal/cost exactly for each of the 3 assistant turns", async () => {
    const { session } = await parsePiSession(CASE6_SYSTEM_B);
    const [turn1, turn2, turn3] = session.turns.filter(
      (t) => t.role === "assistant",
    );

    expect(turn1?.usage).toMatchObject({
      inputUncached: 1200,
      cacheRead: 400,
      cacheWrite5m: 150,
      cacheWrite1h: 0,
      output: 220,
    });
    expect(turn1?.contextTotal).toBe(1750);
    expect(turn1?.cost.total).toBe(0.0075925);

    expect(turn2?.usage).toMatchObject({
      inputUncached: 300,
      cacheRead: 1750,
      cacheWrite5m: 0,
      output: 180,
    });
    expect(turn2?.contextTotal).toBe(2050);
    expect(turn2?.cost.total).toBe(0.004125);

    expect(turn3?.usage).toMatchObject({
      inputUncached: 200,
      cacheRead: 0,
      cacheWrite5m: 1200,
      output: 140,
    });
    expect(turn3?.contextTotal).toBe(1400);
    expect(turn3?.cost.total).toBe(0.0072);
  });

  it("emits one CompactionEvent: tokensBeforeExact 15000 (verbatim tokensBefore), turnIndex 4, summaryTokensEst ceil(104/4)=26, cost.total 0.01635", async () => {
    const { session } = await parsePiSession(CASE6_SYSTEM_B);
    const compactions = session.events.filter(isCompaction);
    expect(compactions).toHaveLength(1);
    const event = compactions[0] as CompactionEvent;

    expect(event.tokensBeforeExact).toBe(15000);
    expect(event.turnIndex).toBe(4);
    expect(event.tokensAfterExact).toBeNull();
    expect(event.shrinkExact).toBeNull();
    expect(event.discardedEst).toBeNull();
    expect(event.summaryTokensEst).toBe(
      Math.ceil(COMPACTION_SUMMARY.length / 4),
    );
    expect(event.cost?.total).toBe(0.01635);
    expect(event.cost?.mode).toBe("display");
    expect(event.cost?.priced).toBe(true);
  });

  it("notes retainedTail's length via a warning instead of synthesizing Turns from it (stop-and-report per task CAUTION)", async () => {
    const { session, warnings } = await parsePiSession(CASE6_SYSTEM_B);
    const retainedWarning = warnings.find(
      (w) => w.code === "pi-systemb-compaction-retained-tail",
    );
    expect(retainedWarning?.message).toBe(
      "compaction retained 2 trailing message(s) via retainedTail (not replayed as Turns)",
    );
    // The fixture's retainedTail messages ("Fix the billing module
    // failures." / "On it, looking at calculateInvoiceTotal.") never appear
    // as their own Turn text — confirming they were noted, not replayed.
    const allText = session.turns.flatMap((t) =>
      t.contentSpans.map((s) => s.text),
    );
    expect(allText).not.toContain("On it, looking at calculateInvoiceTotal.");
  });

  it("usage cross-check: last UsageRecord (4200) vs Σ per-turn totals (1970+2230+1540=5740) diverges >1% -> pi-systemb-usage-record-mismatch (expected post-compaction discontinuity, mirrors codex's cumulative-counter-resets behavior)", async () => {
    const { warnings } = await parsePiSession(CASE6_SYSTEM_B);
    const mismatch = warnings.filter(
      (w) => w.code === "pi-systemb-usage-record-mismatch",
    );
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]?.message).toBe(
      "cumulative UsageRecord total (4200) diverges from Σ per-turn totals (5740) by more than 1%",
    );
  });

  it("warns on the unrecognized top-level mutation kind ('telemetry') but continues without throwing", async () => {
    const { session, warnings } = await parsePiSession(CASE6_SYSTEM_B);
    const unknown = warnings.find((w) => w.code === "pi-systemb-unknown-kind");
    expect(unknown?.message).toBe(
      "unrecognized System B mutation kind: telemetry",
    );
    expect(unknown?.recordType).toBe("telemetry");
    // The unknown line is the last in the file — parsing still completed and
    // produced the full turn set (not truncated early).
    expect(session.turns).toHaveLength(6);
  });

  it("fact(name) is silently ignored: no Turn, no event, no warning references it, and Session has no name field to carry it", async () => {
    const { session, warnings } = await parsePiSession(CASE6_SYSTEM_B);
    expect(warnings.some((w) => w.message.includes("Fix billing module"))).toBe(
      false,
    );
    expect(session.turns).toHaveLength(6); // the fact line contributed no Turn
    expect((session as unknown as { name?: unknown }).name).toBeUndefined();
  });

  it("holds the compaction summary + post-compaction user span pending, landing both on the next assistant turn", async () => {
    const { session } = await parsePiSession(CASE6_SYSTEM_B);
    const landingTurn = session.turns[5];
    expect(landingTurn?.role).toBe("assistant");
    expect(landingTurn?.contentSpans).toContainEqual({
      category: "compactionSummaries",
      charCount: COMPACTION_SUMMARY.length,
      text: COMPACTION_SUMMARY,
      truncated: false,
      turnRole: "user",
    });
    expect(landingTurn?.contentSpans).toContainEqual(
      expect.objectContaining({
        category: "userText",
        text: "Go ahead and apply the fix.",
      }),
    );
  });
});

describe("parseSystemBSession — direct pure-function tests (inline mutation-log lines)", () => {
  function makeRef(): SessionRef {
    return {
      harness: "pi",
      id: "inline-test-id",
      path: "/dev/null/does-not-exist.jsonl",
      sizeBytes: 0,
      mtime: new Date(0),
      kind: "main",
    };
  }

  const HEADER =
    '{"kind":"header","version":4,"id":"inline-header-id","timestamp":1785600000000,"cwd":"/Users/fake/inline"}';

  it("single lane: no 'other lanes ignored' warning", () => {
    const lines = [
      HEADER,
      '{"kind":"entry","seq":1,"type":"message","id":"z1","parentId":null,"timestamp":1785600001000,"message":{"role":"user","content":"hi","timestamp":1785600001000}}',
      '{"kind":"lane","seq":2,"laneId":"main","action":"append","entryId":"z1","timestamp":1785600001100}',
    ];
    const { warnings } = parseSystemBSession(makeRef(), lines, true);
    expect(
      warnings.find((w) => w.code === "pi-systemb-multiple-lanes"),
    ).toBeUndefined();
  });

  it("usage cross-check passes when the cumulative UsageRecord matches Σ per-turn totals within tolerance (no compaction)", () => {
    const lines = [
      HEADER,
      '{"kind":"entry","seq":1,"type":"message","id":"z1","parentId":null,"timestamp":1785600001000,"message":{"role":"user","content":"hi","timestamp":1785600001000}}',
      '{"kind":"lane","seq":2,"laneId":"main","action":"append","entryId":"z1","timestamp":1785600001100}',
      '{"kind":"entry","seq":3,"type":"message","id":"z2","parentId":"z1","timestamp":1785600002000,"message":{"role":"assistant","content":[{"type":"text","text":"hello"}],"model":"claude-sonnet-5","usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"totalTokens":150},"timestamp":1785600002000}}',
      '{"kind":"lane","seq":4,"laneId":"main","action":"append","entryId":"z2","timestamp":1785600002100}',
      '{"kind":"record","seq":5,"type":"usage","usage":{"totalTokens":150},"timestamp":1785600002200}',
    ];
    const { session, warnings } = parseSystemBSession(makeRef(), lines, true);
    expect(session.turns).toHaveLength(2);
    expect(
      warnings.find((w) => w.code === "pi-systemb-usage-record-mismatch"),
    ).toBeUndefined();
  });

  it("a malformed entry mutation (missing parentId) warns and is skipped without breaking the rest of the tree", () => {
    const lines = [
      HEADER,
      '{"kind":"entry","seq":1,"type":"message","id":"z1","timestamp":1785600001000,"message":{"role":"user","content":"hi","timestamp":1785600001000}}',
      '{"kind":"entry","seq":2,"type":"message","id":"z2","parentId":null,"timestamp":1785600002000,"message":{"role":"user","content":"hi again","timestamp":1785600002000}}',
      '{"kind":"lane","seq":3,"laneId":"main","action":"append","entryId":"z2","timestamp":1785600002100}',
    ];
    const { session, warnings } = parseSystemBSession(makeRef(), lines, true);
    expect(warnings.some((w) => w.code === "pi-systemb-malformed-entry")).toBe(
      true,
    );
    // z1 (malformed, missing parentId) never entered the tree; z2 (a
    // separate root) still parses fine as the sole turn.
    expect(session.turns).toHaveLength(1);
  });

  it("an unrecognized top-level kind warns with the exact kind name and continues", () => {
    const lines = [
      HEADER,
      '{"kind":"snapshot","seq":1,"note":"not a real System B kind","timestamp":1785600001000}',
      '{"kind":"entry","seq":2,"type":"message","id":"z1","parentId":null,"timestamp":1785600002000,"message":{"role":"user","content":"hi","timestamp":1785600002000}}',
      '{"kind":"lane","seq":3,"laneId":"main","action":"append","entryId":"z1","timestamp":1785600002100}',
    ];
    const { session, warnings } = parseSystemBSession(makeRef(), lines, true);
    const unknown = warnings.find((w) => w.code === "pi-systemb-unknown-kind");
    expect(unknown?.message).toBe(
      "unrecognized System B mutation kind: snapshot",
    );
    expect(session.turns).toHaveLength(1);
  });
});
