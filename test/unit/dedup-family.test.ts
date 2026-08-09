// dedupFamily (T2.5 reconciliation follow-up) — dedup.ts's cross-file
// extension to accounting rule 2. Fixture family under test:
// test/fixtures/claude-code/v2.1.225/20000000-…0001.jsonl (parent) +
// its subagents/agent-abc123.jsonl child. The child's trailing record
// (s-0005) replays the parent's a-0001 turn verbatim (same message.id
// "msg-0001", same requestId "req-0001", identical usage) — the cross-file
// duplicate this module exists to catch (measured on a real 210-file
// session family: 319 such replays, ~76M tokens — see dedup.ts's header).

import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "../../src/adapters/claude/discover.js";
import { parseClaudeSession } from "../../src/adapters/claude/parse.js";
import { sessionTotals } from "../../src/engine/accounting.js";
import { bySubagent } from "../../src/engine/attribution.js";
import { dedupFamily, dedupSession } from "../../src/engine/dedup.js";
import type { Session, SessionRef } from "../../src/model/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, "../fixtures/claude-code");

async function refs(): Promise<SessionRef[]> {
  return discoverClaudeSessions([FIXTURES_ROOT]);
}

function findRef(
  all: SessionRef[],
  versionDir: string,
  id: string,
): SessionRef {
  const ref = all.find(
    (r) => r.id === id && r.path.includes(`${sep}${versionDir}${sep}`),
  );
  if (!ref) throw new Error(`fixture ref not found: ${versionDir}/${id}`);
  return ref;
}

/** Parses the parent + its one subagent child, as parsed by the adapter (no dedup applied yet). */
async function loadRawFamily(): Promise<[Session, Session]> {
  const all = await refs();
  const parentRef = findRef(
    all,
    "v2.1.225",
    "20000000-2000-4200-8200-200000000001",
  );
  const { session: parentSession } = await parseClaudeSession(parentRef);
  expect(parentSession.children).toHaveLength(1);
  const childRef = parentSession.children[0];
  if (!childRef) throw new Error("unreachable");
  const { session: childSession } = await parseClaudeSession(childRef);
  return [parentSession, childSession];
}

function messageIds(session: Session): (string | undefined)[] {
  return session.turns.map((t) => {
    const raw = t.usage.raw as { message?: { id?: string } } | undefined;
    return raw?.message?.id;
  });
}

