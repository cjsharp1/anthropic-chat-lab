/**
 * chaining.ts — two calls, where the second builds on the first.
 *
 * Call one produces an outline. Call two writes the answer from that
 * outline. The user sees only the second.
 *
 * ---------------------------------------------------------------------------
 * Why split a task across two calls
 * ---------------------------------------------------------------------------
 *
 * A model writing a long answer is doing two jobs at once: deciding
 * what to say, and saying it. Both happen token by token, which means
 * the structure of the answer is being invented while it is already
 * being written. By the time it notices that point three should have
 * come first, point one is finished and cannot be revised.
 *
 * Chaining separates the jobs. The first call thinks about structure
 * with nothing else to do; the second writes against a plan that is
 * already complete. The usual result is better organisation on
 * anything long enough to need organising.
 *
 * ---------------------------------------------------------------------------
 * When it is not worth it
 * ---------------------------------------------------------------------------
 *
 * It costs twice as many requests and roughly twice the latency, and
 * on a short factual question it buys nothing at all — planning "what
 * is 7 times 6" is pure overhead. That is the trade worth measuring:
 * run the same question through Single call and through this, and look
 * at whether the answer is actually better for the money.
 *
 * It also cannot stream honestly. The first call's output is scaffolding
 * the user should never see, so nothing can be shown until the second
 * call begins. A pattern that takes twice as long AND shows nothing for
 * the first half is a real UX cost, not a theoretical one.
 *
 * ---------------------------------------------------------------------------
 * Where the plan goes
 * ---------------------------------------------------------------------------
 *
 * Note that the outline is passed to the second call inside its system
 * prompt, not appended to the conversation. Putting it in `messages`
 * would make it part of the dialogue — Claude would see itself having
 * said it, and the user's next turn would arrive after a message they
 * never saw. The system prompt is the right place for instructions
 * about how to answer, which is exactly what a plan is.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { apiModelId, getClient, MAX_TOKENS } from "../../anthropic.js";
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
  snippet,
  summariseUsage,
  type UsageSummary,
} from "../../usage.js";
import type { Pattern, PatternContext, PatternResult } from "../types.js";
import type { Logger } from "../../logger.js";

/** Caps the planning call. An outline that long is not an outline. */
const PLAN_MAX_TOKENS = 1000;

/**
 * The instructions for the planning call.
 *
 * Deliberately insistent about brevity. Left to itself the model will
 * start answering the question in the outline, which defeats the point
 * — and doubles the cost, since the same content is then produced
 * twice.
 */
const PLANNER_SYSTEM = `You are planning an answer that someone else will write.

Produce a short outline only:

- Three to six bullet points, each one line.
- Say WHAT each section should cover, not what it should say.
- Note anything the writer should be careful to get right or avoid.
- If the question is simple enough to answer in a sentence, say exactly that and nothing else.

Do not answer the question. Do not write prose. The outline is scaffolding and will be thrown away.`;

