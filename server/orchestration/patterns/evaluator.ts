/**
 * evaluator.ts — generate, critique, regenerate.
 *
 * One call writes a draft. A second call judges it against explicit
 * criteria and returns a verdict with feedback. If it fails, the
 * feedback goes back to the generator and the cycle repeats, up to a
 * limit.
 *
 * ---------------------------------------------------------------------------
 * Why a separate evaluator
 * ---------------------------------------------------------------------------
 *
 * Asking a model to check its own work in the same breath as doing it
 * does not work well. The draft is already in its context as something
 * it just committed to, and the pull toward defending it is strong.
 * "Review your answer and improve it" reliably produces "here is my
 * answer, slightly reworded".
 *
 * A separate call with a different system prompt does not have that
 * problem. It has never seen itself write the draft; it is reading
 * someone else's work against a checklist. That is a different task,
 * and models are much better at it.
 *
 * This is the same idea as code review by someone other than the
 * author, and it fails for the same reasons when you skip it.
 *
 * ---------------------------------------------------------------------------
 * The criteria have to be real
 * ---------------------------------------------------------------------------
 *
 * An evaluator asked "is this good?" says yes. It has no grounds to
 * say anything else, so the loop terminates on the first round and the
 * pattern becomes an expensive single call with a ceremonial second
 * step.
 *
 * The criteria below are specific enough to fail: they name things
 * that are checkably present or absent. "Does it name the exact API
 * field involved" has an answer; "is it clear" does not.
 *
 * ---------------------------------------------------------------------------
 * What it costs
 * ---------------------------------------------------------------------------
 *
 * Two requests minimum, two more per failed round. A three-round run
 * is six requests for one answer, and the generator's input grows each
 * time because the previous draft and its critique come with it.
 *
 * It is the most expensive pattern here by some margin, and the only
 * one whose cost is not known in advance. Worth it when being wrong is
 * expensive and being slow is not.
 */

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "../../anthropic.js";
import { warnToolsIgnored } from "../no-tools.js";
import {
  describeCacheOutcome,
  describeCachePlan,
  warnIfBelowCacheMinimum,
  withCachedHistory,
  withCachedSystem,
  withCachedTools,
} from "../../caching.js";
import {
  formatCost,
  summariseUsage,
  type UsageSummary,
} from "../../usage.js";
import type { Pattern, PatternContext, PatternResult } from "../types.js";
import type { Logger } from "../../logger.js";

/**
 * How many times the draft may be rejected before it is returned anyway.
 *
 * Three rounds is six requests. Past that the evaluator is usually
 * either asking for something the generator cannot produce, or
 * polishing something already good enough — and either way the loop
 * has stopped earning its cost.
 */
const MAX_ROUNDS = 3;

/** Caps each draft. */
const DRAFT_MAX_TOKENS = 2000;

/** The evaluator returns a verdict, not an essay. */
const VERDICT_MAX_TOKENS = 1000;

/**
 * The verdict shape.
 *
 * `pass` is deliberately first and boolean: a verdict that can only be
 * expressed as prose has to be parsed, and parsing "well, mostly" is
 * where a loop like this goes wrong.
 */
const VerdictSchema = z.object({
  pass: z
    .boolean()
    .describe("True only if the answer meets every criterion."),
  failed: z
    .array(z.string())
    .describe("The criteria it failed, by name. Empty when pass is true."),
  feedback: z
    .string()
    .describe(
      "What specifically to change, as instructions to the writer. " +
        "Empty when pass is true. Do not rewrite the answer yourself.",
    ),
});

type Verdict = z.infer<typeof VerdictSchema>;

/**
 * What the draft is judged against.
 *
 * Written so each has a checkable answer. An evaluator given vague
 * criteria passes everything, which makes the whole pattern a no-op
 * that costs double.
 */
const CRITERIA = [
  "answers-the-question: addresses what was actually asked, not an adjacent easier question",
  "specific: names real API fields, values, error classes or numbers rather than describing them in general terms",
  "complete: no part of a multi-part question is left unanswered",
  "correct: nothing stated as fact is wrong or invented",
  "no-padding: no preamble, no restatement of the question, no closing offer to help further",
];

