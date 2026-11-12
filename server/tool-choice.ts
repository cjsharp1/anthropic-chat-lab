/**
 * tool-choice.ts — the options for the `tool_choice` request parameter.
 *
 * `tool_choice` tells the API how free Claude is to decide about tools:
 *
 *   auto   Claude decides. The default, and almost always what you want.
 *   none   Tools are described but may not be used. Claude answers from
 *          its own knowledge even when a tool would be better.
 *   any    Claude MUST call some tool, its choice which.
 *   tool   Claude MUST call one specific named tool.
 *
 * ---------------------------------------------------------------------------
 * Forced tool use is gone on current models
 * ---------------------------------------------------------------------------
 *
 * `any` and `tool` return a 400 on Claude Opus 5.5, Sonnet 5.5 and Fable
 * 5.1:
 *
 *   tool_choice: type "tool" and "any" are not supported for this model.
 *
 * They are still offered here, and they still fail. That is deliberate.
 * Plenty of tutorials and older code use them, and a learner who meets
 * the 400 in the wild should recognise it rather than assume their
 * request is malformed.
 *
 * What to do instead, in rough order of preference:
 *
 *   - Use `auto` and name the tool in the prompt: "Use the calculator
 *     tool to work this out." The model follows instructions.
 *   - Set `strict: true` on the tool, so arguments are schema-valid when
 *     it does call.
 *   - If the forced call only existed to get structured JSON back, use
 *     structured outputs (output_config.format) instead — that is what
 *     it is for.
 *
 * ---------------------------------------------------------------------------
 * disable_parallel_tool_use
 * ---------------------------------------------------------------------------
 *
 * A separate flag that pairs with `auto`. With it set, Claude makes at
 * most one tool call per turn instead of several at once. Useful when
 * tools must run in order, or when each is expensive — and useful here
 * as a way to see the difference, since the parallel case is what step
 * 42 is about.
 */

/** One selectable tool_choice setting. */
export interface ToolChoiceOption {
  /** Stable identifier sent by the browser. */
  id: string;
  /** Short label for the dropdown. */
  name: string;
  /** One line explaining when to pick this. */
  description: string;
  /** What this sends on the wire, and what happens as a result. */
  effect: string;
  /** Whether this is expected to be rejected by current models. */
  rejected?: boolean;
}

export const TOOL_CHOICE_OPTIONS: ToolChoiceOption[] = [
  {
    id: "auto",
    name: "auto",
    description:
      "Claude decides for itself whether any tool applies, and may call " +
      "several at once. The default, and the right answer almost always.",
    effect:
      'Sends tool_choice: {type: "auto"}. The model may answer directly, ' +
      "call one tool, or call several in parallel. Ask it 7 times 6 and " +
      "it will answer without a tool; ask for a six-digit multiplication " +
      "and it will reach for the calculator. That judgement is the point.",
  },
  {
    id: "auto-single",
    name: "auto, one at a time",
    description:
      "As auto, but at most one tool per turn. Use when tools must run " +
      "in order, or when each is expensive enough to want them staged.",
    effect:
      'Sends {type: "auto", disable_parallel_tool_use: true}. A question ' +
      "needing two tools then takes three requests instead of two, " +
      "because each tool gets its own round trip. Watch the request " +
      "count in the log: the same question costs more this way.",
  },
  {
    id: "none",
    name: "none",
    description:
      "Tools are still described to Claude, but it may not call them. " +
      "Shows what the model knows unaided.",
    effect:
      'Sends tool_choice: {type: "none"}. The tool definitions are still ' +
      "sent and still cost input tokens — this withholds permission, it " +
      "does not hide them. Worth trying on a hard sum: Claude often " +
      "writes the arguments it wanted to send as plain text, which is a " +
      "vivid demonstration that it knew exactly which tool it needed.",
  },
  {
    id: "any",
    name: "any (removed)",
    description:
      "Would force Claude to call some tool, its choice which. Removed " +
      "from current models — select it to see the error it now returns.",
    effect:
      'Sends tool_choice: {type: "any"}, which returns HTTP 400 on Opus ' +
      "5.5, Sonnet 5.5 and Fable 5.1: 'tool_choice: type \"tool\" and " +
      "\"any\" are not supported for this model.' Plenty of older " +
      "tutorials still use it. Instead: keep auto and name the tool in " +
      "the prompt, or use structured outputs if the forced call only " +
      "existed to get JSON back.",
    rejected: true,
  },
  {
    id: "tool",
    name: "tool: calculator (removed)",
    description:
      "Would force one specific named tool. Removed from current models " +
      "for the same reason as any.",
    effect:
      'Sends tool_choice: {type: "tool", name: "calculator"} and returns ' +
      "the same HTTP 400. If you need a guarantee about the arguments " +
      "rather than the call, strict: true on the tool definition is the " +
      "mechanism that survived — it is already set on every tool here.",
    rejected: true,
  },
];

export const DEFAULT_TOOL_CHOICE_ID = "auto";

/**
 * The shape to put on the request, for a given option id.
 *
 * Returns undefined when no tool_choice should be sent at all, which is
 * the correct thing to do when there are no tools: sending
 * `{type: "auto"}` with no tools is a validation error.
 *
 * The `any` and `tool` branches return a value the API will reject. That
 * is the point — the rejection is the lesson.
 */
export function buildToolChoice(
  id: unknown,
  hasTools: boolean,
):
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "none" }
  | { type: "any" }
  | { type: "tool"; name: string }
  | undefined {
  if (!hasTools) return undefined;

  switch (id) {
    case "auto-single":
      return { type: "auto", disable_parallel_tool_use: true };
    case "none":
      return { type: "none" };
    case "any":
      return { type: "any" };
    case "tool":
      return { type: "tool", name: "calculator" };
    case "auto":
    default:
      return { type: "auto" };
  }
}

/** Looks up an option for logging, falling back to the default. */
export function getToolChoiceOption(id: unknown): ToolChoiceOption {
  return (
    TOOL_CHOICE_OPTIONS.find((o) => o.id === id) ??
    TOOL_CHOICE_OPTIONS.find((o) => o.id === DEFAULT_TOOL_CHOICE_ID)!
  );
}