export const chaining: Pattern = {
  id: "chaining",
  name: "Prompt chaining",

  description:
    "Two calls: the first plans the answer, the second writes it from " +
    "that plan. Better structure on anything long; pure overhead on a " +
    "short factual question.",

  typicalRequests: "2",

  whenToUse:
    "Long answers that need structure — a comparison, a walkthrough, " +
    "anything with several parts that should be ordered deliberately. " +
    "Measurably wasteful on short factual questions: the planner itself " +
    "will tell you so, and the app flags it when that happens.",

  measuredCost:
    "2 requests, $0.0290. On a one-line factual question it was measured " +
    "at $0.0167 against $0.0020 for a single call — eight times the " +
    "cost and four times the latency for an answer nobody needed " +
    "planned.",

  // The planner produces an outline the user never sees; the writer produces the answer.
  usesRoles: ["deciding", "producing"],

  examples: [
    {
      prompt:
        "Compare prompt caching, the Batch API and streaming: how each " +
        "works, what each saves, and when to use which.",
      watch:
        "Expand the planning row to read the outline Claude wrote for " +
        "itself. The answer that follows should track it section by " +
        "section.",
      kind: "good-fit",
    },
    {
      prompt: "What does stop_reason max_tokens mean?",
      watch:
        "The planner replies that this is simple enough to answer in a " +
        "sentence, and the app flags it. Measured at eight times the " +
        "cost of a single call for the same answer.",
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
      "Prompt chaining",
      "Both calls are single calls. Handling a tool_use response " +
        "needs the loop that the Tool loop pattern provides.",
      log,
    );

    let totalCost = 0;

    // --- Call one: plan ------------------------------------------------------
    //
    // The whole conversation goes up, not just the latest question: a
    // follow-up like "now do the same for Haiku" is meaningless without
    // what came before.

    const planRequest = {
      // The deciding model: an outline is a structured decision the
      // user never sees, not prose. This was on the main model until
      // the orchestrator's planner was measured against Haiku and
      // found no worse — the same reasoning applies here.
      model: apiModelId(deciding),
      max_tokens: PLAN_MAX_TOKENS,
      system: PLANNER_SYSTEM,
      messages,
      // Thinking is always on; this decides whether its
      // summary comes back readable. See server/thinking.ts.
      thinking: { type: "adaptive" as const, display: thinkingDisplay },
      output_config: { effort },
    };

    logPlanRequest(log, planRequest, messages);

    const planStarted = Date.now();

    // .create() rather than .stream(), because nothing here is shown to
    // the user. Streaming exists to fill a wait with something readable,
    // and this output is scaffolding they should never see.
    const planResponse = await getClient().messages.create(planRequest);

    const planElapsed = Date.now() - planStarted;

    const plan = planResponse.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    const planUsage = summariseUsage(planResponse.usage, planResponse.model);
    totalCost += planUsage.cost;

    logPlanResponse(log, planResponse, planElapsed, plan, planUsage);

    logPlanOutline(log, plan);

    // The planner is told to say so when a question needs no plan, and
    // it does. Flag it rather than quietly proceeding: on a one-line
    // factual question this pattern was measured at eight times the
    // cost and four times the latency of a single call, for a longer
    // answer than was asked for.
    //
    // Flagged rather than short-circuited on purpose. Silently falling
    // back to one call would make the pattern cheaper and teach
    // nothing — the point of selecting it is to see what it does,
    // including when that is the wrong choice.
    if (/simple enough to answer in a sentence/i.test(plan)) {
      logPlanNotNeeded(log, plan);
    }

    // --- Call two: write -----------------------------------------------------
    //
    // The plan is folded into the system prompt. The user's own system
    // prompt is kept, because it governs tone and the plan governs
    // structure; dropping it would make the chained answer sound
    // different from an unchained one for no reason.

    const writerSystem = [
      system,
      `You are writing an answer. Another model has already outlined it:`,
      "",
      plan,
      "",
      "Follow that outline. Do not mention it, do not restate it as a " +
        "heading list, and do not explain that you are following a plan. " +
        "Write the answer itself.",
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

    const writeRequest = {
      model: apiModelId(producing),
      max_tokens: MAX_TOKENS,
      system: withCachedSystem(writerSystem),
      // Server tools go on the writing call, the call that produces what
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

    logWriteRequest(log, writerSystem, writeRequest, messages, system);

    const writeStarted = Date.now();

    // Streaming here, because this IS what the user sees.
    const stream = getClient().messages.stream(writeRequest);

    stream.on("text", (fragment: string) => emitText(fragment));

    const writeResponse = await stream.finalMessage();

    // The reasoning summary, if one came back. Empty under the
    // default display setting: the blocks arrive either way,
    // but with no text in them.
    const thinkingSummary = writeResponse.content
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking)
      .join("")
      .trim();
    if (thinkingSummary) emitThinking(thinkingSummary);

    const writeElapsed = Date.now() - writeStarted;

    const text = writeResponse.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    const writeUsage = summariseUsage(writeResponse.usage, writeResponse.model);
    totalCost += writeUsage.cost;

    logWriteResponse(log, writeResponse, writeElapsed, text, writeUsage);

    if (writeResponse.stop_reason === "max_tokens") {
      logTruncated(log, writeUsage);
    }

    logChainSummary(log, totalCost, planUsage, writeUsage);

    return { text, cost: totalCost, requests: 2 };
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
  planRequest: Anthropic.MessageCreateParams,
  messages: Anthropic.MessageParam[],
): void {
  log.api(
    `Planning call · ${messages.length} message(s)`,
    {
      request: planRequest,
      note:
        "Tools are deliberately not offered on this call. The planner " +
        "decides structure; running a tool is the writer's job, and a " +
        "tool result fetched here would be thrown away with the outline.",
    },
    {
      direction: "out",
      iteration: 1,
      actor: "app",
      because: "this pattern plans before it writes",
    },
  );
}

function logPlanResponse(
  log: Logger,
  planResponse: Anthropic.Message,
  planElapsed: number,
  plan: string,
  planUsage: UsageSummary,
): void {
  log.api(
    `${planUsage.totalInput} in / ${planUsage.output} out · ` +
      `${formatCost(planUsage.cost)} · ${planElapsed}ms`,
    {
      iteration: 1,
      elapsed_ms: planElapsed,
      estimated_cost: formatCost(planUsage.cost),
      // The plan itself, which the user never sees. Worth logging in
      // full: when a chained answer comes out badly structured, the
      // outline is where to look, and without this it is invisible.
      plan,
      response: {
        id: planResponse.id,
        model: planResponse.model,
        stop_reason: planResponse.stop_reason,
        usage: planResponse.usage,
      },
    },
    {
      direction: "in",
      iteration: 1,
      actor: "claude",
      because: "the planning call returned an outline",
    },
  );
}

function logPlanOutline(log: Logger, plan: string): void {
  log.info(
    `Plan: ${plan.split("\n").filter((line) => line.trim()).length} line(s)`,
    { plan },
    {
      iteration: 1,
      actor: "app",
      because:
        "the outline goes into the next call's system prompt, not into " +
        "the conversation — the user never said it and should not see it",
    },
  );
}

// warn, not error: the chain completes and returns a good answer — it simply cost more than it needed to.
function logPlanNotNeeded(log: Logger, plan: string): void {
  log.warn(
    "The planner says this question did not need a plan",
    {
      plan,
      note:
        "Chaining costs two requests whatever the question. On " +
        "something this short the planning call is pure overhead — " +
        "switch to Single call and compare the cost.",
    },
    {
      iteration: 1,
      actor: "claude",
      because: "the outline reports that the question is trivial",
    },
  );
}

function logWriteRequest(
  log: Logger,
  writerSystem: string,
  writeRequest: Anthropic.MessageCreateParams,
  messages: Anthropic.MessageParam[],
  system: string | null,
): void {
  log.api(
    `Writing call · ${messages.length} message(s) · ` +
      `system grew to ${writerSystem.length} chars`,
    {
      // Worth comparing against the tool loop, where request 2 carries
      // THREE messages. Here it carries one, the same as request 1.
      //
      // The difference is where the new information went. A tool
      // result is part of the dialogue — the API requires the
      // tool_use block and its tool_result to appear as paired turns
      // in `messages`. A plan is not something anyone said, so it
      // goes into `system` instead, and the conversation is unchanged.
      //
      // Same number of requests, two completely different shapes.
      what_changed: {
        messages: `${messages.length} — unchanged from the planning call`,
        system_before: `${(system ?? "").length} chars`,
        system_after: `${writerSystem.length} chars`,
        note:
          "The plan was folded into the system prompt, not appended to " +
          "the conversation. Contrast the Tool loop pattern, where " +
          "request 2 carries two extra messages.",
      },
      request: writeRequest,
    },
    {
      direction: "out",
      iteration: 2,
      actor: "app",
      because: "the plan is ready, so the answer can now be written",
    },
  );
}

function logWriteResponse(
  log: Logger,
  writeResponse: Anthropic.Message,
  writeElapsed: number,
  text: string,
  writeUsage: UsageSummary,
): void {
  log.api(
    `${writeUsage.totalInput} in / ${writeUsage.output} out · ` +
      `${formatCost(writeUsage.cost)} · ${writeElapsed}ms · ` +
      `${writeResponse.stop_reason} · ${snippet(text)}`,
    {
      iteration: 2,
      elapsed_ms: writeElapsed,
      estimated_cost: formatCost(writeUsage.cost),
      // What caching did, in words. The raw cache_read and
      // cache_write numbers are the ones in the documentation, but
      // they do not say which of three states this request was in,
      // and the three look similar until you know what to compare.
      caching: {
        hit_rate: `${Math.round(writeUsage.cacheHitRate * 100)}%`,
        read_from_cache: writeUsage.cacheRead,
        written_to_cache: writeUsage.cacheWrite,
        fresh: writeUsage.input,
        what_happened: describeCacheOutcome(writeUsage),
      },
      response: {
        id: writeResponse.id,
        model: writeResponse.model,
        stop_reason: writeResponse.stop_reason,
        usage: writeResponse.usage,
      },
    },
    {
      direction: "in",
      iteration: 2,
      actor: "claude",
      because: "the writing call returned the answer",
    },
  );
}

function logTruncated(log: Logger, writeUsage: UsageSummary): void {
  log.error(
    "Reply was truncated: it hit the max_tokens ceiling.",
    { max_tokens: MAX_TOKENS, output_tokens: writeUsage.output },
    {
      iteration: 2,
      actor: "claude",
      because: "the reply reached max_tokens before finishing",
    },
  );
}

// The comparison worth making. Two calls means the input was paid
// for twice, and the planning output was paid for and discarded.
function logChainSummary(
  log: Logger,
  totalCost: number,
  planUsage: UsageSummary,
  writeUsage: UsageSummary,
): void {
  log.info(
    `Chain complete · 2 requests · ${formatCost(totalCost)}`,
    {
      plan_cost: formatCost(planUsage.cost),
      write_cost: formatCost(writeUsage.cost),
      total_cost: totalCost,
      note:
        "Ask the same question under Single call and compare. The plan " +
        "is paid for and thrown away, so this is only worth it when the " +
        "answer is visibly better organised for it.",
    },
    {
      iteration: 2,
      actor: "app",
      because: "both calls have completed",
    },
  );
}
