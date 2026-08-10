// Unified Session Model (USM) — canonical types.
//
// Transcribed verbatim (semantics preserved, prose-y shorthand resolved into strict
// TypeScript) from docs/DESIGN.md § "Unified Session Model (USM) — canonical types"
// (task T0.2). Adapters, the engine, and commands all consume these types; do not
// add fields here without updating that section of DESIGN.md first.

export type HarnessId = "claude-code" | "codex" | "pi";

export interface Adapter {
  discover: (roots?: string[]) => Promise<SessionRef[]>;
  harness: HarnessId;
  parse: (ref: SessionRef) => Promise<ParseResult>;
}

export interface SessionRef {
  cwd?: string;
  harness: HarnessId;
  id: string;
  kind: "main" | "subagent";
  mtime: Date;
  parentId?: string;
  path: string;
  sizeBytes: number;
}

export interface ParseResult {
  session: Session;
  warnings: ParseWarning[];
}

export interface ParseWarning {
  code: string;
  line?: number;
  message: string;
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
  mcpServer?: string; // set for toolResults/toolCallArgs spans
  text?: string; // omitted for large/offloaded content
  toolName?: string;
  truncated: boolean; // source was capped/offloaded → estimate is a lower bound
  turnRole: TurnRole;
}

export interface CostBreakdown {
  cacheRead: number;
  cacheWrite1h: number;
  cacheWrite5m: number;
  input: number;
  mode: "display" | "auto" | "calculate";
  output: number;
  priced: boolean; // priced=false → unknown model, token-only
  total: number;
}

export interface CompactionEvent {
  at: Date;
  cost?: CostBreakdown | null;
  discardedEst: number | null; // before − after + summaryTokensEst. Estimated original content discarded
  kind: "compaction";
  // codex-only (v2, Lane F3): window lineage from the `compacted` record's
  // window_number/window_id/previous_window_id/first_window_id fields (see
  // docs/recon/codex.md § "compacted records"). Undefined elsewhere/absent.
  lineage?: {
    windowNumber?: number;
    windowId?: string;
    previousWindowId?: string;
    firstWindowId?: string;
  };
  shrinkExact: number | null; // before − after. EXACT net context reduction; the headline number (audit R2-C1)
  // (summary is NEW text inside `after`, so it adds back). Labeled estimate.
  summaryTokensEst: number;
  // isApiErrorMessage records when anchoring (audit R1-C2)
  tokensAfterExact: number | null; // first real usage total after (INCLUDES the summary — it's cached as fresh input)
  tokensBeforeExact: number | null; // last REAL usage total before the marker — skip zero-usage and
  turnIndex: number;
}

export interface SubagentSpawn {
  agentType?: string;
  at: Date;
  childRef: SessionRef;
  kind: "subagentSpawn";
}

export interface ContextEdit {
  at: Date;
  kind: "contextEdit";
  raw: unknown; // applied_edits passthrough; populated shape unknown
}

export interface ModeChange {
  at: Date;
  field: string;
  from?: string;
  kind: "modeChange";
  to: string;
}

export interface ErrorEvent {
  at: Date;
  kind: "error";
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
  cacheRead: number;
  cacheWrite1h: number;
  cacheWrite5m: number;
  // ADDITIVE convention (Anthropic-style)
  inputUncached: number;
  output: number;
  raw: unknown;
  reasoningOutput?: number;
}
// Codex conversion (MEASURED 2026-08-08): inputUncached = input_tokens − cached_input_tokens;
// cache_write_input_tokens absent → 0 (absent even on codex-cli 0.134.0).

export interface Session {
  children: SessionRef[];
  configSnapshot: {
    systemPrompt?: string;
    projectInstructions?: string;
    toolSchemas?: string;
    model: string;
    modelChanges: ModeChange[];
  };
  cwd: string;
  endedAt: Date;
  events: SessionEvent[];
  gitBranch?: string;
  harness: HarnessId;
  harnessVersion: string;
  id: string;
  startedAt: Date;
  turns: Turn[];
  warnings: ParseWarning[];
}

export interface Turn {
  cacheMissReason?: unknown;
  composition: Composition;
  contentSpans: Span[];
  contextTotal: number;
  cost: CostBreakdown;
  model: string;
  role: TurnRole;
  timestamp: Date;
  usage: NormalizedUsage;
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
