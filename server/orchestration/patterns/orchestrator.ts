/**
 * orchestrator.ts — a lead model plans the work, workers do it.
 *
 * Call one asks Claude to break the question into subtasks and returns
 * that plan as JSON. Each subtask is then answered by its own call,
 * all at once. A final call merges the answers.
 *
 * ---------------------------------------------------------------------------
 * How this differs from parallelisation
 * ---------------------------------------------------------------------------
 *
 * The parallel pattern splits every question the same way: mechanism,
 * practice, pitfalls. That works when those three aspects happen to
 * fit, and pads awkwardly when they do not — ask it to compare two
 * models and it will dutifully produce a "pitfalls" section about
 * nothing.
 *
 * This pattern decides the split per question. "Compare Opus and
 * Haiku on cost, speed and quality" becomes three subtasks about
 * those three things. The structure follows the question rather than
 * the question being forced into a structure.
 *
 * The price is one more request, and a dependency on the planner
 * being sensible. A bad plan produces confidently wrong work in
 * parallel, which is worse than a single mediocre answer because it
 * costs five times as much to produce.
 *
 * ---------------------------------------------------------------------------
 * Structured outputs
 * ---------------------------------------------------------------------------
 *
 * The plan has to be read by code, not by a person, so it comes back
 * as JSON matching a schema rather than as prose. That is what
 * `output_config.format` does: the API constrains generation so the
 * reply validates against the schema, rather than asking politely for
 * JSON and hoping.
 *
 * The difference matters. "Reply with JSON" produces JSON most of the
 * time, and a markdown code fence or an apologetic preamble the rest
 * of the time — and every one of those is a crash in code that calls
 * JSON.parse on it. Constrained generation removes the failure mode
 * rather than handling it.
 *
 * Note the SDK returns the result on `parsed_output`, and that this
 * only works with `getClient().messages.parse()` rather than `.create()`.
 *
 * ---------------------------------------------------------------------------
 * Why the planner runs on Haiku
 * ---------------------------------------------------------------------------
 *
 * The same reasoning as the router's classifier, and it generalises:
 * a call that produces a short, structured decision rather than an
 * answer rarely needs the expensive model.
 *
 * This was measured rather than assumed. The same planning prompt was
 * run on both models against three questions:
 *
 *   "Compare caching and the Batch API..."
 *     Opus   $0.01275  7052ms  3 subtasks
 *     Haiku  $0.00026  3158ms  4 subtasks — arguably the better split,
 *                              since it followed the question's own
 *                              three parts
 *
 *   "What does tool_use_id do?"
 *     Opus   $0.00592  4163ms  1 subtask
 *     Haiku  $0.00013  1230ms  1 subtask — same judgement that there
 *                              was nothing to divide
 *
 *   "Explain how to build an agent, covering tools, the loop,
 *    error handling and cost control"
 *     Opus   $0.01451  7201ms  4 subtasks
 *     Haiku  $0.00029  4009ms  4 subtasks — identical titles
 *
 * About fifty times cheaper and twice as fast, for plans that are as
 * good or better. The planning call went from roughly 8% of a run's
 * cost to under 1%.
 *
 * The heuristic worth taking away: ask what the call is actually
 * deciding. Choosing a label, splitting a question, or extracting a
 * field is reading comprehension, and the small model does it. Writing
 * the answer is not.
 *
 * The workers and the synthesiser stay on the main model, because
 * those are producing the answer the user reads.
 */

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type Anthropic from "@anthropic-ai/sdk";
import { apiModelId, getClient, MAX_TOKENS } from "../../anthropic.js";
import { warnToolsIgnored } from "../no-tools.js";
import {
  describeCacheOutcome,
  describeCachePlan,
  warnIfBelowCacheMinimum,
  withCachedHistory,
  withCachedSystem,
} from "../../caching.js";
import {
  formatCost,
  snippet,
  summariseUsage,
  type UsageSummary,
} from "../../usage.js";
import type { Pattern, PatternContext, PatternResult } from "../types.js";
import type { Logger } from "../../logger.js";

/**
 * Caps each worker.
 *
 * Five long answers would swamp the synthesis call, whose input
 * carries all of them. But set it too low and workers are truncated
 * mid-sentence, and the merge then stitches together fragments —
 * which reads as a vague answer rather than a broken one, so nobody
 * notices. 2000 leaves room for a complete answer to one subtask.
 */
