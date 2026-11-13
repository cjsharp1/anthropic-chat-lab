/**
 * tool-loop.ts — the agentic loop.
 *
 * Send the conversation. If Claude answers, done. If it asks for tools,
 * run them, append both turns, and send the whole conversation again.
 * Repeat until it stops asking, or until the iteration cap is reached.
 *
 * ---------------------------------------------------------------------------
 * Why this is a loop and not two calls
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation is: ask, run the tools, ask again with the
 * results, return the answer. That handles one round of tool use and
 * breaks on the second. "Search the docs, then calculate something from
 * what you found" needs three requests, and nothing bounds how many a
 * question might take.
 *
 * Each pass is a complete, independent request carrying the entire
 * conversation. There is no session and nothing is resumed. Input
 * tokens therefore climb with every iteration — visible in the activity
 * log as the message count goes 1, 3, 5 — and that growth is the real
 * cost of a long tool loop.
 *
 * ---------------------------------------------------------------------------
 * The cap
 * ---------------------------------------------------------------------------
 *
 * Every iteration is a billed request, so an unbounded loop does not
 * merely hang — it spends money until something else stops it. A model
 * that keeps asking for tools without converging is a real failure
 * mode, usually caused by a tool whose result does not answer the
 * question it was called for.
 *
 * ---------------------------------------------------------------------------
 * How this file is arranged
 * ---------------------------------------------------------------------------
 *
 * Two halves. `run` is the loop: build a request, send it, read the
 * response, stop or run the tools, append both turns, go round again.
 * Below it, under its own banner, are the functions that build the
 * activity-log rows.
 *
 * They are separated because they answer different questions. The loop
 * is what the API requires; the rows are how this app explains it. When
 * the two were interleaved the five steps were spread across 560 lines
 * and one log call ran to 96 of them, so the thing the file exists to
 * teach was the hardest thing in it to see.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { client, MAX_TOKENS } from "../../anthropic.js";
import { runOneTool } from "../tool-runner.js";
import { logServerToolActivity } from "../../tools/server-tool-log.js";
import { serverToolCounts } from "../../tools/server-tools.js";
import {
  describeCachePlan,
  withCachedHistory,
  withCachedSystem,
  withCachedTools,
  type CachePlan,
} from "../../caching.js";
import {
  CacheTally,
  formatCost,
  snippet,
  summariseUsage,
  type UsageSummary,
} from "../../usage.js";
import { thinkingConfig } from "../../thinking.js";
import { withEffort } from "../../effort.js";
import type { Pattern, PatternContext, PatternResult } from "../types.js";
import type { Logger } from "../../logger.js";

/**
 * How many times the loop may go round before giving up.
 *
 * Ten is generous: most questions need one or two, and a genuinely
 * multi-step one might need four. What matters is that a limit exists.
 */
const MAX_TOOL_ITERATIONS = 10;

