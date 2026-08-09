// Unified Session Model (USM) — canonical types.
//
// Transcribed verbatim (semantics preserved, prose-y shorthand resolved into strict
// TypeScript) from docs/DESIGN.md § "Unified Session Model (USM) — canonical types"
// (task T0.2). Adapters, the engine, and commands all consume these types; do not
// add fields here without updating that section of DESIGN.md first.

export type HarnessId = "claude-code" | "codex" | "pi";

export interface Adapter {
  harness: HarnessId;
  discover(roots?: string[]): Promise<SessionRef[]>;
  parse(ref: SessionRef): Promise<ParseResult>;
}

export interface SessionRef {
  harness: HarnessId;
  id: string;
  path: string;
  cwd?: string;
  sizeBytes: number;
  mtime: Date;
  kind: "main" | "subagent";
  parentId?: string;
}

export interface ParseResult {
  session: Session;
  warnings: ParseWarning[];
}

export interface ParseWarning {
  code: string;
  message: string;
  line?: number;
  recordType?: string;
}
// RULE: adapters NEVER throw on malformed/unknown records — warn and continue.
// Only unreadable files reject.

export type CompositionCategory =
  | "userText"
  | "assistantText"
  | "thinking"
  | "toolResults"
  | "toolCallArgs"
  | "instructionInjection" // CLAUDE.md/@-mentions on claude; AGENTS.md/user_instructions on codex
  | "systemPrompt" // codex only (logged verbatim); empty elsewhere
  | "toolSchemas" // codex only (dynamic_tools); empty elsewhere
  | "compactionSummaries"
  | "coordination";
// `thinking` RULE (audit R2-C2): forced to 0 for claude-code and pi — prior-turn thinking is
// stripped on resend (Anthropic docs) and current-turn thinking is output, not input. On codex,
// reasoning items ARE resent (Responses API): plaintext reasoning-summary spans count here;
// encrypted_content is unmeasurable and lands in residual. Verify empirically in Phase 4.

// PLAN gives Span.turnRole's literal union explicitly; Turn.role is drawn from the same
// domain, so it is factored into one alias here rather than duplicated.
export type TurnRole = "user" | "assistant" | "system";

export interface Span {
  // audit R2-F1: the shared type 4 workers touch
  category: CompositionCategory;
  charCount: number; // over the SINGLE canonical source (see accounting rule 5)
  text?: string; // omitted for large/offloaded content
  truncated: boolean; // source was capped/offloaded → estimate is a lower bound
  toolName?: string;
  mcpServer?: string; // set for toolResults/toolCallArgs spans
  turnRole: TurnRole;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  total: number;
  mode: "display" | "auto" | "calculate";
  priced: boolean; // priced=false → unknown model, token-only
}

export interface CompactionEvent {
  kind: "compaction";
  at: Date;
  turnIndex: number;
  tokensBeforeExact: number | null; // last REAL usage total before the marker — skip zero-usage and
  // isApiErrorMessage records when anchoring (audit R1-C2)
  tokensAfterExact: number | null; // first real usage total after (INCLUDES the summary — it's cached as fresh input)
  shrinkExact: number | null; // before − after. EXACT net context reduction; the headline number (audit R2-C1)
  discardedEst: number | null; // before − after + summaryTokensEst. Estimated original content discarded
  // (summary is NEW text inside `after`, so it adds back). Labeled estimate.
  summaryTokensEst: number;
  cost?: CostBreakdown | null;
  // codex-only (v2, Lane F3): window lineage from the `compacted` record's
  // window_number/window_id/previous_window_id/first_window_id fields (see
  // docs/recon/codex.md § "compacted records"). Undefined elsewhere/absent.
  lineage?: {
    windowNumber?: number;
    windowId?: string;
    previousWindowId?: string;
    firstWindowId?: string;
  };
}

export interface SubagentSpawn {
  kind: "subagentSpawn";
  at: Date;
  childRef: SessionRef;
  agentType?: string;
}

export interface ContextEdit {
  kind: "contextEdit";
  at: Date;
  raw: unknown; // applied_edits passthrough; populated shape unknown
}

export interface ModeChange {
  kind: "modeChange";
  at: Date;
  field: string;
  from?: string;
  to: string;
}

export interface ErrorEvent {
  kind: "error";
  at: Date;
  message: string;
  raw?: unknown;
}

export type SessionEvent =
  | CompactionEvent
  | SubagentSpawn
  | ContextEdit
  | ModeChange
  | ErrorEvent;

export interface NormalizedUsage {
  // ADDITIVE convention (Anthropic-style)
  inputUncached: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  reasoningOutput?: number;
  raw: unknown;
}
// Codex conversion (MEASURED 2026-08-08): inputUncached = input_tokens − cached_input_tokens;
// cache_write_input_tokens absent → 0 (absent even on codex-cli 0.134.0).

export interface Session {
  harness: HarnessId;
  harnessVersion: string;
  id: string;
  cwd: string;
  gitBranch?: string;
  startedAt: Date;
  endedAt: Date;
  configSnapshot: {
    systemPrompt?: string;
    projectInstructions?: string;
    toolSchemas?: string;
    model: string;
    modelChanges: ModeChange[];
  };
  turns: Turn[];
  events: SessionEvent[];
  children: SessionRef[];
  warnings: ParseWarning[];
}

export interface Turn {
  role: TurnRole;
  model: string;
  timestamp: Date;
  contentSpans: Span[];
  usage: NormalizedUsage;
  contextTotal: number;
  composition: Composition;
  cacheMissReason?: unknown;
  cost: CostBreakdown;
}

export interface Composition {
  categories: Record<CompositionCategory, number>;
  residual: number;
  residualShare: number;
  truncated: boolean;
}

// Invariants (property-tested, see test/unit/model.test.ts):
//   contextTotal = inputUncached + cacheRead + cacheWrite5m + cacheWrite1h (exact, never tokenized)
//   Σ categories + residual = contextTotal (negative residual reported as measured
//     estimation error, never clamped)
//   dedup precedes all aggregation