const EVALUATOR_SYSTEM = `You are reviewing someone else's draft answer against a checklist. You did not write it and have no stake in it.

Criteria:

${CRITERIA.map((c) => `- ${c}`).join("\n")}

Judge strictly. A draft that is merely acceptable fails: say what would make it good. Only pass a draft that meets every criterion.

When it fails, write feedback as direct instructions to the writer — "name the specific error class", "the second half of the question about pricing is not answered". Do not rewrite the answer yourself and do not be encouraging.`;

export const evaluator: Pattern = {
  id: "evaluator",
  name: "Evaluator + optimiser",

  description:
    "Writes a draft, has a separate call grade it against explicit " +
    "criteria, and rewrites until it passes or hits three rounds. The " +
    "most expensive pattern here, and the only one whose cost is not " +
    "known in advance.",

  typicalRequests: "2 to 6",

  whenToUse:
    "When being wrong is expensive and being slow is not. The separate " +
    "evaluator catches factual errors a self-review would wave through. " +
    "Overkill for anything conversational, and the cost is not known " +
    "in advance — a stubborn question runs the full three rounds.",

  measuredCost:
    "4 requests, $0.0593 on the test question (two rounds). Two requests " +
    "per round, and the generator's input grows each round because the " +
    "rejected draft and its critique travel with it.",

  // The generator writes drafts; the evaluator grades them. Judging is its own role because a judge less capable than the writer passes work that should have been sent back.
  usesRoles: ["producing", "judging"],

  examples: [
    {
      prompt: "Tell me about caching.",
      watch:
        "Deliberately vague. Watch for a FAIL verdict in round one — " +
        "expand it to read which criterion failed and what the " +
        "evaluator told the writer to fix.",
      kind: "good-fit",
    },
    {
      prompt: "Say hello.",
      watch:
        "Nothing to evaluate against criteria about API fields and " +
        "completeness. It passes on round one, and the second call was " +
        "pure ceremony.",
      kind: "poor-fit",
    },
  ],

  async run(context: PatternContext): Promise<PatternResult> {
    const {
      messages, system, tools, log, emitText, models, cacheMode,
      thinkingDisplay,
      effort,
    } = context;

    // The model that writes what the user reads.
    const producing = models.producing;
    // The model that grades the draft. See models.ts for why
    // this is its own role rather than a deciding call.
    const judging = models.judging;

    // Say so rather than discarding them silently — see no-tools.ts.
    const serverTools = warnToolsIgnored(
      tools,
      "Evaluator + optimiser",
      "The generator and the evaluator both make single calls. The " +
        "loop here is over drafts, not over tool results.",
      log,
    );

    let totalCost = 0;
    let requests = 0;
    let draft = "";
    let lastVerdict: Verdict | null = null;
    let round = 0;

    logLoopStart(log);

    while (round < MAX_ROUNDS) {
      round += 1;

      // --- Generate ---------------------------------------------------------
      //
      // On round one the generator sees only the question. On later
      // rounds it also sees its own previous draft and the critique of
      // it, which is what makes this different from simply asking
      // twice.

      const generatorSystem = [
        system,
        round === 1
          ? null
          : [
              "Your previous draft was reviewed and rejected.",
              "",
              "Previous draft:",
              draft,
              "",
              `Failed on: ${lastVerdict?.failed.join(", ")}`,
              "",
              "Reviewer's instructions:",
              lastVerdict?.feedback,
              "",
              "Write the answer again, addressing every point. Do not " +
                "mention the revision or apologise for the earlier draft.",
            ].join("\n"),
      ]
        .filter(Boolean)
        .join("\n\n");

      // Prompt caching. The request renders as tools → system →
      // messages, so the stable front of it is worth marking: a
      // later request sharing that prefix reads it back at about
      // a twentieth of the input price.
      // serverTools, not tools: this pattern sends only the server ones,
      // and an estimate counting tools that are never sent would warn
      // about the wrong thing — or fail to warn at all.
      const cachePlan = describeCachePlan(
        serverTools,
        system,
        messages,
        producing,
      );

      warnIfBelowCacheMinimum(cachePlan, log);

      const draftRequest = {
        model: producing,
        max_tokens: DRAFT_MAX_TOKENS,
        system: withCachedSystem(generatorSystem),
        // Server tools go on the generator, the call that produces what
        // the user reads. A planner or classifier has no business
        // searching the web — it would research something it is
        // about to throw away.
        ...(serverTools ? { tools: withCachedTools(serverTools, cacheMode) } : {}),
        messages: withCachedHistory(messages, cacheMode),
        // Thinking is always on; this decides whether its
        // summary comes back readable. See server/thinking.ts.
        thinking: { type: "adaptive" as const, display: thinkingDisplay },
        output_config: { effort },
      };

      logDraftRequest(log, lastVerdict, round, draftRequest);

      const draftStarted = Date.now();

      // Not streamed. A draft that is about to be rejected should not
      // be typing itself into the transcript — the user would watch an
      // answer appear and then be replaced, which is worse than waiting.
      const draftResponse = await getClient().messages.create(draftRequest);

      requests += 1;
      const draftElapsed = Date.now() - draftStarted;

      draft = draftResponse.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();

      const draftUsage = summariseUsage(
        draftResponse.usage,
        draftResponse.model,
      );
      totalCost += draftUsage.cost;

      logDraftResponse(
        log,
        draft,
        round,
        draftResponse,
        draftElapsed,
        draftUsage,
      );

      if (draftResponse.stop_reason === "max_tokens") {
        logDraftTruncated(log, round);
      }

      // --- Evaluate ---------------------------------------------------------
      //
      // The evaluator sees the question and the draft, and nothing
      // else. Not the conversation history, not the previous rounds —
      // it is judging this draft against the criteria, and prior
      // context would invite it to grade on improvement rather than on
      // the checklist.

      const latest = messages[messages.length - 1];
      const question =
        typeof latest?.content === "string"
          ? latest.content
          : JSON.stringify(latest?.content ?? "");

      // Built once, then both logged and sent.
      //
      // An earlier version described the request in the log instead of
      // showing it — "(the question and the draft)" where the messages
      // array should have been. That is worse than useless in a panel
      // whose whole purpose is showing what went on the wire, and it is
      // the predictable result of writing the request out twice. One
      // object cannot disagree with itself.
      const evalRequest = {
        // The judging model, not the producing one. They default to
        // the same thing, which is the point: a judge less capable
        // than the writer passes work the writer should have been
        // told to redo. Change it in Settings and watch the failure
        // rate drop for the wrong reason.
        model: judging,
        max_tokens: VERDICT_MAX_TOKENS,
        system: EVALUATOR_SYSTEM,
        messages: [
          {
            role: "user" as const,
            content: `Question that was asked:\n\n${question}\n\nDraft answer to review:\n\n${draft}`,
          },
        ],
        // Thinking is always on; this decides whether its
        // summary comes back readable. See server/thinking.ts.
        thinking: { type: "adaptive" as const, display: thinkingDisplay },
        // The verdict schema and the effort level share ONE
        // output_config. Both go in the same object: a second
        // `output_config:` key would not merge, it would silently
        // replace the first and the format would be gone.
        output_config: { format: zodOutputFormat(VerdictSchema), effort },
      };

      logEvalRequest(log, round, evalRequest);

      const evalStarted = Date.now();

      const evalResponse = await getClient().messages.parse(evalRequest);

      requests += 1;
      const evalElapsed = Date.now() - evalStarted;

      const evalUsage = summariseUsage(evalResponse.usage, evalResponse.model);
      totalCost += evalUsage.cost;

      const verdict = evalResponse.parsed_output as Verdict | undefined;

      // A verdict that would not parse is treated as a pass rather than
      // a failure. Looping again on a broken evaluator would spend
      // money without any prospect of the result improving.
      if (!verdict) {
        // warn, not error: the draft is returned and is probably fine; only the check was lost.
        logVerdictUnparseable(log, round);
        break;
      }

      lastVerdict = verdict;

      logVerdict(log, round, evalElapsed, evalUsage, verdict);

      if (verdict.pass) {
        logPassed(log, requests, round);
        break;
      }

      logRejected(log, round, verdict);
    }

    // --- Deliver -------------------------------------------------------------
    //
    // The accepted draft is streamed out as text rather than being
    // re-generated. Asking the model to say it again would cost another
    // request and risk producing something the evaluator never saw.

    emitText(draft);

    const passed = lastVerdict?.pass ?? false;

    if (!passed && round >= MAX_ROUNDS) {
      // warn, not error: an answer is returned; it just never satisfied the evaluator.
      logNeverPassed(log, lastVerdict);
    }

    logEvaluatorSummary(log, totalCost, requests, round, passed);

    return { text: draft, cost: totalCost, requests };
  },
};