export const toolLoop: Pattern = {
  id: "tool-loop",
  name: "Tool loop",

  description:
    "Sends the conversation, runs whatever tools Claude asks for, and " +
    "sends the results back — repeating until it stops asking. This is " +
    "what most people mean by an agent.",

  typicalRequests: "2 to 4",

  whenToUse:
    "Any question whose answer depends on something the model cannot " +
    "know: the time, a calculation it would get wrong, a file, a " +
    "search. Also the only pattern here that can act rather than just " +
    "answer. Wasteful when no tool applies — it then costs the same as " +
    "a single call plus the tool definitions in every request.",

  measuredCost:
    "2 requests and $0.0097 for one tool call; 3 requests and $0.02 for " +
    "a two-step chain. The tool definitions add roughly 2,000 input " +
    "tokens to every request, whether or not a tool is used.",

  // Every call in the loop writes toward the answer. The model decides whether to use a tool, but that is part of answering rather than a separate classification step.
  usesRoles: ["producing"],

  examples: [
    {
      prompt:
        "Search the docs for what Opus 5.5 costs per million input " +
        "tokens, then calculate what 3.7 million would cost.",
      watch:
        "Three requests. Watch the message count go 1, 3, 5 — the whole " +
        "conversation is resent each round, which is why input tokens " +
        "climb. Enable search_docs and calculator first.",
      kind: "good-fit",
    },
    {
      prompt: "What time is it in London and in Tokyo?",
      watch:
        "Two tool calls dispatched at once, finishing out of order. The " +
        "wall clock is the slowest one, not the sum. Enable " +
        "get_current_time first.",
      kind: "good-fit",
    },
  ],

  async run(context: PatternContext): Promise<PatternResult> {
    const {
      messages,
      system,
      tools,
      toolChoice,
      log,
      emitText,
      emitThinking,
      onToolStart,
      onToolEnd,
      models,
      cacheMode,
      thinkingDisplay,
      effort,
    } = context;

    // The model that writes what the user reads.
    const producing = models.producing;

    const toolCount = tools?.length ?? 0;
    const toolChoiceLabel = toolChoice?.type ?? "auto";

    let iteration = 0;
    let finalText = "";
    let stopReason: string | null = null;

    // Accumulated across every iteration. One question answered through
    // three tool calls costs the sum of four requests, and the per-call
    // figures alone hide that.
    let totalCost = 0;

    // Accumulates what caching saved across every request this turn
    // makes. A per-request hit rate bounces around; the cumulative
    // one answers whether caching is working at all.
    const cacheTally = new CacheTally();

    while (true) {
      iteration += 1;

      // The cap. Without it, a model that keeps asking for tools loops
      // until something else breaks — and every pass is a billed request.
      // Ten is generous for a teaching app; the point is that the number
      // exists, not what it is.
      //
      // Note this is checked at the TOP of the loop. Checking after the
      // call would allow one more request than the cap allows.
      if (iteration > MAX_TOOL_ITERATIONS) {
        logIterationCap(log, iteration);

        finalText =
          finalText ||
          `I stopped after ${MAX_TOOL_ITERATIONS} rounds of tool calls without ` +
            "reaching an answer. See the activity log for what happened.";
        break;
      }

      // --- One request -------------------------------------------------------

      // Two things are worth looking for in this object:
      //
      //   messages  grows by two every iteration — the assistant turn and
      //             the tool results — and the WHOLE array is resent each
      //             time. That is why input tokens climb.
      //
      //   tools     is sent in full on every request. There is no
      //             registration step; the API keeps no memory of what
      //             tools exist. With six defined it is routinely 90%+ of
      //             the request by size.
      //
      // Built once, then both logged and sent. An earlier version
      // claimed in a comment that the logged object matched the call
      // "field for field" — a claim nothing enforced, and exactly how
      // the orchestrator came to log one model while calling another.
      //
      // --- Prompt caching --------------------------------------------
      //
      // The request renders as tools → system → messages, and a cache
      // entry covers everything up to a breakpoint. Marking the end of
      // each stable section means later requests reuse the processed
      // form instead of paying full price to send it again.
      //
      // Three breakpoints, in prefix order:
      //
      //   the last tool definition   caches the whole tools array
      //   the system prompt          caches the instructions
      //   the last settled message   caches the conversation so far,
      //                              leaving the new question outside
      //
      // The newest message is deliberately NOT cached. It differs
      // every turn, so a breakpoint after it would match nothing and
      // the whole exercise would be wasted.
      const cachePlan = describeCachePlan(tools, system, messages, producing);

      // Only on the first iteration: the prefix does not change
      // between them, so warning every time would be noise.
      if (iteration === 1 && !cachePlan.meetsMinimum) {
        logCachePlanWarning(log, iteration, cachePlan);
      }

      const request = {
        model: producing,
        max_tokens: MAX_TOKENS,
        // A top-level parameter, NOT an entry in the messages array.
        // Putting it in messages with role "system" is a common mistake
        // and the API rejects it.
        //
        // Sent as a text block rather than a string, because a string
        // has nowhere to carry cache_control.
        ...(system ? { system: withCachedSystem(system, cacheMode) } : {}),
        // Omitting the field entirely is what tells the model no tools
        // exist; an empty array is a different statement.
        ...(tools ? { tools: withCachedTools(tools, cacheMode) } : {}),
        // First pass only. Forcing a tool on a later iteration would
        // make Claude call another one rather than answering with the
        // result it just received.
        ...(iteration === 1 && toolChoice ? { tool_choice: toolChoice } : {}),
        messages: withCachedHistory(messages, cacheMode),
        // Thinking is always on; this decides whether its
        // summary comes back readable. See server/thinking.ts.
        ...thinkingConfig(thinkingDisplay),
        ...withEffort(effort),
      };

      logRequest(
        log,
        iteration,
        producing,
        messages,
        toolCount,
        toolChoiceLabel,
        request,
      );

      const started = Date.now();

      // .stream() instead of .create(). The request is identical; what
      // changes is that the SDK returns an object you can listen to while
      // the reply is still being generated.
      //
      // This matters for more than looks. A long reply can take 30
      // seconds, and a non-streaming request that long risks hitting an
      // HTTP timeout somewhere in the chain.
      const stream = client.messages.stream(request);

      // Forward each fragment to the browser as it arrives.
      stream.on("text", (fragment: string) => {
        emitText(fragment);
      });

      const response = await stream.finalMessage();

      // The reasoning summary, if one came back. Empty under the default
      // display setting: the blocks arrive either way, but with no text.
      const thinkingSummary = response.content
        .filter((block) => block.type === "thinking")
        .map((block) => block.thinking)
        .join("")
        .trim();
      if (thinkingSummary) emitThinking(thinkingSummary);

      const elapsed = Date.now() - started;

      stopReason = response.stop_reason;

      // response.content is an array of blocks, not a string. Collect the
      // text blocks rather than reaching for content[0] — the same
      // response can carry tool_use blocks alongside the text.
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      if (text) finalText = text;

      const usage = summariseUsage(response.usage, response.model);
      totalCost += usage.cost;

      // Server tools are billed per request, not per token, and the
      // count lives outside the token fields. A search-heavy turn is
      // therefore more expensive than its token count suggests.
      const serverTools = serverToolCounts(response.usage);
      cacheTally.add(usage, response.model);

      logResponse(
        log,
        iteration,
        usage,
        elapsed,
        response,
        text,
        serverTools,
      );

      // What Anthropic did on its own while producing this response.
      // Does nothing when no server tools were involved.
      logServerToolActivity(response.content, iteration, log);

      // Truncation returns HTTP 200 and looks like a normal reply, so
      // nothing else would surface it.
      if (response.stop_reason === "max_tokens") {
        logTruncated(log, iteration, usage);
      }

      // --- Is Claude finished? ----------------------------------------------
      //
      // Anything other than tool_use means the turn is over: end_turn is
      // a normal answer, max_tokens is a truncated one, refusal means a
      // safety classifier declined. None of them want anything from us.
      if (response.stop_reason !== "tool_use") {
        break;
      }

      // --- It wants tools ----------------------------------------------------

      const requests = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );

      logToolRequests(log, iteration, requests);

      // --- Run them, all at once --------------------------------------------
      //
      // Claude can ask for several tools in one turn, and when it does it
      // means they are independent — "what time is it in London and in
      // Tokyo" needs two lookups that do not depend on each other.
      //
      // Running them in sequence wastes the obvious opportunity: three
      // tools taking 300ms each finish in 900ms rather than 300ms. The
      // only reason the earlier version did so was that it was simpler to
      // write first.
      //
      // Promise.all is the right primitive here rather than a race or a
      // queue, for two reasons:
      //
      //   - It preserves ORDER. The results array lines up with the
      //     requests array regardless of which finished first. Order does
      //     not strictly matter to the API, since each result carries its
      //     tool_use_id, but a log panel that lists results in a random
      //     order is much harder to follow.
      //
      //   - It waits for all of them. Every tool_use block must be
      //     answered, so there is nothing to gain from proceeding early.
      //
      // Note that each promise resolves rather than rejects on failure:
      // runOneTool catches internally and returns an errored result. A
      // rejection would make Promise.all abandon the other results, and
      // the request would then be missing answers it is required to send.
      const parallelStarted = Date.now();

      if (requests.length > 1) {
        logParallelStart(log, iteration, requests);
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        requests.map((request) => runOneTool(request, iteration, log, onToolStart, onToolEnd)),
      );

      const parallelElapsed = Date.now() - parallelStarted;

      if (requests.length > 1) {
        logParallelEnd(log, iteration, requests, parallelElapsed);
      }

      // --- Append both turns and go round again ------------------------------
      //
      // What Claude said (including its tool_use blocks), then our reply
      // carrying the results. Both are required — dropping the assistant
      // turn leaves tool_result blocks answering nothing.
      //
      // All results go in ONE user message. Splitting them across several
      // is accepted by the API but teaches the model that parallel calls
      // do not work, and it stops making them.
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });

      const errorCount = toolResults.filter((r) => r.is_error).length;

      logToolResultsMessage(log, iteration, toolResults, errorCount);
    }

    if (iteration > 1) {
      const cache = cacheTally.summary();

      if (cache.fromCache > 0) {
        logCacheTotals(log, cache);
      }

      logTurnSummary(log, iteration, stopReason, totalCost);
    }

    // iteration counts the pass that detected the cap as well, so the
    // reported figure is clamped — otherwise a capped run would claim
    // eleven requests when it made ten.
    return {
      text: finalText,
      cost: totalCost,
      requests: Math.min(iteration, MAX_TOOL_ITERATIONS),
    };
  },
};

