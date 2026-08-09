// scripts/redact.ts — structure-preserving, content-scrambling redactor for real
// session logs (Claude Code / Codex JSONL), per docs/DESIGN.md § Deferred / limitations
// ledger item 6 (real logs never leave the machine;
// synthetic/redacted fixtures only). Shapes handled per docs/recon/claude-code.md
// and docs/recon/codex.md.
//
// Usage: npx tsx scripts/redact.ts <input.jsonl> <output.jsonl>
//
// Design:
//   - Every string value is classified by (key name, value shape) into one of:
//     allowlist (enum-ish key AND enum-shaped value → pass through), timestamp
//     (ISO8601 → pass through), path (cwd/gitBranch/branch/repository_url/
//     `/Users/...` → consistent fake path), id (uuid/toolu_*/msg_*/known
//     id-key-name → consistent fake id, same format), scramble (free text >8
//     chars, or ≤8 chars that isn't enum-shaped → same-length deterministic
//     gibberish), passthrough (≤8 chars AND enum-shaped → left as-is).
//   - "Enum-shaped" means it matches ENUM_SHAPE_RE (`^[A-Za-z0-9_.:/-]{1,64}$`,
//     no spaces) — real enum/model/status/branch-name values never contain
//     spaces, so this is a cheap, conservative filter that catches free-text
//     content (which almost always has spaces) even when it lands on an
//     allowlisted key name or under the short-string threshold. Residual,
//     accepted risk: a short, space-free, identifier-shaped secret (e.g. a
//     git username used as a branch name) still passes through unscrambled —
//     scrambling every short alnum string would also destroy the legitimate
//     enum values this allowlist exists to protect, and those can't be
//     enumerated exhaustively. See docs/PRIVACY-AUDIT.md gaps 1 and 2.
//   - Numbers and booleans are never redacted — intentional, not a gap. They
//     carry the product's actual data (token counts, usage percentages, rate
//     limit fields) and have no free-text leak surface. See
//     docs/PRIVACY-AUDIT.md gap 4.
//   - All transforms are keyed by a hash of the ORIGINAL VALUE (never by JSON
//     position), memoized in the shared RedactContext. This is what makes the
//     transform both idempotent-per-value (identical inputs → identical outputs)
//     AND relationship-preserving: Claude Code's `toolUseResult` (structured) and
//     the sibling inline `tool_result` block are byte-identical in the source in
//     9/10 samples (docs/recon/claude-code.md); since scrambling is a pure
//     function of the string's own bytes, that byte-identical relationship
//     survives redaction untouched, which is what the engine's dedup tests rely
//     on downstream.
//   - Codex `function_call.arguments` is a JSON-string (docs/recon/codex.md); it
//     is parsed, recursed into structurally, and re-stringified so nested content
//     gets the same treatment as native JSON fields.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Key-name allowlists (matched case-insensitively, ignoring underscores, so
// "stop_reason", "stopReason", and "STOP_REASON" are all the same bucket).
// ---------------------------------------------------------------------------

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/_/g, "");
}

// Enum-like short strings whose VALUES must survive verbatim for downstream
// dispatch/logic to keep working (record-type dispatch, model routing, cost
// tiering, etc). Conservative on purpose — anything not obviously a closed
// vocabulary field falls through to scrambling instead.
export const ALLOWLIST_KEYS = new Set(
  [
    "type",
    "role",
    "subtype",
    "model",
    "stop_reason",
    "service_tier",
    "speed",
    "inference_geo",
    "status",
    "source",
    "originator",
    "cli_version",
    "version",
    // additional harness enums observed in docs/recon/*.md, same conservative bar:
    "kind",
    "mode",
    "namespace",
    "approval_policy",
    "sandbox_policy",
    "effort",
    "model_provider",
    "userType",
  ].map(normalizeKey),
);

// Fields that are identifiers by key name regardless of their string shape —
// remapped consistently (same input → same output), not scrambled to noise.
const ID_KEY_NAMES = new Set(
  [
    "id",
    "uuid",
    "sessionId",
    "parentUuid",
    "requestId",
    "agentId",
    "agentUuid",
    "messageId",
    "threadId",
    "toolUseId",
    "promptId",
    "callId",
    "childId",
  ].map(normalizeKey),
);

