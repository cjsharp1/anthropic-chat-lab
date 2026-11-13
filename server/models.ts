/**
 * models.ts — which model does which job.
 *
 * Every call this app makes falls into one of three roles, and the
 * right model for each is a different question. Organising the choice
 * by role rather than by pattern is deliberate: "the orchestrator uses
 * Haiku" is not a useful thing to learn, because the orchestrator uses
 * three models for three different jobs. "A call that produces a
 * structured decision rather than prose rarely needs the expensive
 * model" transfers to anything you build next.
 *
 * ---------------------------------------------------------------------------
 * The three roles
 * ---------------------------------------------------------------------------
 *
 *   deciding   Classifiers, planners, extraction. Short structured
 *              output, no reasoning, nobody reads it. This is reading
 *              comprehension, and the cheap model does it.
 *
 *   producing  Answers, workers, branches, drafts. What the user
 *              actually reads. Quality is visible here, and this is
 *              where the money should go.
 *
 *   judging    Evaluator verdicts. An unusual case: the output is
 *              short and structured like a deciding call, but the job
 *              is catching mistakes the producer made — which needs at
 *              least as much capability as the producer had. Worth
 *              having as its own role precisely because the obvious
 *              answer is wrong.
 *
 * ---------------------------------------------------------------------------
 * Why this is measurable rather than a matter of taste
 * ---------------------------------------------------------------------------
 *
 * The orchestrator's planner was on Opus until it was tested against
 * Haiku on three questions. Haiku produced plans as good or better, at
 * about a fiftieth of the cost and half the latency — on one question
 * the subtask titles were identical. That is the kind of finding the
 * A/B control in the UI exists to let you reproduce rather than take
 * on trust.
 */

/** A job a call can be doing. */
export type ModelRole = "deciding" | "producing" | "judging";

/** One model the UI can offer. */
export interface ModelOption {
  id: string;
  name: string;
  /**
   * Per-million-token prices, for the cost estimate in the UI.
   *
   * The same rates appear in `PRICING` in server/usage.ts, which is
   * what the activity log bills against, and as two literals in
   * scripts/hello-claude.ts. All three must change together; nothing
   * checks that they agree.
   */
  inputPrice: number;
  outputPrice: number;
  /** One line on what this model is for. */
  note: string;
}

/**
 * The models on offer.
 *
 * Three is enough to show the shape of the trade without turning the
 * dropdown into a catalogue.
 */
export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: "claude-haiku-5-5",
    name: "Haiku 5.5",
    inputPrice: 0.1,
    outputPrice: 0.5,
    note:
      "Fastest and cheapest. Good at reading comprehension, " +
      "classification and extraction; weaker at multi-step reasoning " +
      "and long-form writing.",
  },
  {
    id: "claude-sonnet-5-5",
    name: "Sonnet 5.5",
    inputPrice: 2,
    outputPrice: 10,
    note:
      "Twenty times Haiku's price, half of Opus's. Often the right " +
      "answer for producing when the task is well specified.",
  },
  {
    id: "claude-opus-5-5",
    name: "Opus 5.5",
    inputPrice: 4,
    outputPrice: 20,
    note:
      "The most capable, and the most expensive. Worth it for work " +
      "where judgement shows in the output.",
  },
];

/** What each role is for, shown under its dropdown. */
export const ROLE_INFO: Record<
  ModelRole,
  { name: string; used_by: string; guidance: string; defaultModel: string }
> = {
  deciding: {
    name: "Deciding",
    used_by:
      "The routing classifier, the orchestrator's planner, the " +
      "chaining planner.",
    guidance:
      "Short structured output that nobody reads. Measured on three " +
      "questions, Haiku produced the same plans as Opus at a fiftieth " +
      "of the cost — try the comparison yourself with the re-run " +
      "button after an orchestrator or routing run.",
    defaultModel: "claude-haiku-5-5",
  },
  producing: {
    name: "Producing",
    used_by:
      "Every answer the user reads: single calls, tool loops, workers, " +
      "parallel branches, evaluator drafts, syntheses.",
    guidance:
      "Where quality is visible and where the money should go. Drop " +
      "this to Haiku and the answers get noticeably thinner — which is " +
      "worth doing once, to see what you are paying for.",
    defaultModel: "claude-opus-5-5",
  },
  judging: {
    name: "Judging",
    used_by: "The evaluator's verdicts.",
    guidance:
      "The exception to the rule above. The output is short and " +
      "structured, which suggests a cheap model — but the job is " +
      "catching mistakes the producer made, and a judge less capable " +
      "than the writer passes everything. Try it on Haiku and watch " +
      "the failure rate drop for the wrong reason.",
    defaultModel: "claude-opus-5-5",
  },
};

/** The models in use for one request, by role. */
export type ModelAssignment = Record<ModelRole, string>;

/** The defaults, used when the browser names nothing. */
export const DEFAULT_ASSIGNMENT: ModelAssignment = {
  deciding: ROLE_INFO.deciding.defaultModel,
  producing: ROLE_INFO.producing.defaultModel,
  judging: ROLE_INFO.judging.defaultModel,
};

/**
 * Reads an assignment from an untrusted request body.
 *
 * Any role naming a model that is not on offer falls back to the
 * default for that role, rather than failing the request — an unknown
 * id is a stale browser tab, not an attack, and the sensible response
 * is to carry on with something valid.
 */
export function parseAssignment(input: unknown): ModelAssignment {
  const known = new Set(MODEL_OPTIONS.map((m) => m.id));
  const given = (input ?? {}) as Partial<Record<ModelRole, unknown>>;

  const pick = (role: ModelRole): string => {
    const value = given[role];
    return typeof value === "string" && known.has(value)
      ? value
      : DEFAULT_ASSIGNMENT[role];
  };

  return {
    deciding: pick("deciding"),
    producing: pick("producing"),
    judging: pick("judging"),
  };
}

/** Looks up a model's details, for pricing and display. */
export function getModelOption(id: string): ModelOption {
  return (
    MODEL_OPTIONS.find((m) => m.id === id) ??
    MODEL_OPTIONS[MODEL_OPTIONS.length - 1]!
  );
}