// ---------------------------------------------------------------------------
// Activity-log rows: what the panel shows for each step above
// ---------------------------------------------------------------------------
//
// Everything below builds a log row. None of it changes what is sent to
// Anthropic or what comes back, which is why it is down here rather
// than threaded through the loop: the loop above should read as the
// five steps it is, and this is the commentary on them.
//
// Each function takes exactly the values its row needs and calls one
// log method. They are not exported — they describe this pattern's
// rows and nothing else should be building them.

function logIterationCap(log: Logger, iteration: number): void {
  log.error(
    `Stopped after ${MAX_TOOL_ITERATIONS} iterations — the loop was not ` +
      "finishing on its own",
    {
      note:
        "Claude kept asking for tools. Common causes: a tool whose " +
        "result does not actually answer the question, a tool that " +
        "keeps failing, or an ambiguous request. The cap is what " +
        "stops this costing money indefinitely.",
    },
    {
      iteration,
      actor: "app",
      because: `the loop reached its ${MAX_TOOL_ITERATIONS}-iteration limit`,
    },
  );
}

function logCachePlanWarning(log: Logger, iteration: number, cachePlan: CachePlan): void {
  log.warn(
    `Cacheable prefix is about ${cachePlan.approximateTokens} tokens, ` +
      `below the ${cachePlan.minimum}-token minimum`,
    {
      plan: cachePlan,
      note:
        "Short prefixes are silently not cached — no error, and " +
        "cache_creation_input_tokens simply stays zero. Enable " +
        "some tools or pick a longer system prompt to see caching " +
        "actually work.",
    },
    {
      iteration,
      actor: "app",
      because: "the prefix is too short for the model to cache",
    },
  );
}