// ---------------------------------------------------------------------------
// Activity-log rows: what the panel shows for each step above
// ---------------------------------------------------------------------------
//
// Everything below builds a log row. None of it changes what is sent to
// Anthropic or what comes back, which is why it sits here rather than
// inside run(): the steps above should read as the pattern, and this is
// the commentary on them.
//
// Same arrangement as the other patterns, deliberately. A reader who
// has seen one should recognise the rest.

function logLoopStart(log: Logger): void {
  log.info(
    `Starting evaluator loop · up to ${MAX_ROUNDS} rounds`,
    {
      criteria: CRITERIA,
      note:
        "Each round is two requests: one to write, one to judge. The " +
        "criteria are specific enough to fail — an evaluator asked " +
        "'is this good?' says yes, and the loop becomes ceremony.",
    },
    {
      actor: "app",
      because: "this pattern drafts and critiques before answering",
    },
  );
}

function logDraftRequest(
  log: Logger,
  lastVerdict: Verdict | null,
  round: number,
  draftRequest: Anthropic.MessageCreateParams,
): void {
  log.api(
    round === 1
      ? `Round ${round}: writing the first draft`
      : `Round ${round}: rewriting after ${lastVerdict?.failed.length} failure(s)`,
    {
      round,
      request: draftRequest,
      ...(round > 1 && {
        note:
          "The previous draft and its critique are in this request's " +
          "system prompt, which is why the input is larger than last " +
          "round. Each rejection makes the next attempt cost more.",
      }),
    },
    {
      direction: "out",
      iteration: round,
      actor: "app",
      because:
        round === 1
          ? "the loop needs something to evaluate"
          : "the previous draft failed review",
    },
  );
}

