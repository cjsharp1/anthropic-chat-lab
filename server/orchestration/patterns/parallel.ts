/**
 * parallel.ts — three calls at once, then one to merge them.
 *
 * The question is sent three times with different instructions: what it
 * is, how to use it, and what to watch out for. Those run concurrently,
 * and a fourth call stitches the answers into one.
 *
 * ---------------------------------------------------------------------------
 * Why fan out
 * ---------------------------------------------------------------------------
 *
 * Two reasons, and they are different enough to be worth separating.
 *
 * The first is latency. Three calls taking five seconds each finish in
 * five seconds rather than fifteen, because nothing waits for anything
 * else. That saving is real and it is the easiest to see — watch the
 * elapsed times in the log and compare the sum with the total.
 *
 * The second is quality, and it is less certain. A model answering
 * "explain prompt caching" has to decide how much of its answer is
 * mechanism, how much is practical advice, and how much is pitfalls —
 * while writing. Giving each aspect its own call means each gets the
 * model's full attention, and none is squeezed out because the answer
 * was already getting long.
 *
 * ---------------------------------------------------------------------------
 * What it costs
 * ---------------------------------------------------------------------------
 *
 * Four requests for one question, and the input is paid for four
 * times. Worse, the synthesis call's input includes all three branch
 * answers, so it is substantially larger than any of them.
 *
 * This is the most expensive pattern so far and the saving is in time,
 * not money. Whether that trade is worth it depends entirely on
 * whether anyone is waiting.
 *
 * ---------------------------------------------------------------------------
 * The fixed aspects
 * ---------------------------------------------------------------------------
 *
 * The three aspects below are hard-coded rather than chosen per
 * question, which is a deliberate simplification. Deciding the
 * aspects dynamically means an extra call before the fan-out, and
 * that is what the orchestrator pattern (step 53) does. Here the
 * split is fixed so the mechanism is visible without a planner
 * obscuring it.
 *
 * The cost of fixing them is visible too: ask a question where one
 * aspect does not apply and watch that branch produce something
 * padded or irrelevant. That failure is worth seeing.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { client, MAX_TOKENS } from "../../anthropic.js";
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

/** Each branch is capped: three long answers would overwhelm the merge. */
const BRANCH_MAX_TOKENS = 1200;

/** One branch of the fan-out. */
interface Aspect {
  id: string;
  name: string;
  system: string;
}

const ASPECTS: Aspect[] = [
  {
    id: "mechanism",
    name: "Mechanism",
    system: `Answer only the question of WHAT this is and HOW it works.

- Explain the actual mechanism, not the surrounding advice.
- Name the real fields, values and types involved.
- Do not cover when to use it or what goes wrong — another writer is handling those.
- Six sentences at most. No headings, no preamble.`,
  },
  {
    id: "practice",
    name: "In practice",
    system: `Answer only the question of HOW SOMEONE USES this.

- Give the concrete steps or the shape of the code.
- Say what a realistic case looks like.
- Do not explain the underlying mechanism or list pitfalls — other writers are covering those.
- Six sentences at most. No headings, no preamble.`,
  },
  {
    id: "pitfalls",
    name: "Pitfalls",
    system: `Answer only the question of WHAT GOES WRONG with this.

- Name the mistakes people actually make, and the symptom each produces.
- Include anything that fails silently, which is the most valuable kind.
- Do not explain the mechanism or give a tutorial — other writers are covering those.
- Six sentences at most. No headings, no preamble.`,
  },
];

/** What one branch produced. */
interface BranchResult {
  aspect: Aspect;
  text: string;
  cost: number;
  elapsedMs: number;
  failed: boolean;
}

