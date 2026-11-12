/**
 * types.ts — the shapes the browser half defines for itself.
 *
 * Distinct from shared/types.ts, which holds the wire contract the
 * server and the browser must agree on. These are the browser's own:
 * what each settings endpoint returns, and what the UI remembers
 * between turns.
 *
 * They live here rather than beside the code that uses them because
 * several are used in more than one module — a RunSnapshot is built
 * when a message is sent and read when a comparison is offered.
 */

/**
 * One turn in the conversation, in the shape the Messages API expects.
 *
 * Deliberately the same shape the API uses, so the array can be sent
 * straight through without translation.
 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Everything needed to run one turn again.
 *
 * Captured at the moment of sending, because the conversation array is
 * mutated as the reply arrives — by the time anyone clicks "re-run" it
 * already contains the answer, and replaying it would ask Claude to
 * respond to its own reply.
 */
export interface RunSnapshot {
  messages: ChatMessage[];
  promptId: string;
  tools: string[];
  toolChoice: string;
  pattern: string;
  models: Record<string, string>;
  /** How much of the request may be cached. See server/caching.ts. */
  cacheMode: string;
  /** Whether reasoning comes back readable. See server/thinking.ts. */
  thinkingDisplay: string;
  /** How hard the model works before answering. See server/effort.ts. */
  effort: string;
}

/** What one run cost and produced, for the comparison table. */
export interface RunOutcome {
  models: Record<string, string>;
  /** The roles the pattern actually used, so both rows list the same set. */
  roles: string[];
  /** Which role was varied, on the B run. Null on the baseline. */
  variedRole: string | null;
  cost: number;
  requests: number;
  elapsedMs: number;
  text: string;
}

/** One tool as returned by GET /api/tools. */
export interface ToolInfo {
  name: string;
  description: string;
  executedBy: "client" | "server";
  examplePrompt: string;
  exampleWatch: string;
}

/** One pattern as returned by GET /api/patterns. */
export interface PatternOption {
  id: string;
  name: string;
  description: string;
  typicalRequests: string;
  usesRoles: string[];
  whenToUse: string;
  measuredCost: string;
  examples: Array<{
    prompt: string;
    watch: string;
    kind: "good-fit" | "poor-fit";
  }>;
}

/** One prompt as returned by GET /api/prompts. */
export interface PromptOption {
  id: string;
  name: string;
  description: string;
  effect: string;
  text: string | null;
  characters: number;
}

/** One model the server offers. */
export interface ModelOption {
  id: string;
  name: string;
  inputPrice: number;
  outputPrice: number;
  note: string;
}

/** What a role is for. */
export interface RoleInfo {
  name: string;
  used_by: string;
  guidance: string;
  defaultModel: string;
}

export interface CacheModeOption {
  id: string;
  name: string;
  description: string;
  effect: string;
}

/** One level as returned by GET /api/effort-levels. */
export interface EffortLevel {
  id: string;
  name: string;
  description: string;
}

/** One display option as returned by GET /api/thinking-options. */
export interface ThinkingOption {
  id: string;
  name: string;
  description: string;
}

/** One option as returned by GET /api/tool-choices. */
export interface ToolChoiceOption {
  id: string;
  name: string;
  description: string;
  effect: string;
  rejected?: boolean;
}

/**
 * The parsed object, once an extraction finishes.
 *
 * Arrives as its own stream event rather than as text, because the
 * whole point of structured outputs is that the result feeds code
 * instead of a reader.
 */
export interface ExtractedEvent {
  data: Record<string, unknown> | null;
  raw: string;
  model: string;
  cost: number;
  elapsedMs: number;
}

/**
 * Five questions, each chosen to make one thing visible.
 *
 * Not five questions that happen to work — five that each demonstrate
 * a different mechanism, with a note saying what to watch for. A
 * class clicking these left to right meets a tool call, a multi-step
 * tool loop, prompt caching, structured output and the effort dial,
 * in that order.
 *
 * Each carries the settings it needs. A question written for the tool
 * loop teaches nothing with the pattern left on Single call — it
 * produces the "Claude asked for a tool but this pattern does not run
 * them" warning instead, which is a lesson, but not this one.
 */
export interface Preset {
  label: string;
  question: string;
  /** What this is for, shown on hover and logged on click. */
  watchFor: string;
  /** Settings this question needs to demonstrate anything. */
  requires?: {
    pattern?: string;
    tools?: boolean;
    effort?: string;
    cacheMode?: string;
  };
}