function logDraftResponse(
  log: Logger,
  draft: string,
  round: number,
  draftResponse: Anthropic.Message,
  draftElapsed: number,
  draftUsage: UsageSummary,
): void {
  log.api(
    `Draft ${round} · ${draftUsage.totalInput} in / ${draftUsage.output} out · ` +
      `${formatCost(draftUsage.cost)} · ${draftElapsed}ms`,
    {
      round,
      elapsed_ms: draftElapsed,
      estimated_cost: formatCost(draftUsage.cost),
      // What caching did, in words. The raw cache_read and
      // cache_write numbers are the ones in the documentation, but
      // they do not say which of three states this request was in,
      // and the three look similar until you know what to compare.
      caching: {
        hit_rate: `${Math.round(draftUsage.cacheHitRate * 100)}%`,
        read_from_cache: draftUsage.cacheRead,
        written_to_cache: draftUsage.cacheWrite,
        fresh: draftUsage.input,
        what_happened: describeCacheOutcome(draftUsage),
      },
      // The draft itself. Comparing round one with round three is
      // the most direct way to see whether the loop improved
      // anything or merely reworded it.
      draft,
      response: {
        model: draftResponse.model,
        stop_reason: draftResponse.stop_reason,
        usage: draftResponse.usage,
      },
    },
    {
      direction: "in",
      iteration: round,
      actor: "claude",
      because: `the generator produced draft ${round}`,
    },
  );
}

