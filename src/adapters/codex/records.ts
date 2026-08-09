// Codex CLI rollout JSONL record reader (T4.3).
//
// Line-by-line JSONL -> typed raw records. Every line is exactly
// {timestamp, type, payload} (docs/recon/codex.md § Line format,
// CONFIRMED at 0.134.0; main-branch `ordinal` field NOT yet shipping —
// tolerated if it ever appears since the whole line is parsed and only
// `timestamp`/`type`/`payload` are read out, so an extra top-level key is
// simply ignored, never rejected).
//
// Dispatch here is LINE-type only (`type`): session_meta, response_item,
// event_msg, turn_context, compacted, inter_agent_communication(_metadata),
// world_state. Unknown line types warn "unknown-record-type" and pass
// through (payload kept). `payload.type` sub-variants — response_item's
// message/reasoning/function_call/... or event_msg's
// user_message/token_count/... — are NOT dispatched or validated at this
// layer; that is T4.4 (response_item variants) / T4.5 (token_count,
// compacted) territory. An unrecognized payload-level variant therefore
// produces zero warnings here — see
// test/fixtures/codex/v0.134/unknown-variant.jsonl, whose "future_item"
// response_item and "agent_status_update" event_msg are both known LINE
// types and so parse warning-free at this layer.
//
// RULE (types.ts): adapters never throw on malformed/unknown records — warn
// and continue. Only an unreadable file rejects.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ParseWarning } from "../../model/types.js";

const KNOWN_LINE_TYPES: ReadonlySet<string> = new Set([
  "session_meta",
  "response_item",
  "event_msg",
  "turn_context",
  "compacted",
  "inter_agent_communication",
  "inter_agent_communication_metadata",
  "world_state",
]);

/**
 * One parsed JSONL line. `type` and `payload` are preserved verbatim
 * (including unknown future types/shapes); `line` is the 1-based line
 * number for diagnostics.
 */
export interface RawCodexRecord {
  timestamp?: Date;
  type: string;
  payload: unknown;
  line: number;
}

export interface ReadRecordsResult {
  records: RawCodexRecord[];
  warnings: ParseWarning[];
}

function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Reads a codex rollout JSONL file line by line. Every syntactically valid
 * JSON object line becomes a RawCodexRecord — known `.type` values
 * silently, unrecognized ones with an "unknown-record-type" warning
 * attached (record is still kept). Lines that fail to parse as JSON, or
 * that parse to a non-object, produce a "malformed-line" warning and are
 * skipped. Blank lines are skipped silently.
 *
 * Only a genuinely unreadable file (e.g. missing, permission denied)
 * rejects; malformed content never does.
 */
export async function readCodexRecords(
  filePath: string,
): Promise<ReadRecordsResult> {
  const warnings: ParseWarning[] = [];
  const records: RawCodexRecord[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      warnings.push({
        code: "malformed-line",
        message: `line ${lineNo}: invalid JSON`,
        line: lineNo,
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
        message: `line ${lineNo}: not a JSON object`,
        line: lineNo,
      });
      continue;
    }

    const record = parsed as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";

    if (!KNOWN_LINE_TYPES.has(type)) {
      warnings.push({
        code: "unknown-record-type",
        message: `line ${lineNo}: unrecognized record type ${
          type ? `"${type}"` : "(missing)"
        }`,
        line: lineNo,
        ...(type ? { recordType: type } : {}),
      });
    }

    const timestamp = parseTimestamp(record.timestamp);
    records.push({
      ...(timestamp !== undefined ? { timestamp } : {}),
      type,
      payload: record.payload,
      line: lineNo,
    });
  }

  return { records, warnings };
}

/**
 * Version-gate helper: `cli_version` off the file's (first) session_meta
 * record, for callers that need to branch on vintage before/without going
 * through meta.ts's full extraction.
 */
export function extractCliVersion(
  records: RawCodexRecord[],
): string | undefined {
  for (const record of records) {
    if (record.type !== "session_meta") continue;
    if (typeof record.payload !== "object" || record.payload === null) {
      continue;
    }
    const version = (record.payload as Record<string, unknown>).cli_version;
    if (typeof version === "string" && version.length > 0) return version;
  }
  return undefined;
}
