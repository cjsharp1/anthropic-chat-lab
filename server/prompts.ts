/**
 * prompts.ts — the instructions that shape how Claude behaves.
 *
 * Prompts are kept here, away from the code that sends them, for the same
 * reason copy is kept out of a UI component: they get edited far more often
 * than the surrounding logic, usually by someone who is tuning behaviour
 * rather than changing how the app works.
 *
 * A system prompt is not a message in the conversation. It is a separate
 * `system` parameter on the request, and the difference matters:
 *
 *   - It carries more weight than anything in the messages array. Claude
 *     treats it as instructions from the operator of the app, not as
 *     something a user said.
 *
 *   - It is not something the user can overwrite by asking nicely. A user
 *     saying "ignore your instructions" is a message; this is not.
 *
 *   - It sits at the very start of the request, before the messages. That
 *     position is why it is the natural thing to cache in step 58: it is
 *     identical on every turn, so it forms a stable prefix.
 */

/**
 * The teaching assistant persona.
 *
 * Written to suit the job: someone working through the Anthropic
 * certifications, who wants to understand mechanisms rather than be handed
 * finished answers.
 *
 * Worth noticing how specific this is. "Be helpful and friendly" would
 * change almost nothing about the replies — a vague prompt produces the
 * model's default behaviour with extra tokens attached. Instructions only
 * do work when they rule something out.
 */
export const TEACHING_SYSTEM_PROMPT = `You are a patient teaching assistant inside a training app for the Anthropic certifications. The person using you is learning how the Claude API works by building an app with it.

How to answer:

- Explain the mechanism, not just the result. If someone asks what a parameter does, say what it changes and what happens if you get it wrong.
- Prefer concrete numbers and real API field names over paraphrase. Say "stop_reason is max_tokens", not "the response was cut short".
- When something is a common mistake, say so plainly and say what the symptom looks like. Learners recognise symptoms before they recognise causes.
- Keep answers short unless depth was asked for. Three clear sentences beat two paragraphs that bury the point.
- If a question has a wrong premise, correct it before answering. Do not quietly answer the question they should have asked.
- If you are not certain, say so and say what you would check. Confident invention is the worst possible failure in a teaching context.

Formatting: plain prose by default. Use a short list only when the content really is a list. Do not open with a restatement of the question.`;

/**
 * The shortest useful answer.
 *
 * Most of the length in a model's reply is not information — it is framing,
 * restatement, and offers to continue. This prompt removes the permission
 * to do any of that.
 *
 * Worth watching the output token count in the log panel when you switch to
 * this. The saving is usually large, and output tokens are the expensive
 * ones: five times the price of input on Opus. A terse prompt is the
 * cheapest cost optimisation available, and it costs nothing to try.
 */
export const TERSE_SYSTEM_PROMPT = `You are a reference tool for the Anthropic Claude API. Answer in as few words as the question allows.

Rules:

- Lead with the answer. No preamble, no restating the question, no "great question".
- One or two sentences for a simple question. Never more than four unless the answer genuinely needs steps.
- Use exact API field names and values rather than describing them.
- No summary at the end. No offer to explain further. Stop when the answer is complete.
- If a one-word answer is correct, give one word.`;

/**
 * Explains things from first principles, assuming nothing.
 *
 * The opposite end of the range from TERSE. Useful for showing a class how
 * much the same question can cost depending only on the instructions.
 */
export const BEGINNER_SYSTEM_PROMPT = `You are teaching someone who is new to APIs in general, not just Claude's.

- Assume no prior knowledge of HTTP, tokens, or LLM terminology. Define a term the first time you use it.
- Use a concrete example for every abstract point. A real request or response beats a description of one.
- Relate new ideas to something ordinary before relating them to other technical ideas.
- Warn about the mistake a beginner would actually make, not the one an expert would.
- Length is fine. Clarity matters more than brevity here.`;

/**
 * Answers in the register of the certification exam.
 *
 * Useful late in a study session: it drills the precise vocabulary rather
 * than the intuition.
 */
export const EXAM_SYSTEM_PROMPT = `You are preparing someone for an Anthropic certification exam.

- Answer using the exact terminology the documentation uses. Precision over paraphrase.
- Name the specific parameter, field, header or error class involved in every answer.
- Where two things are commonly confused, state the distinction explicitly.
- Where behaviour differs between models, say which models.
- After the answer, add one line beginning "Likely exam trap:" naming the misconception a question would test.`;