// Fields that are paths/branch-names/URLs by key name — always routed through
// the path remapper (segment-consistent fake), even when short. Includes
// Codex's flattened `branch`/`repositoryUrl` field names (payload.git is not
// nested — docs/recon/codex.md), alongside Claude Code's `gitBranch`; both
// `git_branch` and `repository_url` normalize to the same bucket as
// `gitBranch`/`repositoryUrl` since normalizeKey strips underscores.
const PATH_KEYS = new Set(
  [
    "cwd",
    "gitBranch",
    "git_branch",
    "branch",
    "repository_url",
    "repositoryUrl",
  ].map(normalizeKey),
);

// "name" is too broad to blanket-allowlist (would pass through user content
// like {"name": "John Smith"}). It's only safe when the CONTAINING object is
// structurally a tool-call or tool-spec object — i.e. it has one of these
// sibling keys (Codex `function_call` has call_id + arguments; `dynamic_tools`
// specs have input_schema). Checked context-aware in redactRecord, not here.
const TOOL_CALL_CONTEXT_SIBLING_KEYS = new Set(
  ["call_id", "arguments", "input_schema", "tool_use_id"].map(normalizeKey),
);
const TOOL_CALL_NAME_KEYS = new Set(["name", "toolName"].map(normalizeKey));

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TOOLU_RE = /^toolu_[A-Za-z0-9_-]+$/;
const MSG_ID_RE = /^msg_[A-Za-z0-9_-]+$/;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

// Shape a real enum/model/status/branch-name value always has: identifier
// characters only, no spaces. Free text (the thing we need to redact) almost
// always contains a space or punctuation outside this set. Used to gate both
// the ALLOWLIST_KEYS passthrough (Gap 1) and the short-string passthrough
// (Gap 2) so a key-name collision or a short fragment can't smuggle sentence-
// shaped content through unredacted.
const ENUM_SHAPE_RE = /^[A-Za-z0-9_.:/-]{1,64}$/;

// Structural prefixes that detection heuristics key off of — kept verbatim,
// only the remainder of the string is scrambled.
const STRUCTURAL_PREFIXES = [
  "This session is being continued",
  "<INSTRUCTIONS>",
  "<environment_context>",
  "# AGENTS.md instructions",
];

// Structural wrapper tags that can appear ANYWHERE in a string (not just as a
// leading prefix) — e.g. Codex wraps injected AGENTS.md content mid-string as
// `<INSTRUCTIONS>...</INSTRUCTIONS>` after a leading "# AGENTS.md instructions
// for <cwd>" line, and `<environment_context>` blocks nest `<cwd>`, `<shell>`,
// `<current_date>`, `<timezone>` sub-tags. These are preserved as whole tokens
// wherever they occur; the text between them is scrambled per-segment so the
// overall string length is unchanged.
const STRUCTURAL_TAGS = [
  "<INSTRUCTIONS>",
  "</INSTRUCTIONS>",
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
];

