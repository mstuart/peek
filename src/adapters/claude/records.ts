// Claude Code JSONL record reader (T1.4).
//
// Line-by-line JSONL → typed raw records. Dispatch is limited to tagging each
// line with its `.type` and warning on anything not in the cataloged set from
// docs/recon/claude-code.md § Record types — never dropping content. parse.ts
// (T1.4) and later T1.5 work (spans/compaction/subagent linking) consume the
// record list this produces.
//
// RULE (types.ts): adapters never throw on malformed/unknown records — warn
// and continue. Only an unreadable file rejects.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ParseWarning } from "../../model/types.js";

/** Record types cataloged in docs/recon/claude-code.md § Record types. */
export type ClaudeRecordType =
  | "user"
  | "assistant"
  | "system"
  | "attachment"
  | "file-history-snapshot"
  | "file-history-delta"
  | "last-prompt"
  | "ai-title"
  | "mode"
  | "permission-mode"
  | "queue-operation"
  | "pr-link"
  | "progress"
  // Discovered in corpus sweep 2026-08-08 — pure metadata, no token/cost/
  // content fields (see docs/recon/claude-code.md § Record types).
  | "relocated"
  | "worktree-state"
  | "agent-name"
  | "agent-setting"
  | "frame-link"
  // Investigated 2026-08-08 (docs/recon/claude-code.md § fork-context-ref):
  // `contextLength` is a position counter over the PARENT conversation
  // (turns/messages since its last compaction), not a token or character
  // count — empirically 100-1000x smaller than any usage-derived context
  // total, and identical across sibling forks spawned at the same point
  // despite differing prompts. No token/cost field on this record; excluded
  // from all accounting (exact-totals invariant), known/inert.
  | "fork-context-ref";

const KNOWN_RECORD_TYPES: ReadonlySet<string> = new Set<ClaudeRecordType>([
  "user",
  "assistant",
  "system",
  "attachment",
  "file-history-snapshot",
  "file-history-delta",
  "last-prompt",
  "ai-title",
  "mode",
  "permission-mode",
  "queue-operation",
  "pr-link",
  "progress",
  "relocated",
  "worktree-state",
  "agent-name",
  "agent-setting",
  "frame-link",
  "fork-context-ref",
]);

/**
 * One parsed JSONL line. `type` is preserved verbatim (including unknown
 * future types); `raw` is the full parsed JSON object; `line` is the
 * 1-based line number for diagnostics and T1.5 position-dependent work
 * (e.g. compaction anchoring).
 */
export interface RawClaudeRecord {
  line: number;
  raw: Record<string, unknown>;
  type: string;
}

export interface ReadRecordsResult {
  records: RawClaudeRecord[];
  warnings: ParseWarning[];
}

/**
 * Reads a Claude Code session JSONL file line by line. Every syntactically
 * valid JSON object line becomes a RawClaudeRecord — known types silently,
 * unrecognized `.type` values with a "unknown-record-type" warning attached
 * (record is still kept; T1.5 may need its position). Lines that fail to
 * parse as JSON, or that parse to a non-object, produce a "malformed-line"
 * warning and are skipped. Blank lines are skipped silently.
 *
 * Only a genuinely unreadable file (e.g. missing, permission denied)
 * rejects; malformed content never does.
 */
export async function readClaudeRecords(
  filePath: string
): Promise<ReadRecordsResult> {
  const warnings: ParseWarning[] = [];
  const records: RawClaudeRecord[] = [];

  const rl = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: createReadStream(filePath, { encoding: "utf8" }),
  });

  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      warnings.push({
        code: "malformed-line",
        line: lineNo,
        message: `line ${lineNo}: invalid JSON`,
      });
      continue;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      warnings.push({
        code: "malformed-line",
        line: lineNo,
        message: `line ${lineNo}: not a JSON object`,
      });
      continue;
    }

    const record = parsed as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";

    if (!KNOWN_RECORD_TYPES.has(type)) {
      warnings.push({
        code: "unknown-record-type",
        line: lineNo,
        message: `line ${lineNo}: unrecognized record type ${
          type ? `"${type}"` : "(missing)"
        }`,
        ...(type ? { recordType: type } : {}),
      });
    }

    records.push({ line: lineNo, raw: record, type });
  }

  return { records, warnings };
}