const WORKER_MAX_TOKENS = 2000;

/** Caps the plan. A planner writing prose has misunderstood its job. */
const PLAN_MAX_TOKENS = 1500;

/** Upper bound on subtasks, enforced after parsing as well as in the prompt. */
const MAX_SUBTASKS = 5;

/**
 * The shape the planner must return.
 *
 * Deliberately small. Every field the schema asks for is a field the
 * planner can get wrong, and each one needs a reason to exist:
 *
 *   title     for the log, so the plan is readable at a glance
 *   question  what the worker is actually asked
 *
 * A `dependsOn` field was considered and left out: subtasks that
 * depend on each other cannot run in parallel, which is the entire
 * point of this pattern. The planner is told to produce independent
 * ones instead.
 */
const PlanSchema = z.object({
  reasoning: z
    .string()
    .describe("One sentence on why this is the right way to split the question."),
  subtasks: z
    .array(
      z.object({
        title: z.string().describe("A three-to-five word label."),
        question: z
          .string()
          .describe(
            "A self-contained question. The worker answering it will not " +
              "see the original question or the other subtasks.",
          ),
      }),
    )
    .describe("Between one and five independent subtasks."),
});

type Plan = z.infer<typeof PlanSchema>;

const PLANNER_SYSTEM = `You are planning how to answer a question by splitting it into independent parts.

Rules:

- Produce between one and ${MAX_SUBTASKS} subtasks.
- Each must be answerable WITHOUT seeing the others or the original question. Write each as a complete, self-contained question.
- They must not overlap. Two subtasks covering the same ground means paying twice for one answer.
- Together they must cover the whole question, with nothing important left out.
- If the question is simple enough that splitting it would not help, return exactly one subtask containing the original question.

Do not answer anything. You are only deciding what to ask.`;

/** What one worker produced. */
interface WorkerResult {
  title: string;
  question: string;
  text: string;
  cost: number;
  elapsedMs: number;
  failed: boolean;
}