const STRUCTURAL_TAG_SPLIT_RE = new RegExp(
  `(${STRUCTURAL_TAGS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
  "g",
);

// Splits `text` on structural tags, keeping tag segments verbatim and
// scrambling everything else to the same length. `seedBase` is the ORIGINAL
// full value being redacted (not just this substring) so output stays a
// deterministic, ctx-independent function of the source string.
function scrambleWithTags(text: string, seedBase: string): string {
  const parts = text.split(STRUCTURAL_TAG_SPLIT_RE);
  let out = "";
  parts.forEach((part, i) => {
    if (part.length === 0) return;
    if (STRUCTURAL_TAGS.includes(part)) {
      out += part;
    } else {
      out += scrambleCharset(`${seedBase}::seg${i}`, part.length);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG — seeded from a SHA-256 of the original value so the same
// input always scrambles to the same output, but the output shares no
// positional relationship with the input (no partial-substring leakage risk).
// ---------------------------------------------------------------------------

const CHARSET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function seedFromString(s: string): number {
  const digest = createHash("sha256").update(s, "utf8").digest();
  return digest.readUInt32BE(0);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scrambleCharset(seedKey: string, length: number): string {
  const rand = mulberry32(seedFromString(seedKey));
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CHARSET.charAt(Math.floor(rand() * CHARSET.length));
  }
  return out;
}

function fakeUuidFrom(original: string): string {
  const hex = createHash("sha256")
    .update(original, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Context — memoization maps (consistency across the whole file) + counters.
// ---------------------------------------------------------------------------

export interface RedactStats {
  linesProcessed: number;
  stringsScrambled: number;
  idsRemapped: number;
}

export interface RedactContext {
  textMap: Map<string, string>;
  idMap: Map<string, string>;
  pathMap: Map<string, string>;
  segmentMap: Map<string, string>;
  stats: RedactStats;
}

export function createRedactContext(): RedactContext {
  return {
    textMap: new Map(),
    idMap: new Map(),
    pathMap: new Map(),
    segmentMap: new Map(),
    stats: { linesProcessed: 0, stringsScrambled: 0, idsRemapped: 0 },
  };
}

// ---------------------------------------------------------------------------
// Classification + per-class transforms
// ---------------------------------------------------------------------------

type StringClass =
  | "allowlist"
  | "timestamp"
  | "path"
  | "id"
  | "scramble"
  | "passthrough";

function classify(key: string | undefined, value: string): StringClass {
  const nk = key ? normalizeKey(key) : "";
  // Gap 1 fix: an allowlisted key only passes its value through when the
  // value itself is enum-shaped (no spaces). A free-text value that happens
  // to land on an allowlisted key name (e.g. a tool's own `status` field
  // carrying a sentence) falls through to the checks below instead.
  if (key && ALLOWLIST_KEYS.has(nk) && ENUM_SHAPE_RE.test(value))
    return "allowlist";
  if (ISO_TIMESTAMP_RE.test(value)) return "timestamp";
  if (key && PATH_KEYS.has(nk)) return "path";
  if (value.startsWith("/Users/")) return "path";
  if (UUID_RE.test(value) || TOOLU_RE.test(value) || MSG_ID_RE.test(value))
    return "id";
  if (key && ID_KEY_NAMES.has(nk)) return "id";
  if (value.length > 8) return "scramble";
  // Gap 2 fix: a short (≤8 char) value only passes through unclassified when
  // it's also enum-shaped. Anything with a space or symbol outside the
  // identifier charset is scrambled instead of assumed harmless.
  return ENUM_SHAPE_RE.test(value) ? "passthrough" : "scramble";
}

function scrambleFreeText(original: string, ctx: RedactContext): string {
  const cached = ctx.textMap.get(original);
  if (cached !== undefined) return cached;
  const prefix = STRUCTURAL_PREFIXES.find((p) => original.startsWith(p));
  const head = prefix ?? "";
  const rest = original.slice(head.length);
  const result = head + scrambleWithTags(rest, original);
  ctx.textMap.set(original, result);
  ctx.stats.stringsScrambled++;
  return result;
}

function remapId(original: string, ctx: RedactContext): string {
  const cached = ctx.idMap.get(original);
  if (cached !== undefined) return cached;
  let fake: string;
  if (UUID_RE.test(original)) {
    fake = fakeUuidFrom(original);
  } else if (original.startsWith("toolu_")) {
    fake = `toolu_${scrambleCharset(original, original.length - "toolu_".length)}`;
  } else if (original.startsWith("msg_")) {
    fake = `msg_${scrambleCharset(original, original.length - "msg_".length)}`;
  } else {
    fake = scrambleCharset(original, original.length);
  }
  ctx.idMap.set(original, fake);
  ctx.stats.idsRemapped++;
  return fake;
}

function remapSegment(seg: string, ctx: RedactContext): string {
  if (seg === "" || seg === "Users") return seg; // structural, not sensitive
  const cached = ctx.segmentMap.get(seg);
  if (cached !== undefined) return cached;
  const dot = seg.lastIndexOf(".");
  let fake: string;
  if (dot > 0 && dot < seg.length - 1 && seg.length - dot <= 8) {
    const base = seg.slice(0, dot);
    const ext = seg.slice(dot);
    fake = scrambleCharset(seg, base.length) + ext;
  } else {
    fake = scrambleCharset(seg, seg.length);
  }
  ctx.segmentMap.set(seg, fake);
  return fake;
}

function remapPath(original: string, ctx: RedactContext): string {
  const cached = ctx.pathMap.get(original);
  if (cached !== undefined) return cached;
  const fake = original
    .split("/")
    .map((seg) => remapSegment(seg, ctx))
    .join("/");
  ctx.pathMap.set(original, fake);
  ctx.stats.idsRemapped++;
  return fake;
}

function redactStringValue(
  value: string,
  key: string | undefined,
  ctx: RedactContext,
): string {
  switch (classify(key, value)) {
    case "allowlist":
    case "timestamp":
    case "passthrough":
      return value;
    case "path":
      return remapPath(value, ctx);
    case "id":
      return remapId(value, ctx);
    case "scramble":
      return scrambleFreeText(value, ctx);
  }
}

function tryParseJsonObjectOrArray(s: string): unknown {
  try {
    const parsed = JSON.parse(s);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Recursively redact a parsed JSON value. Exported transform function used by tests. */
export function redactRecord(
  value: unknown,
  ctx: RedactContext,
  key?: string,
): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "string"
      ? redactStringValue(value, key, ctx)
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactRecord(item, ctx, key));
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  // Context-aware allowlist for "name"/"toolName": only when THIS object also
  // looks like a tool-call/tool-spec object (has call_id/arguments/
  // input_schema/tool_use_id as a sibling key) — see Gap 2 note above.
  const isToolCallLikeObject = entries.some(([k]) =>
    TOOL_CALL_CONTEXT_SIBLING_KEYS.has(normalizeKey(k)),
  );
  for (const [k, v] of entries) {
    if (
      isToolCallLikeObject &&
      typeof v === "string" &&
      TOOL_CALL_NAME_KEYS.has(normalizeKey(k))
    ) {
      out[k] = v;
      continue;
    }
    // Codex function_call.arguments is a JSON-STRING (docs/recon/codex.md) —
    // parse, recurse, re-stringify so nested content is redacted structurally.
    if (k === "arguments" && typeof v === "string") {
      const nested = tryParseJsonObjectOrArray(v);
      if (nested !== undefined) {
        out[k] = JSON.stringify(redactRecord(nested, ctx, k));
        continue;
      }
    }
    out[k] = redactRecord(v, ctx, k);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function isCodexLineShape(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return (
    keys.length === 3 &&
    keys.includes("timestamp") &&
    keys.includes("type") &&
    keys.includes("payload")
  );
}

function main(): void {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    console.error(
      "Usage: npx tsx scripts/redact.ts <input.jsonl> <output.jsonl>",
    );
    process.exit(1);
  }

  const raw = readFileSync(inputPath, "utf8");
  const trailingNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  const lastLine = lines[lines.length - 1];
  if (trailingNewline && lastLine === "") lines.pop();

  const ctx = createRedactContext();
  let codexLines = 0;
  let claudeLines = 0;
  const outLines: string[] = [];

  lines.forEach((line, i) => {
    if (line.trim().length === 0) {
      outLines.push(line);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `redact.ts: invalid JSON on line ${i + 1} of ${inputPath}: ${(err as Error).message}`,
      );
    }
    if (isCodexLineShape(parsed)) codexLines++;
    else claudeLines++;
    outLines.push(JSON.stringify(redactRecord(parsed, ctx)));
    ctx.stats.linesProcessed++;
  });

  writeFileSync(
    outputPath,
    outLines.join("\n") + (trailingNewline ? "\n" : ""),
    "utf8",
  );

  console.log(`peek redact: ${inputPath} -> ${outputPath}`);
  console.log(
    `  lines processed:   ${ctx.stats.linesProcessed} (${claudeLines} claude-code-shaped, ${codexLines} codex-shaped)`,
  );
  console.log(`  strings scrambled: ${ctx.stats.stringsScrambled}`);
  console.log(`  ids remapped:      ${ctx.stats.idsRemapped}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