function logDraftTruncated(log: Logger, round: number): void {
  log.error(
    `Draft ${round} was truncated at ${DRAFT_MAX_TOKENS} tokens`,
    {
      note:
        "The evaluator will judge an incomplete answer and will " +
        "probably fail it on 'complete' — which is correct, but " +
        "the cause is the cap, not the generator.",
    },
    {
      iteration: round,
      actor: "claude",
      because: "the draft reached max_tokens before finishing",
    },
  );
}

function logEvalRequest(
  log: Logger,
  round: number,
  evalRequest: Anthropic.MessageCreateParams,
): void {
  log.api(
    `Round ${round}: evaluating the draft`,
    {
      round,
      request: evalRequest,
      note:
        "A separate call with a different system prompt. The same " +
        "model asked to review its own work in one turn defends the " +
        "draft; a fresh call reads it as someone else's.",
    },
    {
      direction: "out",
      iteration: round,
      actor: "app",
      because: "the draft needs judging before it can be returned",
    },
  );
}

function logVerdictUnparseable(log: Logger, round: number): void {
  log.warn(
    "The evaluator returned nothing parseable — accepting the draft",
    {
      note:
        "Treated as a pass. Retrying would cost another two " +
        "requests with no reason to expect a different outcome.",
    },
    {
      iteration: round,
      actor: "app",
      because: "the verdict did not match the schema",
    },
  );
}

function logVerdict(
  log: Logger,
  round: number,
  evalElapsed: number,
  evalUsage: UsageSummary,
  verdict: Verdict,
): void {
  log.api(
    `Verdict ${round}: ${verdict.pass ? "PASS" : "FAIL"} · ` +
      `${evalUsage.totalInput} in / ${evalUsage.output} out · ` +
      `${formatCost(evalUsage.cost)} · ${evalElapsed}ms`,
    {
      round,
      pass: verdict.pass,
      failed_criteria: verdict.failed,
      feedback: verdict.feedback,
      elapsed_ms: evalElapsed,
      estimated_cost: formatCost(evalUsage.cost),
    },
    {
      direction: "in",
      iteration: round,
      actor: "claude",
      because: verdict.pass
        ? "the draft met every criterion"
        : `the draft failed on ${verdict.failed.length} criterion/criteria`,
    },
  );
}

function logPassed(log: Logger, requests: number, round: number): void {
  log.info(
    `Passed on round ${round}`,
    { rounds_used: round, requests },
    {
      iteration: round,
      actor: "app",
      because: "the evaluator accepted the draft",
    },
  );
}

function logRejected(log: Logger, round: number, verdict: Verdict): void {
  log.info(
    `Round ${round} rejected: ${verdict.failed.join(", ")}`,
    {
      failed: verdict.failed,
      feedback: verdict.feedback,
      note:
        round < MAX_ROUNDS
          ? "The feedback goes into the next draft's system prompt."
          : `Round limit of ${MAX_ROUNDS} reached — the last draft is ` +
            "returned as it stands.",
    },
    {
      iteration: round,
      actor: "claude",
      because: "the evaluator rejected this draft",
    },
  );
}

function logNeverPassed(log: Logger, lastVerdict: Verdict | null): void {
  log.warn(
    `Returned without passing after ${MAX_ROUNDS} rounds`,
    {
      last_failed: lastVerdict?.failed,
      last_feedback: lastVerdict?.feedback,
      note:
        "The loop gave up and returned the last draft. Usually this " +
        "means the evaluator is asking for something the generator " +
        "cannot produce — check whether the criteria are achievable " +
        "for this question.",
    },
    {
      actor: "app",
      because: "the round limit was reached with the draft still failing",
    },
  );
}

function logEvaluatorSummary(
  log: Logger,
  totalCost: number,
  requests: number,
  round: number,
  passed: boolean,
): void {
  log.info(
    `Evaluator complete · ${round} round(s) · ${requests} requests · ` +
      `${formatCost(totalCost)}`,
    {
      rounds: round,
      requests,
      passed,
      total_cost: totalCost,
      note:
        "Two requests per round. Compare the first and last drafts in " +
        "the rows above: if they say the same thing, the loop cost " +
        "double for nothing, and the criteria are the thing to change.",
    },
    {
      actor: "app",
      because: "the loop finished",
    },
  );
}