// The complete request body, on every iteration.
//
// An earlier version logged the full body on the first request and
// only a summary on later ones, which hid the most interesting
// request in the exchange: the one carrying the tool results back,
// where you can see the assistant turn with its tool_use block and
// the user turn with the matching tool_result. Logging a summary
// there answered a question nobody was asking.
function logRequest(
  log: Logger,
  iteration: number,
  producing: string,
  messages: Anthropic.MessageParam[],
  toolCount: number,
  toolChoiceLabel: string,
  request: Anthropic.MessageCreateParams,
): void {
  log.api(
    iteration === 1
      ? `Calling ${producing} · ${messages.length} message(s) · ` +
        `${toolCount} tool(s) · ` +
        `tool_choice: ${toolChoiceLabel}`
      : `Iteration ${iteration}: calling ${producing} · ` +
        `${messages.length} message(s) · ${toolCount} tool(s)`,
    {
      iteration,
      request,
    },
    {
      direction: "out",
      iteration,
      actor: "app",
      because:
        iteration === 1
          ? "the user sent a message"
          : "the previous response asked for tools, and their results " +
            "are now in the conversation",
    },
  );
}

// The complete response, not only its usage figures.
//
// `content` is the part worth expanding. It is an array of blocks,
// and seeing a text block sitting next to a tool_use block in the
// same response is the clearest way to understand why the code
// filters by type rather than reading content[0]. On a turn that
// calls a tool, this is where the tool_use id comes from — the
// same id that the tool_result must quote back.
function logResponse(
  log: Logger,
  iteration: number,
  usage: UsageSummary,
  elapsed: number,
  response: Anthropic.Message,
  text: string,
  serverTools: { searches: number; fetches: number },
): void {
  log.api(
    `${usage.totalInput} in / ${usage.output} out · ` +
      `${formatCost(usage.cost)} · ${elapsed}ms · ` +
      `${response.stop_reason}` +
      // The cache hit rate, where there is one. Worth putting in
      // the label rather than only the detail: it is the number
      // that changes most visibly between the first request of a
      // conversation and every one after it.
      (usage.cacheRead > 0
        ? ` · ${Math.round(usage.cacheHitRate * 100)}% cached`
        : "") +
      (serverTools.searches > 0
        ? ` · ${serverTools.searches} web search(es)`
        : "") +
      (text ? ` · ${snippet(text)}` : ""),
    {
      iteration,
      elapsed_ms: elapsed,
      estimated_cost: formatCost(usage.cost),
      // The response object as the SDK returned it, minus nothing.
      response: {
        id: response.id,
        model: response.model,
        role: response.role,
        stop_reason: response.stop_reason,
        stop_sequence: response.stop_sequence,
        content: response.content,
        usage: response.usage,
      },
      // The same numbers, named and priced. Kept alongside the raw
      // usage rather than replacing it, because the raw field names
      // are the ones in the documentation.
      tokens: {
        input: usage.input,
        output: usage.output,
        cache_read: usage.cacheRead,
        cache_write: usage.cacheWrite,
        total_input: usage.totalInput,
      },
      // What caching did on this request, in words.
      //
      // The raw cache_read and cache_write numbers above are the
      // ones in the documentation, but they do not say which
      // state you are in — and the three states look similar
      // until you know what to compare. Spelling it out is the
      // difference between a reader seeing numbers and seeing
      // what happened.
      caching: {
        hit_rate: `${Math.round(usage.cacheHitRate * 100)}%`,
        read_from_cache: usage.cacheRead,
        written_to_cache: usage.cacheWrite,
        fresh: usage.input,
        // The long form, kept here on purpose rather than calling
        // describeCacheOutcome. This is where a reader first sees
        // caching across several requests in one turn, so each
        // state says what it means for the NEXT iteration — which
        // the six single-request patterns have no next iteration
        // to talk about.
        what_happened:
          usage.cacheRead > 0
            ? `${usage.cacheRead} tokens were served from cache at ` +
              "about a twentieth of the normal input price. The " +
              "prefix matched because the tools, the system prompt " +
              "and the settled history were byte-identical to a " +
              "previous request."
            : usage.cacheWrite > 0
              ? `${usage.cacheWrite} tokens were WRITTEN to the ` +
                "cache, which costs 25% more than fresh input. " +
                "Nothing was read because there was nothing to " +
                "match yet — the next request with this prefix is " +
                "where it pays off."
              : "No caching on this request. Either the prefix is " +
                "below the minimum length, something in it changed, " +
                "or the entry expired after about five minutes idle.",
      },
      ...(serverTools.searches > 0 || serverTools.fetches > 0
        ? {
            server_tools: {
              web_searches: serverTools.searches,
              web_fetches: serverTools.fetches,
              note:
                "Billed per request, separately from tokens. The " +
                "content Claude read from the results IS counted in " +
                "the input tokens above, so a search costs twice.",
            },
          }
        : {}),
    },
    {
      direction: "in",
      iteration,
      actor: "claude",
      because: `request ${iteration} completed with stop_reason ` +
        `"${response.stop_reason}"`,
    },
  );
}

