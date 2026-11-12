/**
 * thinking.ts — extended thinking, and what it costs to see it.
 *
 * Claude can work through a problem before answering. On the current
 * models that is not something you switch on: it is already happening
 * on every request in this app. What this module controls is whether
 * you get to READ it.
 *
 * ---------------------------------------------------------------------------
 * The part that surprises people
 * ---------------------------------------------------------------------------
 *
 * `display` defaults to "omitted" on Opus 5.5, Sonnet 5.5 and Haiku
 * 5.5. The thinking blocks still arrive, and you are still billed for
 * every thinking token, but their text is empty. So the default is not
 * "no thinking" — it is "thinking you paid for and cannot see".
 *
 * Asking for `display: "summarized"` does not make the model think
 * more, think differently, or cost more. It asks the API to return a
 * readable summary of reasoning that already happened. The raw chain
 * of thought is never returned on any model, under any setting.
 *
 * That is the whole lesson of this toggle, and it is worth watching in
 * the activity log: turn it on, ask the same question twice, and
 * compare the thinking tokens in `usage`. They do not move.
 *
 * ---------------------------------------------------------------------------
 * What you cannot do here
 * ---------------------------------------------------------------------------
 *
 * Two shapes that older tutorials still show will fail outright on
 * every model this app offers:
 *
 *   thinking: { type: "enabled", budget_tokens: 4000 }   // 400
 *   thinking: { type: "disabled" }                       // 400 on Opus 5.5
 *
 * `budget_tokens` was the old way to cap reasoning and is gone.
 * Depth is controlled by `output_config.effort` instead — which is
 * step 62, the next one along.
 */

/**
 * Whether the reply should carry a readable summary of the reasoning.
 *
 * Two values rather than a boolean, because the names match what goes
 * on the wire. Someone reading this code and then reading the API
 * documentation should not have to translate.
 */
export type ThinkingDisplay = "omitted" | "summarized";

/** What to show in the settings panel. */
export interface ThinkingOption {
  id: ThinkingDisplay;
  name: string;
  description: string;
}

export const THINKING_OPTIONS: ThinkingOption[] = [
  {
    id: "omitted",
    name: "Hidden (default)",
    description:
      "The API default. Claude still reasons and you are still billed " +
      "for the thinking tokens — the blocks just come back empty. " +
      "This is what you get by not sending a display setting at all.",
  },
  {
    id: "summarized",
    name: "Show summary",
    description:
      "Returns a readable summary of the reasoning, above the answer. " +
      "Costs nothing extra: the thinking already happened. The raw " +
      "chain of thought is never returned on any model — a summary is " +
      "as close as the API gets.",
  },
];

/** Narrows an unknown value from the browser to a display setting. */
export function parseThinkingDisplay(value: unknown): ThinkingDisplay {
  return value === "summarized" ? "summarized" : "omitted";
}

/**
 * The `thinking` field to spread into a request.
 *
 * Always returns the field, never nothing. Omitting `thinking`
 * entirely gives adaptive thinking with display "omitted" on these
 * models, so sending it explicitly changes no behaviour — but it does
 * put the parameter in the request body, where the activity log will
 * show it. A setting you cannot see in the logged request is a setting
 * a learner has to take on trust.
 *
 * `type: "adaptive"` lets Claude decide how much to think per request.
 * It is the only on-mode these models accept.
 */
export function thinkingConfig(display: ThinkingDisplay): {
  thinking: { type: "adaptive"; display: ThinkingDisplay };
} {
  return { thinking: { type: "adaptive", display } };
}