export const orchestrator: Pattern = {
  id: "orchestrator",
  name: "Orchestrator + workers",

  description:
    "A cheap model plans the subtasks, workers answer them in parallel " +
    "on the main model, and a final call merges the results. The split " +
    "follows the question rather than being fixed.",

  typicalRequests: "3 to 7",

  whenToUse:
    "Questions with genuinely separable parts, where what those parts " +
    "are depends on the question. Better than Parallelisation when the " +
    "fixed three aspects do not fit; worse when they do, since it pays " +
    "an extra request to work out what Parallelisation assumes.",

  measuredCost:
    "3 requests, $0.0473 on a question that split into one subtask; 6 " +
    "requests and $0.12 on a four-part comparison. The planner runs on " +
    "Haiku and costs $0.0003 of that — under 1% — having been measured " +
    "against Opus and found to plan just as well. The only pattern " +
    "whose request count the question decides.",

  // The planner decides the subtasks; workers and the synthesiser write the answer.
  usesRoles: ["deciding", "producing"],

  examples: [
    {
      prompt:
        "Compare prompt caching and the Batch API: how each works, what " +
        "each saves, and when to use which.",
      watch:
        "Expand the plan row to see the subtasks Claude chose — they " +
        "follow the question rather than a template. Then try the same " +
        "question under Parallelisation and compare the splits.",
      kind: "good-fit",
    },
    {
      prompt: "What does the tool_use_id field do?",
      watch:
        "The planner should return a single subtask, because there is " +
        "nothing to divide. Three requests to answer what one would " +
        "have, and the plan says so.",
      kind: "poor-fit",
    },
  ],

  async run(context: PatternContext): Promise<PatternResult> {
    const {
      messages, system, tools, log, emitText, emitThinking, models, cacheMode,
      thinkingDisplay,
      effort,
    } = context;

    // The model that writes what the user reads.
    const producing = models.producing;
    // The model for short structured decisions nobody reads.
    const deciding = models.deciding;

    // Say so rather than discarding them silently — see no-tools.ts.
    const serverTools = warnToolsIgnored(
      tools,
      "Orchestrator + workers",
      "Workers make one call each and cannot loop. A production " +
        "version would give each worker its own tool loop, which is a " +
        "sensible thing to build and a confusing thing to learn from.",
      log,
    );

    let totalCost = 0;

    // --- Call one: plan ------------------------------------------------------

    // Built once, then both logged and sent — see the note in
    // evaluator.ts. Writing the request out twice is how the logged
    // model came to say Opus while the call actually used Haiku.
    const planRequest = {
      model: apiModelId(deciding),
      max_tokens: PLAN_MAX_TOKENS,
      system: PLANNER_SYSTEM,
      messages,
      // Thinking is always on; this decides whether its summary comes
      // back readable. See server/thinking.ts.
      thinking: { type: "adaptive" as const, display: thinkingDisplay },
      // The plan schema and the effort level share ONE output_config.
      // Both go in the same object: a second `output_config:` key
      // would not merge, it would silently replace the first and the
      // format would be gone.
      output_config: { format: zodOutputFormat(PlanSchema), effort },
    };

    logPlanRequest(log, producing, deciding, planRequest);

    const planStarted = Date.now();

    // .parse() rather than .create(): it applies the schema and
    // returns the validated object on parsed_output.
    const planResponse = await getClient().messages.parse(planRequest);

    const planElapsed = Date.now() - planStarted;
    const planUsage = summariseUsage(planResponse.usage, planResponse.model);
    totalCost += planUsage.cost;

    // Typed, but still checked. Constrained generation guarantees the
    // SHAPE — it does not guarantee the planner produced a sensible
    // number of subtasks, and the cap matters because each one is a
    // billed request.
    const plan = planResponse.parsed_output as Plan | undefined;
    const subtasks = (plan?.subtasks ?? []).slice(0, MAX_SUBTASKS);

    logPlanResponse(log, planResponse, planElapsed, planUsage, plan);

    if (subtasks.length === 0) {
      logNoSubtasks(log, plan);
    }

    if ((plan?.subtasks.length ?? 0) > MAX_SUBTASKS) {
      // warn, not error: the cap applied and the run continued with five subtasks.
      logSubtasksCapped(log, plan);
    }

    logPlan(log, plan, subtasks);

    // --- Calls two to N: the workers ----------------------------------------
    //
    // Each worker sees only its own question. Not the conversation, not
    // the other subtasks, not the original question — the planner was
    // told to write self-contained questions precisely so this is
    // possible, and the isolation is what keeps the calls independent.

    const workersStarted = Date.now();

    const workers: WorkerResult[] = await Promise.all(
      subtasks.map(async (subtask, i): Promise<WorkerResult> => {
        const started = Date.now();

        const workerRequest = {
          model: apiModelId(producing),
          max_tokens: WORKER_MAX_TOKENS,
          // The length instruction matters more than the token cap.
          // Without it a worker writes until something stops it, and
          // the cap is what stops it — producing a fragment the
          // synthesiser merges without noticing.
          system:
            "Answer the question directly. No preamble, no restatement, " +
            "no closing summary.\n\n" +
            "Keep it under 250 words. Your answer is one part of a " +
            "larger reply and will be merged with others, so cover your " +
            "own ground thoroughly and nothing else. Do not refer to " +
            "anything outside your answer.",
          // Server tools go on each worker, the call that produces what
          // the user reads. A planner or classifier has no business
          // searching the web — it would research something it is
          // about to throw away.
          ...(serverTools ? { tools: serverTools } : {}),
          messages: [{ role: "user" as const, content: subtask.question }],
          // Thinking is always on; this decides whether its
          // summary comes back readable. See server/thinking.ts.
          thinking: { type: "adaptive" as const, display: thinkingDisplay },
          output_config: { effort },
        };

        logWorkerRequest(log, subtasks, workerRequest, i, subtask);

        try {
          const response = await getClient().messages.create(workerRequest);

          const elapsedMs = Date.now() - started;
          const text = response.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("")
            .trim();

          const usage = summariseUsage(response.usage, response.model);

          logWorkerResponse(log, response, elapsedMs, text, usage, i, subtask);

          // Truncation here is the quiet failure this pattern is most
          // prone to. The worker returns HTTP 200 with a fragment, the
          // synthesiser merges it without complaint, and the final
          // answer is subtly incomplete with nothing to indicate why.
          if (response.stop_reason === "max_tokens") {
            logWorkerTruncated(log, usage, i, subtask);
          }

          return {
            title: subtask.title,
            question: subtask.question,
            text,
            cost: usage.cost,
            elapsedMs,
            failed: false,
          };
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);

          logWorkerFailed(log, message, i, subtask);

          return {
            title: subtask.title,
            question: subtask.question,
            text: "",
            cost: 0,
            elapsedMs: Date.now() - started,
            failed: true,
          };
        }
      }),
    );

    const workersElapsed = Date.now() - workersStarted;
    const sequentialWouldBe = workers.reduce((n, w) => n + w.elapsedMs, 0);

    for (const worker of workers) totalCost += worker.cost;

    const succeeded = workers.filter((w) => !w.failed && w.text);

    if (workers.length > 0) {
      logWorkersFinished(
        log,
        workers,
        workersElapsed,
        sequentialWouldBe,
        succeeded,
      );
    }

    // --- Final call: synthesise ---------------------------------------------

    const synthesisSystem = [
      system,
      succeeded.length > 0
        ? "Several workers have each answered part of the user's question. " +
          "Merge their answers into one."
        : "No sub-answers are available. Answer the question directly.",
      "",
      ...succeeded.map((w) => `## ${w.title}\n\n${w.text}`),
      succeeded.length > 0
        ? "Write one coherent answer in the order that reads best. Remove " +
          "repetition. Do not mention that the work was divided, and do " +
          "not reproduce these headings verbatim unless they genuinely " +
          "suit the answer."
        : "",
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

    const synthRequest = {
      model: apiModelId(producing),
      max_tokens: MAX_TOKENS,
      system: withCachedSystem(synthesisSystem),
      messages: withCachedHistory(messages, cacheMode),
      // Thinking is always on; this decides whether its
      // summary comes back readable. See server/thinking.ts.
      thinking: { type: "adaptive" as const, display: thinkingDisplay },
      output_config: { effort },
    };

    logSynthRequest(log, succeeded, synthRequest);

    const synthStarted = Date.now();

    const stream = getClient().messages.stream(synthRequest);

    stream.on("text", (fragment: string) => emitText(fragment));

    const synthResponse = await stream.finalMessage();

    // The reasoning summary, if one came back. Empty under the
    // default display setting: the blocks arrive either way,
    // but with no text in them.
    const thinkingSummary = synthResponse.content
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking)
      .join("")
      .trim();
    if (thinkingSummary) emitThinking(thinkingSummary);

    const synthElapsed = Date.now() - synthStarted;

    const text = synthResponse.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    const synthUsage = summariseUsage(synthResponse.usage, synthResponse.model);
    totalCost += synthUsage.cost;

    logSynthResponse(log, text, synthResponse, synthElapsed, synthUsage);

    const requests = 1 + workers.length + 1;

    logOrchestratorSummary(
      log,
      producing,
      deciding,
      totalCost,
      planUsage,
      workers,
      workersElapsed,
      sequentialWouldBe,
      synthUsage,
      requests,
    );

    return { text, cost: totalCost, requests };
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

function logPlanRequest(
  log: Logger,
  producing: string,
  deciding: string,
  planRequest: Anthropic.MessageCreateParams,
): void {
  log.api(
    `Planning with ${deciding}`,
    {
      request: planRequest,
      structured_output:
        "The reply is constrained to match a schema, so it cannot come " +
        "back as prose or wrapped in a code fence. Without that, code " +
        "calling JSON.parse on the reply breaks whenever the model " +
        "decides to be conversational.",
      why_haiku:
        "Splitting a question into parts is reading comprehension, not " +
        "reasoning. Measured against Opus on three questions, Haiku " +
        "produced plans as good or better at about a fiftieth of the " +
        "cost and half the latency. The workers and the synthesiser " +
        "stay on " + producing + ", because those write the answer.",
    },
    {
      direction: "out",
      iteration: 1,
      actor: "app",
      because: "this pattern plans the subtasks before dispatching them",
    },
  );
}

function logPlanResponse(
  log: Logger,
  planResponse: Anthropic.Message,
  planElapsed: number,
  planUsage: UsageSummary,
  plan: Plan | undefined,
): void {
  log.api(
    `${planUsage.totalInput} in / ${planUsage.output} out · ` +
      `${formatCost(planUsage.cost)} · ${planElapsed}ms`,
    {
      iteration: 1,
      elapsed_ms: planElapsed,
      estimated_cost: formatCost(planUsage.cost),
      // The parsed plan, as an object rather than as text. This is
      // the row to expand when a question gets split oddly.
      plan: plan ?? "(nothing parsed)",
      response: {
        model: planResponse.model,
        stop_reason: planResponse.stop_reason,
        usage: planResponse.usage,
      },
    },
    {
      direction: "in",
      iteration: 1,
      actor: "claude",
      because: "the planner returned a structured plan",
    },
  );
}

function logNoSubtasks(log: Logger, plan: Plan | undefined): void {
  log.error(
    "The planner returned no subtasks",
    {
      parsed: plan ?? null,
      note:
        "Nothing to dispatch. Falling back to answering the question " +
        "directly, which costs one more request than a single call " +
        "would have — the planning call is already paid for.",
    },
    {
      iteration: 1,
      actor: "claude",
      because: "the plan contained an empty subtask list",
    },
  );
}

function logSubtasksCapped(log: Logger, plan: Plan | undefined): void {
  log.warn(
    `Planner produced ${plan?.subtasks.length} subtasks — capped at ${MAX_SUBTASKS}`,
    {
      note:
        "Each subtask is a billed request. The schema asks for at " +
        "most five and the cap enforces it, because a schema " +
        "describes a shape and cannot enforce a count.",
    },
    {
      iteration: 1,
      actor: "app",
      because: "the plan exceeded the subtask limit",
    },
  );
}

function logPlan(
  log: Logger,
  plan: Plan | undefined,
  subtasks: Plan["subtasks"],
): void {
  log.info(
    `Plan: ${subtasks.length} subtask(s) — ` +
      subtasks.map((t) => t.title).join(", "),
    {
      reasoning: plan?.reasoning,
      subtasks: subtasks.map((t, i) => ({
        n: i + 1,
        title: t.title,
        question: t.question,
      })),
    },
    {
      iteration: 1,
      actor: "claude",
      because: "the planner decided how to divide the work",
    },
  );
}

function logWorkerRequest(
  log: Logger,
  subtasks: Plan["subtasks"],
  workerRequest: Anthropic.MessageCreateParams,
  i: number,
  subtask: Plan["subtasks"][number],
): void {
  log.api(
    `Worker ${i + 1}: ${subtask.title}`,
    {
      request: workerRequest,
      note:
        "The worker sees only this question — no conversation, no " +
        "sibling subtasks. That isolation is why they can run at " +
        "once, and why the planner had to write it self-contained.",
    },
    {
      direction: "out",
      iteration: 2,
      actor: "app",
      because: `subtask ${i + 1} of ${subtasks.length}`,
    },
  );
}

function logWorkerResponse(
  log: Logger,
  response: Anthropic.Message,
  elapsedMs: number,
  text: string,
  usage: UsageSummary,
  i: number,
  subtask: Plan["subtasks"][number],
): void {
  log.api(
    `Worker ${i + 1} · ${usage.totalInput} in / ${usage.output} out · ` +
      `${formatCost(usage.cost)} · ${elapsedMs}ms`,
    {
      iteration: 2,
      subtask: subtask.title,
      elapsed_ms: elapsedMs,
      estimated_cost: formatCost(usage.cost),
      question: subtask.question,
      answer: text,
      response: {
        model: response.model,
        stop_reason: response.stop_reason,
        usage: response.usage,
      },
    },
    {
      direction: "in",
      iteration: 2,
      actor: "claude",
      because: `worker ${i + 1} finished its subtask`,
    },
  );
}

function logWorkerTruncated(
  log: Logger,
  usage: UsageSummary,
  i: number,
  subtask: Plan["subtasks"][number],
): void {
  log.error(
    `Worker ${i + 1} was truncated at ${WORKER_MAX_TOKENS} tokens`,
    {
      subtask: subtask.title,
      max_tokens: WORKER_MAX_TOKENS,
      output_tokens: usage.output,
      note:
        "Its answer is cut off mid-sentence and will be merged " +
        "as-is. The merged answer will look complete and will " +
        "be missing whatever this worker was about to say.",
    },
    {
      iteration: 2,
      actor: "claude",
      because: "the worker reached max_tokens before finishing",
    },
  );
}

function logWorkerFailed(
  log: Logger,
  message: string,
  i: number,
  subtask: Plan["subtasks"][number],
): void {
  log.error(
    `Worker ${i + 1} failed: ${message.slice(0, 48)}`,
    { subtask: subtask.title, error: message },
    {
      iteration: 2,
      actor: "app",
      because: "this worker's request threw",
    },
  );
}

function logWorkersFinished(
  log: Logger,
  workers: WorkerResult[],
  workersElapsed: number,
  sequentialWouldBe: number,
  succeeded: WorkerResult[],
): void {
  log.info(
    `${workers.length} worker(s) finished in ${workersElapsed}ms ` +
      `(${sequentialWouldBe}ms in sequence)`,
    {
      wall_clock_ms: workersElapsed,
      sum_of_workers_ms: sequentialWouldBe,
      saved_ms: sequentialWouldBe - workersElapsed,
      succeeded: succeeded.length,
      failed: workers.length - succeeded.length,
    },
    {
      iteration: 2,
      actor: "app",
      because: "every worker has returned or failed",
    },
  );
}

function logSynthRequest(
  log: Logger,
  succeeded: WorkerResult[],
  synthRequest: Anthropic.MessageCreateParams,
): void {
  log.api(
    `Synthesising ${succeeded.length} answer(s)`,
    {
      request: synthRequest,
      note:
        "The largest request of the run: its input carries every " +
        "worker's answer. Dividing the work does not divide the tokens.",
    },
    {
      direction: "out",
      iteration: 3,
      actor: "app",
      because: "the workers are done and their answers need merging",
    },
  );
}

function logSynthResponse(
  log: Logger,
  text: string,
  synthResponse: Anthropic.Message,
  synthElapsed: number,
  synthUsage: UsageSummary,
): void {
  log.api(
    `${synthUsage.totalInput} in / ${synthUsage.output} out · ` +
      `${formatCost(synthUsage.cost)} · ${synthElapsed}ms · ` +
      `${synthResponse.stop_reason} · ${snippet(text)}`,
    {
      iteration: 3,
      elapsed_ms: synthElapsed,
      estimated_cost: formatCost(synthUsage.cost),
      // What caching did, in words. The raw cache_read and
      // cache_write numbers are the ones in the documentation, but
      // they do not say which of three states this request was in,
      // and the three look similar until you know what to compare.
      caching: {
        hit_rate: `${Math.round(synthUsage.cacheHitRate * 100)}%`,
        read_from_cache: synthUsage.cacheRead,
        written_to_cache: synthUsage.cacheWrite,
        fresh: synthUsage.input,
        what_happened: describeCacheOutcome(synthUsage),
      },
      response: {
        model: synthResponse.model,
        stop_reason: synthResponse.stop_reason,
        usage: synthResponse.usage,
      },
    },
    {
      direction: "in",
      iteration: 3,
      actor: "claude",
      because: "the synthesis call returned the merged answer",
    },
  );
}

function logOrchestratorSummary(
  log: Logger,
  producing: string,
  deciding: string,
  totalCost: number,
  planUsage: UsageSummary,
  workers: WorkerResult[],
  workersElapsed: number,
  sequentialWouldBe: number,
  synthUsage: UsageSummary,
  requests: number,
): void {
  log.info(
    `Orchestrator complete · ${requests} requests · ${formatCost(totalCost)}`,
    {
      requests,
      planner_model: deciding,
      worker_model: producing,
      plan_cost: formatCost(planUsage.cost),
      worker_cost: formatCost(
        workers.reduce((n, w) => n + w.cost, 0),
      ),
      synthesis_cost: formatCost(synthUsage.cost),
      total_cost: totalCost,
      wall_clock_saved_ms: sequentialWouldBe - workersElapsed,
      note:
        "The most expensive pattern here. Worth it when a question has " +
        "genuinely separable parts and someone is waiting; wasteful " +
        "when it does not, which the plan above will show.",
    },
    {
      iteration: 3,
      actor: "app",
      because: "every stage has completed",
    },
  );
}