function logTruncated(log: Logger, iteration: number, usage: UsageSummary): void {
  log.error(
    "Reply was truncated: it hit the max_tokens ceiling.",
    { max_tokens: MAX_TOKENS, output_tokens: usage.output },
    {
      iteration,
      actor: "claude",
      because: "the reply reached max_tokens before finishing",
    },
  );
}

function logToolRequests(log: Logger, iteration: number, requests: Anthropic.ToolUseBlock[]): void {
  log.tool(
    `Claude requested ${requests.length} tool call(s): ` +
      requests.map((r) => r.name).join(", "),
    {
      iteration,
      // The id matters: each result must quote it back so the API
      // knows which request is being answered.
      requests: requests.map((r) => ({
        id: r.id,
        name: r.name,
        input: r.input,
      })),
    },
    {
      // Direction "none", NOT "in". Nothing arrives here.
      //
      // The response landed on the row above. This row is our code
      // filtering response.content for tool_use blocks and reporting
      // what it found — a local operation on data already in memory.
      // Marking it inbound implied a second delivery from Anthropic,
      // which is exactly the misreading the direction column exists
      // to prevent.
      //
      // The actor stays "claude" because the model did decide this,
      // even though the reading of it happened here. Direction says
      // where the data moved; actor says whose decision it was.
      iteration,
      actor: "claude",
      because:
        'the response we just received stopped with stop_reason "tool_use"',
    },
  );
}

