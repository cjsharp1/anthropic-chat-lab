/**
 * effort.ts — how hard the model works before answering.
 *
 * Step 61 added a switch for whether you can READ the reasoning.
 * This one controls how much of it there is.
 *
 * ---------------------------------------------------------------------------
 * What replaced budget_tokens
 * ---------------------------------------------------------------------------
 *
 * The old way to cap reasoning was a token budget:
 *
 *   thinking: { type: "enabled", budget_tokens: 4000 }
 *
 * That is a 400 on every model this app offers. The replacement is
 * `output_config.effort`, and the change is more than cosmetic. A
 * budget was a hard ceiling in tokens — a number you had to guess,
 * and the same number meant something different on every model and
 * every question. Effort is a dial: the model decides how many tokens
 * the level deserves for the question in front of it.
 *
 * ---------------------------------------------------------------------------
 * Where it lives in the request
 * ---------------------------------------------------------------------------
 *
 * Inside `output_config`, not at the top level:
 *
 *   output_config: { effort: "low" }
 *
 * The same object that carries `format` for structured outputs. Two
 * unrelated-looking features share it because both are about shaping
 * the output rather than the input.
 *
 * ---------------------------------------------------------------------------
 * The default is not the same everywhere
 * ---------------------------------------------------------------------------
 *
 * Opus 5.5 and Haiku 5.5 default to "medium". Sonnet 5.5 defaults to
 * "high". So "leave it alone" means different things depending on
 * which model a role is assigned, which is exactly the sort of
 * difference that makes a cost comparison lie if you do not know
 * about it. This app sends the level explicitly for that reason.
 */

/** The five levels the current models accept, cheapest first. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** What to show in the settings panel. */
export interface EffortOption {
  id: Effort;
  name: string;
  description: string;
}

export const EFFORT_OPTIONS: EffortOption[] = [
  {
    id: "low",
    name: "Low",
    description:
      "Few tokens spent thinking, short preamble, fewer tool calls. " +
      "The right setting for classification, routing, extraction — " +
      "anything where the answer is short and the question is not " +
      "hard. Also the right setting for a planner or a judge inside a " +
      "pattern, where nobody reads the output directly.",
  },
  {
    id: "medium",
    name: "Medium",
    description:
      "The default on Opus 5.5 and Haiku 5.5. A reasonable balance " +
      "for ordinary questions, and the level to step down to when " +
      "high is not buying anything measurable.",
  },
  {
    id: "high",
    name: "High",
    description:
      "The default on Sonnet 5.5. Usually the sweet spot for coding " +
      "and multi-step work: noticeably better than medium on hard " +
      "questions, without the cost of the two levels above it.",
  },
  {
    id: "xhigh",
    name: "Extra high",
    description:
      "More thorough again, and the best setting for most agentic " +
      "coding work on the larger models. Worth measuring rather than " +
      "assuming — on an easy question it spends more and returns the " +
      "same answer.",
  },
  {
    id: "max",
    name: "Max",
    description:
      "Everything the model has. Reach for it when being right " +
      "matters more than what it costs, and only after checking there " +
      "is headroom at the level below — if high and max give the same " +
      "answer, max is just a larger bill.",
  },
];

/** The level used when the browser sends nothing or something odd. */
export const DEFAULT_EFFORT: Effort = "medium";

const VALID = new Set<string>(EFFORT_OPTIONS.map((option) => option.id));

/** Narrows an unknown value from the browser to a level. */
export function parseEffort(value: unknown): Effort {
  return typeof value === "string" && VALID.has(value)
    ? (value as Effort)
    : DEFAULT_EFFORT;
}

/**
 * The `output_config` field to spread into a request.
 *
 * Takes any `output_config` the caller already has, so a request using
 * structured outputs keeps its `format` and gains an `effort`. Spread
 * naively, `...effortConfig(e)` after an `output_config: { format }`
 * would silently drop the format — a bug worth designing out rather
 * than remembering.
 */
export function withEffort<T extends object | undefined = undefined>(
  effort: Effort,
  existing?: T,
): { output_config: T & { effort: Effort } } {
  // Generic rather than Record<string, unknown>: messages.parse()
  // infers what it returns from the TYPE of output_config.format, and
  // widening that to `unknown` makes parsed_output come back as null.
  // The compiler caught exactly that when this was written loosely.
  return {
    output_config: { ...(existing as object), effort } as T & {
      effort: Effort;
    },
  };
}