export const parallel: Pattern = {
  id: "parallel",
  name: "Parallelisation",

  description:
    "Sends the question three times at once — mechanism, practice, " +
    "pitfalls — then merges the answers. Four requests, but the three " +
    "branches take as long as the slowest rather than the sum.",

  typicalRequests: "4",

  whenToUse:
    "Broad questions where several angles all matter and someone is " +
    "waiting. The saving is latency, not money. Wrong when the three " +
    "fixed aspects do not suit the question — watch a branch pad when " +
    "its aspect does not apply.",

  measuredCost:
    "4 requests, $0.0672. The branches took 8.6 seconds of wall clock " +
    "for 21.9 seconds of work, so the latency saving is real; the " +
    "token cost is roughly four times a single call.",

  // Three branches and a merge, all writing. The split is fixed, so nothing is decided at run time.
  usesRoles: ["producing"],

  examples: [
    {
      prompt: "Explain prompt caching.",
      watch:
        "Three branches start together and finish out of order. The " +
        "summary row compares the wall clock with the sum — measured at " +
        "8.6 seconds for 21.9 seconds of work.",
      kind: "good-fit",
    },
    {
      prompt: "What is the exact model id for Claude Opus 5.5?",
      watch:
        "A one-fact question split three ways. Expand each branch and " +
        "watch two of them pad, because the fixed aspects do not fit. " +
        "Four requests for something a single call answers in one.",
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

    // Say so rather than discarding them silently — see no-tools.ts.
    const serverTools = warnToolsIgnored(
      tools,
      "Parallelisation",
      "Each branch is a single call, and the merge is a single call. " +
        "None of them can handle a tool_use response.",
      log,
    );

    let totalCost = 0;

    logFanOutStart(log);

    const fanOutStarted = Date.now();

    // --- The fan-out ---------------------------------------------------------
    //
    // Promise.all, and each branch catches its own failures. A rejection
    // here would abandon the other two branches' results — the same
    // reasoning as runOneTool in the tool loop, for the same reason:
    // Promise.all rejects as soon as any one promise does.
    const branches = await Promise.all(
      ASPECTS.map(async (aspect): Promise<BranchResult> => {
        const started = Date.now();

        const branchRequest = {
          model: producing,
          max_tokens: BRANCH_MAX_TOKENS,
          system: aspect.system,
          // Server tools go on each branch, the call that produces what
          // the user reads. A planner or classifier has no business
          // searching the web — it would research something it is
          // about to throw away.
          ...(serverTools ? { tools: serverTools } : {}),
          messages,
          // Thinking is always on; this decides whether its
          // summary comes back readable. See server/thinking.ts.
          thinking: { type: "adaptive" as const, display: thinkingDisplay },
          output_config: { effort },
        };

        logBranchRequest(log, branchRequest, aspect);

        try {
          // .create(), not .stream(). Three streams arriving at once
          // would interleave into nonsense in the transcript, and none
          // of this text is what the user finally reads anyway.
          const response = await client.messages.create(branchRequest);

          const elapsedMs = Date.now() - started;

          const text = response.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("")
            .trim();

          const usage = summariseUsage(response.usage, response.model);

          logBranchResponse(log, response, elapsedMs, text, usage, aspect);

          return { aspect, text, cost: usage.cost, elapsedMs, failed: false };
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);

          logBranchFailed(log, message, aspect);

          return {
            aspect,
            text: "",
            cost: 0,
            elapsedMs: Date.now() - started,
            failed: true,
          };
        }
      }),
    );

    const fanOutElapsed = Date.now() - fanOutStarted;
    const sequentialWouldBe = branches.reduce((n, b) => n + b.elapsedMs, 0);

    for (const branch of branches) totalCost += branch.cost;

    const succeeded = branches.filter((b) => !b.failed && b.text);

    logFanOutEnd(log, branches, fanOutElapsed, sequentialWouldBe);

    // Every branch failing is worth stopping for: the synthesis call
    // would have nothing to merge and would answer from scratch, which
    // is a single call wearing a disguise and billed as four.
    if (succeeded.length === 0) {
      logAllBranchesFailed(log);

      return {
        text:
          "Every branch of the parallel pattern failed. See the activity " +
          "log for what went wrong.",
        cost: totalCost,
        requests: ASPECTS.length,
      };
    }

    // --- The merge -----------------------------------------------------------
    //
    // The branch answers go into the synthesis call's system prompt, in
    // the same way and for the same reason as the plan in the chaining
    // pattern: nobody said them, so they are not part of the dialogue.

    const synthesisSystem = [
      system,
      "Three writers have each answered one aspect of the user's question. " +
        "Merge their work into a single answer.",
      "",
      ...succeeded.map((b) => `## ${b.aspect.name}\n\n${b.text}`),
      "",
      "Write one coherent answer. Remove the repetition between them, keep " +
        "the order that reads best, and do not mention that there were " +
        "three sources or reproduce these headings.",
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

    const mergeRequest = {
      model: producing,
      max_tokens: MAX_TOKENS,
      system: withCachedSystem(synthesisSystem),
      messages: withCachedHistory(messages, cacheMode),
      // Thinking is always on; this decides whether its
      // summary comes back readable. See server/thinking.ts.
      thinking: { type: "adaptive" as const, display: thinkingDisplay },
      output_config: { effort },
    };

    logMergeRequest(log, succeeded, mergeRequest);

    const mergeStarted = Date.now();

    const stream = client.messages.stream(mergeRequest);

    stream.on("text", (fragment: string) => emitText(fragment));

    const mergeResponse = await stream.finalMessage();

    // The reasoning summary, if one came back. Empty under the
    // default display setting: the blocks arrive either way,
    // but with no text in them.
    const thinkingSummary = mergeResponse.content
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking)
      .join("")
      .trim();
    if (thinkingSummary) emitThinking(thinkingSummary);

    const mergeElapsed = Date.now() - mergeStarted;

    const text = mergeResponse.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    const mergeUsage = summariseUsage(mergeResponse.usage, mergeResponse.model);
    totalCost += mergeUsage.cost;

    logMergeResponse(log, text, mergeResponse, mergeElapsed, mergeUsage);

    const requests = ASPECTS.length + 1;

    logParallelSummary(
      log,
      totalCost,
      fanOutElapsed,
      sequentialWouldBe,
      mergeUsage,
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

function logFanOutStart(log: Logger): void {
  log.info(
    `Fanning out to ${ASPECTS.length} branches`,
    {
      aspects: ASPECTS.map((a) => ({ id: a.id, name: a.name })),
      note:
        "All three start at once. Compare the sum of their elapsed " +
        "times with the wall-clock total below — the difference is " +
        "what concurrency bought.",
    },
    {
      iteration: 1,
      actor: "app",
      because: "this pattern splits every question into three aspects",
    },
  );
}

function logBranchRequest(
  log: Logger,
  branchRequest: Anthropic.MessageCreateParams,
  aspect: Aspect,
): void {
  log.api(
    `Branch: ${aspect.name}`,
    { request: branchRequest },
    {
      direction: "out",
      iteration: 1,
      actor: "app",
      because: `the ${aspect.id} branch of the fan-out`,
    },
  );
}

function logBranchResponse(
  log: Logger,
  response: Anthropic.Message,
  elapsedMs: number,
  text: string,
  usage: UsageSummary,
  aspect: Aspect,
): void {
  log.api(
    `${aspect.name} · ${usage.totalInput} in / ${usage.output} out · ` +
      `${formatCost(usage.cost)} · ${elapsedMs}ms`,
    {
      iteration: 1,
      aspect: aspect.id,
      elapsed_ms: elapsedMs,
      estimated_cost: formatCost(usage.cost),
      // The branch's own answer, which the user never sees in
      // this form. When a merged answer comes out lopsided,
      // this is where to look.
      branch_text: text,
      response: {
        model: response.model,
        stop_reason: response.stop_reason,
        usage: response.usage,
      },
    },
    {
      direction: "in",
      iteration: 1,
      actor: "claude",
      because: `the ${aspect.id} branch returned`,
    },
  );
}

function logBranchFailed(log: Logger, message: string, aspect: Aspect): void {
  log.error(
    `Branch ${aspect.name} failed: ${message.slice(0, 50)}`,
    {
      aspect: aspect.id,
      error: message,
      note:
        "The other branches continue. A fan-out that abandoned " +
        "everything because one branch failed would be more " +
        "fragile than a single call, which defeats the point.",
    },
    {
      iteration: 1,
      actor: "app",
      because: "this branch's request threw",
    },
  );
}

function logFanOutEnd(
  log: Logger,
  branches: BranchResult[],
  fanOutElapsed: number,
  sequentialWouldBe: number,
): void {
  log.info(
    `All branches finished in ${fanOutElapsed}ms ` +
      `(${sequentialWouldBe}ms if run in sequence)`,
    {
      wall_clock_ms: fanOutElapsed,
      sum_of_branches_ms: sequentialWouldBe,
      saved_ms: sequentialWouldBe - fanOutElapsed,
      per_branch: branches.map((b) => ({
        aspect: b.aspect.id,
        ms: b.elapsedMs,
        failed: b.failed,
      })),
      note:
        "The wall clock is the slowest branch, not the sum. That " +
        "difference is the entire argument for this pattern — the " +
        "cost is four requests either way.",
    },
    {
      iteration: 1,
      actor: "app",
      because: "every branch has returned or failed",
    },
  );
}

function logAllBranchesFailed(log: Logger): void {
  log.error(
    "Every branch failed — nothing to merge",
    {
      note:
        "Returning without a synthesis call. Merging nothing would " +
        "produce an answer that looks normal but cost four requests " +
        "to not use any of them.",
    },
    {
      iteration: 1,
      actor: "app",
      because: "no branch produced any text",
    },
  );
}

function logMergeRequest(
  log: Logger,
  succeeded: BranchResult[],
  mergeRequest: Anthropic.MessageCreateParams,
): void {
  log.api(
    `Merging ${succeeded.length} branch(es)`,
    {
      request: mergeRequest,
      note:
        "This call's input contains all three branch answers, which is " +
        "why it is the largest request of the four. The fan-out saves " +
        "time; it does not save tokens.",
    },
    {
      direction: "out",
      iteration: 2,
      actor: "app",
      because: "the branches are complete and their answers need merging",
    },
  );
}

function logMergeResponse(
  log: Logger,
  text: string,
  mergeResponse: Anthropic.Message,
  mergeElapsed: number,
  mergeUsage: UsageSummary,
): void {
  log.api(
    `${mergeUsage.totalInput} in / ${mergeUsage.output} out · ` +
      `${formatCost(mergeUsage.cost)} · ${mergeElapsed}ms · ` +
      `${mergeResponse.stop_reason} · ${snippet(text)}`,
    {
      iteration: 2,
      elapsed_ms: mergeElapsed,
      estimated_cost: formatCost(mergeUsage.cost),
      // What caching did, in words. The raw cache_read and
      // cache_write numbers are the ones in the documentation, but
      // they do not say which of three states this request was in,
      // and the three look similar until you know what to compare.
      caching: {
        hit_rate: `${Math.round(mergeUsage.cacheHitRate * 100)}%`,
        read_from_cache: mergeUsage.cacheRead,
        written_to_cache: mergeUsage.cacheWrite,
        fresh: mergeUsage.input,
        what_happened: describeCacheOutcome(mergeUsage),
      },
      response: {
        model: mergeResponse.model,
        stop_reason: mergeResponse.stop_reason,
        usage: mergeResponse.usage,
      },
    },
    {
      direction: "in",
      iteration: 2,
      actor: "claude",
      because: "the synthesis call returned the merged answer",
    },
  );
}

function logParallelSummary(
  log: Logger,
  totalCost: number,
  fanOutElapsed: number,
  sequentialWouldBe: number,
  mergeUsage: UsageSummary,
  requests: number,
): void {
  log.info(
    `Parallel complete · ${requests} requests · ${formatCost(totalCost)} · ` +
      `saved ${sequentialWouldBe - fanOutElapsed}ms`,
    {
      requests,
      branch_cost: formatCost(totalCost - mergeUsage.cost),
      merge_cost: formatCost(mergeUsage.cost),
      total_cost: totalCost,
      wall_clock_saved_ms: sequentialWouldBe - fanOutElapsed,
      note:
        "Four requests for one question. Compare with Single call: " +
        "this pattern buys latency and breadth, and pays for it in " +
        "tokens. Whether that is a good trade depends on whether " +
        "anyone is waiting.",
    },
    {
      iteration: 2,
      actor: "app",
      because: "the merge has completed",
    },
  );
}