function logParallelStart(log: Logger, iteration: number, requests: Anthropic.ToolUseBlock[]): void {
  log.info(
    `Running ${requests.length} tools in parallel`,
    {
      tools: requests.map((r) => r.name),
      note:
        "Promise.all, so the total time is the slowest tool rather " +
        "than the sum of all of them. Compare the elapsed_ms on each " +
        "tool row with the total below.",
    },
    {
      iteration,
      actor: "app",
      because: "the response contained more than one tool_use block",
    },
  );
}

function logParallelEnd(
  log: Logger,
  iteration: number,
  requests: Anthropic.ToolUseBlock[],
  parallelElapsed: number,
): void {
  log.info(
    `All ${requests.length} tools finished in ${parallelElapsed}ms`,
    { elapsed_ms: parallelElapsed, tool_count: requests.length },
    {
      iteration,
      actor: "app",
      because: "every tool in the batch has returned",
    },
  );
}

// What actually goes back on the wire.
//
// The rows above show each tool running; this shows the message
// built from them — the tool_result blocks, each quoting the
// tool_use_id of the request it answers, all inside a single user
// turn. That structure is the part of tool use people get wrong,
// and it is invisible unless it is logged.
function logToolResultsMessage(
  log: Logger,
  iteration: number,
  toolResults: Anthropic.ToolResultBlockParam[],
  errorCount: number,
): void {
  log.info(
    `Built a user message with ${toolResults.length} tool_result block(s)` +
      (errorCount > 0 ? ` (${errorCount} errored)` : ""),
    {
      note:
        "Not sent yet — this message is appended to the conversation " +
        "and travels on the next request, with the whole history. " +
        "All results go in ONE user message, and each tool_result " +
        "quotes the tool_use_id of the request it answers; that id " +
        "is how the API pairs them up.",
      user_message: { role: "user", content: toolResults },
    },
    {
      iteration,
      actor: "app",
      because: "every tool_use block must be answered before the next request",
    },
  );
}

/** The shape CacheTally.summary() returns; it has no exported name. */
type CacheTotals = ReturnType<CacheTally["summary"]>;

function logCacheTotals(log: Logger, cache: CacheTotals): void {
  log.info(
    `Caching saved ${formatCost(cache.saved)} this turn · ` +
      `${Math.round(cache.hitRate * 100)}% of input from cache`,
    {
      input_tokens_total: cache.totalInput,
      from_cache: cache.fromCache,
      hit_rate: `${Math.round(cache.hitRate * 100)}%`,
      input_cost_billed: formatCost(cache.inputCost),
      input_cost_without_caching: formatCost(cache.withoutCaching),
      saved: formatCost(cache.saved),
      saved_percent: `${Math.round(cache.savedPercent * 100)}%`,
      note:
        "Across every request this turn made. The per-request hit " +
        "rates above vary because each is a different mix of cached " +
        "prefix and fresh question; this is the figure that says " +
        "whether caching is paying for itself.",
    },
    {
      actor: "app",
      because: "the turn is complete and the cache figures can be totalled",
    },
  );
}

function logTurnSummary(
  log: Logger,
  iteration: number,
  stopReason: string | null,
  totalCost: number,
): void {
  log.info(
    `Finished after ${Math.min(iteration, MAX_TOOL_ITERATIONS)} iteration(s) · ` +
      `${formatCost(totalCost)} total`,
    { iterations: iteration, stop_reason: stopReason, total_cost: totalCost },
    {
      actor: "app",
      because: `the last response stopped with "${stopReason}", which needs nothing further`,
    },
  );
}