describe("dedupFamily — fixture family (parent + subagent replay)", () => {
  it("fixture sanity: child file has 3 raw turns, the 3rd replaying the parent's msg-0001/req-0001", async () => {
    const [parent, child] = await loadRawFamily();
    expect(messageIds(parent)).toEqual(["msg-0001", "msg-0002"]);
    expect(messageIds(child)).toEqual([
      "msg-sub-0001",
      "msg-sub-0002",
      "msg-0001",
    ]);

    const replay = child.turns[2];
    const parentOriginal = parent.turns[0];
    expect(replay?.usage.inputUncached).toBe(
      parentOriginal?.usage.inputUncached,
    );
    expect(replay?.usage.cacheRead).toBe(parentOriginal?.usage.cacheRead);
    expect(replay?.usage.output).toBe(parentOriginal?.usage.output);
  });

  it("zeros the replayed child turn's usage/cost/contextTotal; leaves contentSpans and the parent's copy untouched", async () => {
    const [parent, child] = await loadRawFamily();
    const [dedupedParent, dedupedChild] = dedupFamily([parent, child]);

    expect(dedupedParent?.turns).toHaveLength(2);
    expect(dedupedParent?.turns[0]?.usage.inputUncached).toBe(1800);
    expect(dedupedParent?.turns[0]?.usage.cacheRead).toBe(200);
    expect(dedupedParent?.turns[0]?.usage.output).toBe(140);
    expect(dedupedParent?.turns[0]?.contextTotal).toBe(2000);

    expect(dedupedChild?.turns).toHaveLength(3);
    const [subOne, subTwo, replay] = dedupedChild?.turns ?? [];

    // Genuine child turns are untouched.
    expect(subOne?.usage.inputUncached).toBe(600);
    expect(subOne?.contextTotal).toBe(600);
    expect(subTwo?.usage.inputUncached).toBe(750);
    expect(subTwo?.usage.cacheRead).toBe(600);
    expect(subTwo?.contextTotal).toBe(1350);

    // The replay is zeroed, not removed (array length unchanged, above).
    expect(replay?.usage.inputUncached).toBe(0);
    expect(replay?.usage.cacheRead).toBe(0);
    expect(replay?.usage.cacheWrite5m).toBe(0);
    expect(replay?.usage.cacheWrite1h).toBe(0);
    expect(replay?.usage.output).toBe(0);
    expect(replay?.contextTotal).toBe(0);
    expect(replay?.cost.total).toBe(0);
    expect(replay?.cost.priced).toBe(true); // forced true — a zeroed replay is not "unpriced" spend

    // contentSpans (and raw.message.id) survive — this session's own,
    // non-family composition view still shows the turn's real shape.
    expect(replay?.contentSpans.length).toBeGreaterThan(0);
    const rawId = (replay?.usage.raw as { message: { id: string } }).message.id;
    expect(rawId).toBe("msg-0001");

    // Events untouched.
    expect(dedupedChild?.events).toEqual(child.events);
  });

  it("family token totals count the parent's msg-0001 copy exactly once (exact arithmetic)", async () => {
    const [parent, child] = await loadRawFamily();
    const [dedupedParent, dedupedChild] = dedupFamily([parent, child]);
    if (!dedupedParent || !dedupedChild) throw new Error("unreachable");

    const parentTotals = sessionTotals(dedupedParent);
    const childTotals = sessionTotals(dedupedChild);

    // Parent: msg-0001 (in 1800, cacheRead 200, out 140) + msg-0002 (in 2100, cacheRead 1800, out 95).
    expect(parentTotals.tokens.inputUncached).toBe(1800 + 2100);
    expect(parentTotals.tokens.cacheRead).toBe(200 + 1800);
    expect(parentTotals.tokens.output).toBe(140 + 95);
    expect(parentTotals.tokens.contextTotal).toBe(2000 + 3900);

    // Child: msg-sub-0001 (in 600, out 70) + msg-sub-0002 (in 750, cacheRead 600, out 55)
    // + the zeroed replay (0). NOT 1800/200/140 extra from the replay.
    expect(childTotals.tokens.inputUncached).toBe(600 + 750);
    expect(childTotals.tokens.cacheRead).toBe(600);
    expect(childTotals.tokens.output).toBe(70 + 55);
    expect(childTotals.tokens.contextTotal).toBe(600 + 1350);

    // Contrast: per-file dedup ALONE (no family pass) still double-counts —
    // this is the exact bug dedupFamily exists to fix.
    const naiveChildTotals = sessionTotals(dedupSession(child));
    expect(naiveChildTotals.tokens.inputUncached).toBe(600 + 750 + 1800);
    expect(naiveChildTotals.tokens.contextTotal).toBe(600 + 1350 + 2000);
  });

  it("single-session family is identity (up to per-file dedupSession)", async () => {
    const [parent] = await loadRawFamily();
    const result = dedupFamily([parent]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(dedupSession(parent));
  });

  it("is idempotent: dedupFamily(dedupFamily(x)) equals dedupFamily(x)", async () => {
    const [parent, child] = await loadRawFamily();
    const once = dedupFamily([parent, child]);
    const twice = dedupFamily(once);
    expect(twice).toEqual(once);
  });

  it("ordering is purely POSITIONAL — sessions[0] is canonical regardless of which member it actually is (documented, not auto-detected: Session carries no `kind` field)", async () => {
    const [parent, child] = await loadRawFamily();

    // Documented contract order: parent first. The parent's msg-0001 survives.
    const parentFirst = dedupFamily([parent, child]);
    const parentFirstChild = parentFirst[1];
    expect(parentFirstChild?.turns[2]?.usage.inputUncached).toBe(0); // child's replay zeroed
    expect(parentFirst[0]?.turns[0]?.usage.inputUncached).toBe(1800); // parent's original kept

    // Child-first (a caller contract violation): dedupFamily has no way to
    // tell this isn't the parent, so the FIRST array element still wins —
    // the child's replay copy becomes canonical and the parent's own
    // original a-0001 turn is what gets zeroed instead.
    const childFirst = dedupFamily([child, parent]);
    const childFirstChild = childFirst[0];
    const childFirstParent = childFirst[1];
    expect(childFirstChild?.turns[2]?.usage.inputUncached).toBe(1800); // child's replay now kept
    expect(childFirstParent?.turns[0]?.usage.inputUncached).toBe(0); // parent's original zeroed
  });
});

describe("attribution.ts's bySubagent — routes through dedupFamily", () => {
  it("combined/childrenCombined totals exclude the cross-file replay", async () => {
    const [parent, child] = await loadRawFamily();
    const rollup = bySubagent([parent, child]);

    // parent: 3900 inputUncached, 2000 cacheRead, 235 output, 5900 contextTotal.
    expect(rollup.parent.tokens.inputUncached).toBe(3900);
    expect(rollup.parent.tokens.contextTotal).toBe(5900);

    // children: deduped — 1350 inputUncached, 600 cacheRead, 125 output, 1950 contextTotal
    // (NOT +1800/+200/+140/+2000 from the replay).
    expect(rollup.childrenCombined.tokens.inputUncached).toBe(1350);
    expect(rollup.childrenCombined.tokens.cacheRead).toBe(600);
    expect(rollup.childrenCombined.tokens.output).toBe(125);
    expect(rollup.childrenCombined.tokens.contextTotal).toBe(1950);

    expect(rollup.combined.tokens.inputUncached).toBe(3900 + 1350);
    expect(rollup.combined.tokens.contextTotal).toBe(5900 + 1950);

    // bySubagent's own child list still reports one entry (the replay was
    // zeroed within the existing child session, not split into a new one).
    expect(rollup.children).toHaveLength(1);
    expect(rollup.children[0]?.id).toBe(child.id);
  });
});
