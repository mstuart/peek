// pi System A entry-tree reconstruction, and System A/B detection.
// See docs/recon/pi.md § "System A" / "System B" for the schema this parses
// against. RULE (model/types.ts ParseResult): adapters never throw on
// malformed/unknown content — warn and continue; only an unreadable file
// (e.g. no parseable header line) yields a null tree.

import type { ParseWarning } from "../../model/types.js";

const KNOWN_ENTRY_TYPES = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);

export interface PiSessionHeader {
  cwd: string;
  id: string;
  parentSession?: string;
  timestamp: string;
  type: "session";
  version?: number;
}

export interface PiEntry {
  /** Remaining entry-specific fields (message, summary, usage, ...), left
   * unparsed here — that's T6.3's job. */
  data: Record<string, unknown>;
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
}

export interface PiEntryTree {
  /** Insertion-ordered by file appearance (JS Map preserves insertion order),
   * which is what activeLeaf()/pathToRoot() rely on. */
  entries: Map<string, PiEntry>;
  header: PiSessionHeader;
}

export type PiTreeParseResult =
  | { systemB: true; warnings: ParseWarning[] }
  | { systemB: false; tree: PiEntryTree | null; warnings: ParseWarning[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse a pi session file's lines into an entry tree, or detect+flag System
 * B (harness v4) sessions for the caller to skip. Never throws: malformed
 * lines are reported as warnings and skipped. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Entry-type dispatch is intentionally explicit and tolerant.
export function parsePiEntryTree(lines: string[]): PiTreeParseResult {
  const warnings: ParseWarning[] = [];

  const [headerLine] = lines;
  if (headerLine === undefined || headerLine.trim() === "") {
    warnings.push({
      code: "pi-empty-file",
      line: 1,
      message: "pi session file has no header line",
    });
    return { systemB: false, tree: null, warnings };
  }

  let headerRaw: unknown;
  try {
    headerRaw = JSON.parse(headerLine);
  } catch {
    warnings.push({
      code: "pi-malformed-header",
      line: 1,
      message: "pi session header line is not valid JSON",
    });
    return { systemB: false, tree: null, warnings };
  }

  if (!isRecord(headerRaw)) {
    warnings.push({
      code: "pi-malformed-header",
      line: 1,
      message: "pi session header line is not a JSON object",
    });
    return { systemB: false, tree: null, warnings };
  }

  // System B detection (docs/recon/pi.md § System B): first line has a
  // `kind` field; System A's header is `type:"session"`. Signals the caller
  // (parse.ts) to route to systemB.ts's mutation-log parser instead of the
  // tree below — no warning here: System B is a supported, parsed format as
  // of Lane D (docs/DESIGN.md § Other v2 subsystems); systemB.ts emits its own warnings.
  if ("kind" in headerRaw && headerRaw.type !== "session") {
    return { systemB: true, warnings };
  }

  if (
    headerRaw.type !== "session" ||
    typeof headerRaw.id !== "string" ||
    typeof headerRaw.timestamp !== "string" ||
    typeof headerRaw.cwd !== "string"
  ) {
    warnings.push({
      code: "pi-malformed-header",
      line: 1,
      message: "pi session header is missing required fields",
    });
    return { systemB: false, tree: null, warnings };
  }

  const header: PiSessionHeader = {
    cwd: headerRaw.cwd,
    id: headerRaw.id,
    timestamp: headerRaw.timestamp,
    type: "session",
  };
  if (typeof headerRaw.version === "number") {
    header.version = headerRaw.version;
  }
  if (typeof headerRaw.parentSession === "string") {
    header.parentSession = headerRaw.parentSession;
  }

  const entries = new Map<string, PiEntry>();

  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNo = i + 1;
    if (raw === undefined || raw.trim() === "") {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnings.push({
        code: "pi-malformed-entry",
        line: lineNo,
        message: "pi entry line is not valid JSON",
      });
      continue;
    }

    if (
      !isRecord(parsed) ||
      typeof parsed.id !== "string" ||
      typeof parsed.type !== "string" ||
      typeof parsed.timestamp !== "string" ||
      !("parentId" in parsed) ||
      (parsed.parentId !== null && typeof parsed.parentId !== "string")
    ) {
      warnings.push({
        code: "pi-malformed-entry",
        line: lineNo,
        message: "pi entry line is missing required fields",
        ...(isRecord(parsed) && typeof parsed.type === "string"
          ? { recordType: parsed.type }
          : {}),
      });
      continue;
    }

    if (!KNOWN_ENTRY_TYPES.has(parsed.type)) {
      warnings.push({
        code: "pi-unknown-entry-type",
        line: lineNo,
        message: `unknown pi entry type: ${parsed.type}`,
        recordType: parsed.type,
      });
      // Still linked into the tree below — an unrecognized type doesn't
      // invalidate its place in the parent-pointer chain (forward-compat).
    }

    const { type, id, parentId, timestamp, ...data } = parsed;
    entries.set(id, {
      data,
      id,
      parentId: parentId as string | null,
      timestamp,
      type,
    });
  }

  return { systemB: false, tree: { entries, header }, warnings };
}

/** Active leaf = most recently appended entry (file order), per
 * docs/recon/pi.md: "recomputed, not stored". */
export function activeLeaf(entries: Map<string, PiEntry>): string | undefined {
  let last: string | undefined;
  for (const id of entries.keys()) {
    last = id;
  }
  return last;
}

/** Walk parentId pointers from leafId up to the root, returning ids ordered
 * root -> leaf. Entries missing from the map (or a cycle) truncate the walk
 * rather than throwing. */
export function pathToRoot(
  entries: Map<string, PiEntry>,
  leafId: string
): string[] {
  const path: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = leafId;

  while (currentId !== null) {
    if (visited.has(currentId)) {
      break;
    }
    visited.add(currentId);
    const entry = entries.get(currentId);
    if (!entry) {
      break;
    }
    path.push(entry.id);
    currentId = entry.parentId;
  }

  return path.reverse();
}
