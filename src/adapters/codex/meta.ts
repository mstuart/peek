// Codex session_meta + turn_context -> Session field extraction (T4.3).
//
// Pure extraction helpers (no I/O); parse.ts wires these into the Session
// skeleton that T4.4 (response_item variants -> turns) and T4.5
// (token_count/compacted -> usage + CompactionEvent) extend. See
// docs/recon/codex.md § session_meta / turn_context for the source shapes.

function prop(raw: unknown, key: string): unknown {
  if (typeof raw !== "object" || raw === null) return undefined;
  return (raw as Record<string, unknown>)[key];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Minimal local ToolSchema shape for codex's `dynamic_tools`. types.ts
 * declares Session.configSnapshot.toolSchemas loosely as a plain `string`
 * (the serialized form — see extractSessionMeta below); this is the
 * pre-serialization shape used while flattening. A namespace spec's nested
 * tools are flattened with `serverName` set to the namespace's own `name`
 * so later attribution (T4.4+ tool-call spans) can group by MCP server; a
 * plain Function spec has no serverName.
 */
export interface CodexToolSchema {
  name: string;
  description?: string;
  inputSchema?: unknown;
  deferLoading?: boolean;
  serverName?: string;
}

function buildToolSchema(
  node: unknown,
  serverName?: string,
): CodexToolSchema | undefined {
  const name = str(prop(node, "name"));
  if (!name) return undefined;

  const schema: CodexToolSchema = { name };
  const description = str(prop(node, "description"));
  if (description !== undefined) schema.description = description;
  const inputSchema = prop(node, "input_schema");
  if (inputSchema !== undefined) schema.inputSchema = inputSchema;
  const deferLoading = prop(node, "defer_loading");
  if (typeof deferLoading === "boolean") schema.deferLoading = deferLoading;
  if (serverName !== undefined) schema.serverName = serverName;
  return schema;
}

/**
 * `dynamic_tools` entries are either a plain Function spec
 * `{name, description, input_schema, defer_loading}` or a namespace spec
 * `{name, description, tools: [...]}` whose nested tools share the Function
 * shape (recon-confirmed the namespace container's key is `name`, same as
 * the plain spec — NOT `namespace`) — distinguished here by the presence of
 * a `tools` array, since both shapes key off `name`.
 */
export function extractToolSchemas(dynamicTools: unknown): CodexToolSchema[] {
  if (!Array.isArray(dynamicTools)) return [];
  const flattened: CodexToolSchema[] = [];

  for (const entry of dynamicTools) {
    const tools = prop(entry, "tools");
    if (Array.isArray(tools)) {
      const serverName = str(prop(entry, "name"));
      for (const tool of tools) {
        const schema = buildToolSchema(tool, serverName);
        if (schema) flattened.push(schema);
      }
      continue;
    }

    const schema = buildToolSchema(entry);
    if (schema) flattened.push(schema);
  }

  return flattened;
}

/**
 * git ships as a sub-object `{commit_hash, branch, repository_url}` on
 * payload per the corrected recon (absent entirely when cwd isn't a git
 * repo). The v0.134 synthetic fixtures (full-turn/compaction/unknown-variant)
 * predate that correction and flatten the three fields directly onto
 * payload instead; v0.88/basic-session.jsonl already uses the sub-object.
 * Both shapes exist in the current fixture set, so this checks the
 * sub-object first and falls back to the flattened field.
 */
function extractGitBranch(payload: unknown): string | undefined {
  const nested = str(prop(prop(payload, "git"), "branch"));
  if (nested !== undefined) return nested;
  return str(prop(payload, "branch"));
}

export interface SessionMetaInfo {
  harnessVersion: string;
  cwd: string;
  startedAt: Date;
  gitBranch?: string;
  systemPrompt?: string;
  /** Serialized CodexToolSchema[] — Session.configSnapshot.toolSchemas is a string. */
  toolSchemas?: string;
  model?: string;
}

/**
 * session_meta -> Session fields. `model` checks for a direct `model` key
 * on payload defensively: no local sample carries one today (recon: a
 * session's model lives in state_5.sqlite's `threads` table index, not the
 * JSONL, at least as of 0.134.0) but this stays forward-tolerant in case a
 * future cli_version starts mirroring it inline; absent, the Session's
 * model falls back to "unknown" until a turn_context (or, in T4.5, a turn)
 * supplies one.
 */
export function extractSessionMeta(payload: unknown): SessionMetaInfo {
  const harnessVersion = str(prop(payload, "cli_version")) ?? "";
  const cwd = str(prop(payload, "cwd")) ?? "";
  const startedAt = parseTimestamp(prop(payload, "timestamp")) ?? new Date(0);
  const gitBranch = extractGitBranch(payload);
  const systemPrompt = str(prop(prop(payload, "base_instructions"), "text"));
  const toolSchemas = extractToolSchemas(prop(payload, "dynamic_tools"));
  const model = str(prop(payload, "model"));

  const info: SessionMetaInfo = { harnessVersion, cwd, startedAt };
  if (gitBranch !== undefined) info.gitBranch = gitBranch;
  if (systemPrompt !== undefined) info.systemPrompt = systemPrompt;
  if (toolSchemas.length > 0) info.toolSchemas = JSON.stringify(toolSchemas);
  if (model !== undefined) info.model = model;
  return info;
}

export interface TurnContextInfo {
  model?: string;
  effort?: string;
  projectInstructions?: string;
  /** turn_context.truncation_policy.limit (bytes) — for T4.4's span
   * `truncated` flag when it builds the projectInstructions Span. */
  truncationLimitBytes?: number;
}

/**
 * turn_context field set drifted between vintages (recon: 0.88-vintage
 * shape carries effort/truncation_policy/user_instructions; the real
 * 0.134.0 capture has none of those and instead carries
 * current_date/timezone/permission_profile/personality/collaboration_mode/
 * realtime_active/turn_id) — every field read here is optional at every
 * vintage per the recon's explicit note, so absence of any of them is not
 * a warning-worthy condition.
 */
export function extractTurnContext(payload: unknown): TurnContextInfo {
  const info: TurnContextInfo = {};

  const model = str(prop(payload, "model"));
  if (model !== undefined) info.model = model;

  const effort = str(prop(payload, "effort"));
  if (effort !== undefined) info.effort = effort;

  const userInstructions = str(prop(payload, "user_instructions"));
  if (userInstructions !== undefined) {
    info.projectInstructions = userInstructions;
  }

  const limit = prop(prop(payload, "truncation_policy"), "limit");
  if (typeof limit === "number") info.truncationLimitBytes = limit;

  return info;
}