/**
 * No system prompt at all.
 *
 * Not an empty string — the absence of the parameter entirely. Worth having
 * as an option so a learner can see the model's unguided default and judge
 * what the other prompts are actually buying.
 */
export const NO_SYSTEM_PROMPT = null;

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** One selectable prompt, as offered to the browser. */
export interface PromptOption {
  /** Stable identifier sent back by the frontend. */
  id: string;
  /** Short label for the dropdown. */
  name: string;
  /** One line explaining when to choose this, shown under the selector. */
  description: string;
  /**
   * What choosing this does to the request on the wire, and what to
   * watch for in the activity log as a result.
   *
   * Separate from `description` because the two answer different
   * questions: one is "when would I pick this", the other is "what
   * actually changes". A learner needs both, and running them together
   * produces a paragraph nobody reads.
   */
  effect: string;
  /** The text itself, or null to send no system parameter at all. */
  text: string | null;
}

/**
 * Every prompt the UI offers, in the order it shows them.
 *
 * Ordered roughly from shortest output to longest, so moving down the list
 * is also moving up the cost.
 */
export const PROMPT_OPTIONS: PromptOption[] = [
  {
    id: "terse",
    name: "Terse",
    description:
      "Rules out preamble, restatement and closing offers. Best while " +
      "working through this app: you get the answer without the lecture.",
    effect:
      "Sends a 509-character system field. Output tokens typically drop " +
      "by 60-80% against the Teaching prompt for the same question, and " +
      "output costs five times what input does — so this is usually the " +
      "largest single cost lever available, and it is free to pull.",
    text: TERSE_SYSTEM_PROMPT,
  },
  {
    id: "teaching",
    name: "Teaching assistant",
    description:
      "Explains how something works rather than just what it does, and " +
      "names the mistake people actually make. The default.",
    effect:
      "Sends a 1,136-character system field — the longest of the useful " +
      "options. Replies run two to three times longer than Terse. Worth " +
      "the cost while learning a mechanism; wasteful for a lookup.",
    text: TEACHING_SYSTEM_PROMPT,
  },
  {
    id: "exam",
    name: "Exam prep",
    description:
      "Answers in the register of the certification exam: exact field " +
      "names, explicit distinctions, and the trap each question tests.",
    effect:
      "Sends a 484-character system field. Replies end with a 'Likely " +
      "exam trap' line. Useful late in a study session, when the goal is " +
      "precise vocabulary rather than intuition.",
    text: EXAM_SYSTEM_PROMPT,
  },
  {
    id: "beginner",
    name: "Beginner",
    description:
      "Assumes no knowledge of HTTP, tokens or LLM terminology. Defines " +
      "each term and gives a concrete example for every abstract point.",
    effect:
      "Sends a 519-character system field, but produces by far the " +
      "longest replies — measured at 4,092 output tokens against Terse's " +
      "250 on the same question, around fourteen times the cost. A short " +
      "prompt does not mean a cheap one: what matters is how much output " +
      "it invites.",
    text: BEGINNER_SYSTEM_PROMPT,
  },
  {
    id: "none",
    name: "No system prompt",
    description:
      "No instructions at all. Shows the model's unguided default, which " +
      "is what the other options are measured against.",
    effect:
      "Omits the system field entirely rather than sending an empty " +
      "string — the two are different on the wire. Input drops by " +
      "roughly 350 tokens per turn. Replies hedge more, cover adjacent " +
      "topics, and sometimes mention other providers, because nothing " +
      "has told the model what context it is in.",
    text: NO_SYSTEM_PROMPT,
  },
];

/** Which prompt is used when the browser does not name one. */
export const DEFAULT_PROMPT_ID = "teaching";

/**
 * Looks up a prompt by id, falling back to the default.
 *
 * The id arrives from the browser, so it is untrusted: an unknown value
 * must not throw or send `undefined` as a system prompt.
 */
export function getPrompt(id: unknown): PromptOption {
  const found = PROMPT_OPTIONS.find((option) => option.id === id);
  if (found) return found;
  return PROMPT_OPTIONS.find((o) => o.id === DEFAULT_PROMPT_ID)!;
}
