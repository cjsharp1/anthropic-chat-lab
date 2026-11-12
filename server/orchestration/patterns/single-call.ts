/**
 * single-call.ts — one request, one response.
 *
 * The simplest thing that works, and the baseline every other pattern
 * is measured against. Send the conversation, stream back what comes
 * out, done.
 *
 * ---------------------------------------------------------------------------
 * Why this is worth having as a named pattern
 * ---------------------------------------------------------------------------
 *
 * It is tempting to treat this as the absence of a pattern — the thing
 * you do when you have not chosen one. But most production traffic
 * looks exactly like this, and the interesting question about any
 * fancier pattern is whether it beats this one for the money.
 *
 * A single call costs one request. Prompt chaining costs two. The
 * orchestrator costs one plus one per subtask plus one to synthesise.
 * If a pattern does not produce a visibly better answer than this, it
 * is not worth four times the latency and four times the bill, and the
 * only way to know is to run the same question through both.
 *
 * That comparison is the point of the dropdown.
 *
 * ---------------------------------------------------------------------------
 * What this pattern does NOT do
 * ---------------------------------------------------------------------------
 *
 * Notably, it does not run tools. If Claude asks for one, the response
 * comes back with stop_reason "tool_use" and this pattern stops there,
 * reporting that it happened. That is not an oversight: a single call
 * is, by definition, a single call. The tool loop is its own pattern,
 * and separating them is what makes the cost of tool use visible —
 * select this pattern, ask something needing a tool, and watch the
 * conversation fail to complete.
 */

import { client, MAX_TOKENS } from "../../anthropic.js";
import { warnToolsIgnored } from "../no-tools.js";
import {
  describeCachePlan,
  withCachedHistory,
  withCachedSystem,
  withCachedTools,
} from "../../caching.js";
import { formatCost, snippet, summariseUsage } from "../../usage.js";
import { thinkingConfig } from "../../thinking.js";
import { withEffort } from "../../effort.js";
import type { Pattern, PatternContext, PatternResult } from "../types.js";

export const singleCall: Pattern = {
  id: "single-call",
  name: "Single call",

  description:
    "One request, one response. The model answers from the conversation " +
    "and whatever it already knows. No tools are run, even if Claude " +
    "asks for one.",

  typicalRequests: "1",

  whenToUse:
    "The default choice, and the baseline every other pattern has to " +
    "beat. Right for anything a competent answer can cover in one go: " +
    "a factual question, a definition, a short explanation. Wrong only " +
    "when the question genuinely needs a tool run or splitting up.",

  measuredCost:
    "1 request, $0.0104, 559 characters. Every other pattern costs more " +
    "than this; the question is always whether it is worth the " +
    "difference.",

  // One call, writing the answer. Nothing to decide and nothing to judge.
  usesRoles: ["producing"],

  examples: [
    {
      prompt: "What does stop_reason max_tokens mean?",
      watch:
        "One request, one response, about two seconds. This is the " +
        "baseline — note the cost, then try the same question under " +
        "Prompt chaining and compare.",
      kind: "good-fit" as const,
    },
    {
      prompt: "What is 847293 times 61847?",
      watch:
        "Claude asks for the calculator and this pattern refuses to run " +
        "it, then says so. Enable the calculator in the Tools tab first " +
        "to see the refusal.",
      kind: "poor-fit" as const,
    },
  ],

  async run(context: PatternContext): Promise<PatternResult> {
    // No toolChoice: it is meaningless without tools, and the API
    // rejects a request carrying one with no tools array.
    const {
      messages, system, tools, log, emitText, emitThinking, models, cacheMode,
      thinkingDisplay,
      effort,
    } = context;

    // The model that writes what the user reads.
    const producing = models.producing;

    // The helper warns about client tools this pattern cannot run and
    // returns the server tools it can — see no-tools.ts for why the
    // two are different decisions.
    const serverTools = warnToolsIgnored(
      tools,
      "Single call",
      "A client tool needs a second request to carry its result back, " +
        "which is a loop this pattern does not have.",
      log,
    );

    // Built once, then both logged and sent, so the panel and the wire
    // cannot disagree.
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

    if (!cachePlan.meetsMinimum) {
      log.warn(
        `Cacheable prefix is about ${cachePlan.approximateTokens} tokens, ` +
          `below the ${cachePlan.minimum}-token minimum`,
        {
          plan: cachePlan,
          note:
            "Short prefixes are silently not cached — no error, " +
            "and cache_creation_input_tokens simply stays zero. " +
            "Enabling tools adds about 1,100 tokens of definitions, " +
            "which is what usually carries a request over the " +
            "line.",
        },
        {
          actor: "app",
          because: "the prefix is too short for the model to cache",
        },
      );
    }

const request = {
      model: producing,
      max_tokens: MAX_TOKENS,
      ...(system ? { system: withCachedSystem(system, cacheMode) } : {}),
      // Server tools only. Offering a client tool here would tell
      // Claude something exists that this pattern cannot run — it
      // would ask, be refused, and the answer would be an apology.
      ...(serverTools ? { tools: withCachedTools(serverTools, cacheMode) } : {}),
      messages: withCachedHistory(messages, cacheMode),
      // Thinking is always on; this decides whether its
      // summary comes back readable. See server/thinking.ts.
      ...thinkingConfig(thinkingDisplay),
      ...withEffort(effort),
    };

    log.api(
      `Calling ${producing} · ${messages.length} message(s)`,
      { request },
      {
        direction: "out",
        iteration: 1,
        actor: "app",
        because: "the user sent a message",
      },
    );

    const started = Date.now();

    // .stream() rather than .create(). The request is identical; what
    // changes is that fragments arrive as they are generated, so the
    // reply types out rather than appearing all at once after a pause.
    const stream = client.messages.stream(request);

    stream.on("text", (fragment: string) => emitText(fragment));

    // finalMessage() resolves with the same Message object .create()
    // would have returned, so everything below is unchanged by the
    // decision to stream.
    const response = await stream.finalMessage();

    // The reasoning summary, if one came back. Empty under the default
    // display setting: the blocks arrive either way, but with no text.
    {
      const summary = response.content
        .filter((block) => block.type === "thinking")
        .map((block) => block.thinking)
        .join("")
        .trim();
      if (summary) emitThinking(summary);
    }
    const elapsed = Date.now() - started;

    // response.content is an array of blocks, not a string. Collect the
    // text blocks rather than reaching for content[0]: the same
    // response can carry a tool_use block alongside its text.
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    const usage = summariseUsage(response.usage, response.model);

    log.api(
      `${usage.totalInput} in / ${usage.output} out · ` +
        `${formatCost(usage.cost)} · ${elapsed}ms · ` +
        `${response.stop_reason} · ${snippet(text)}`,
      {
        iteration: 1,
        elapsed_ms: elapsed,
        estimated_cost: formatCost(usage.cost),
        response: {
          id: response.id,
          model: response.model,
          role: response.role,
          stop_reason: response.stop_reason,
          stop_sequence: response.stop_sequence,
          content: response.content,
          usage: response.usage,
        },
        tokens: {
          input: usage.input,
          output: usage.output,
          cache_read: usage.cacheRead,
          cache_write: usage.cacheWrite,
          total_input: usage.totalInput,
        },
          // What caching did, in words. The raw numbers above are
          // the ones in the documentation, but they do not say which
          // of three states this request was in, and the three look
          // similar until you know what to compare.
          caching: {
            hit_rate: `${Math.round(usage.cacheHitRate * 100)}%`,
            read_from_cache: usage.cacheRead,
            written_to_cache: usage.cacheWrite,
            fresh: usage.input,
            what_happened:
              usage.cacheRead > 0
                ? `${usage.cacheRead} tokens were served from cache at ` +
                  "about a twentieth of the normal input price."
                : usage.cacheWrite > 0
                  ? `${usage.cacheWrite} tokens were WRITTEN to the cache, ` +
                    "which costs 25% more than fresh input. The next " +
                    "request with this prefix is where it pays off."
                  : "No caching. Either the prefix is below the minimum " +
                    "length, something in it changed, or the entry " +
                    "expired after about five minutes idle.",
          },
      },
      {
        direction: "in",
        iteration: 1,
        actor: "claude",
        because: `the request completed with stop_reason "${response.stop_reason}"`,
      },
    );

    // Truncation returns HTTP 200 and reads like a normal reply, so
    // nothing else would surface it.
    if (response.stop_reason === "max_tokens") {
      log.error(
        "Reply was truncated: it hit the max_tokens ceiling.",
        { max_tokens: MAX_TOKENS, output_tokens: usage.output },
        {
          iteration: 1,
          actor: "claude",
          because: "the reply reached max_tokens before finishing",
        },
      );
    }

    // Claude wanted a tool and this pattern does not run them. Say so
    // clearly rather than returning a half-finished answer, and point
    // at the pattern that does.
    if (response.stop_reason === "tool_use") {
      const wanted = response.content
        .filter((block) => block.type === "tool_use")
        .map((block) => block.name);

      // Should now be unreachable: no tools are sent, so there is
      // nothing for the model to ask for. Kept because "should be"
      // is not "is", and a tool_use block arriving here would
      // otherwise produce an empty reply with no explanation.
      log.error(
        `Unexpected tool_use from a request that sent no tools: ${wanted.join(", ")}`,
        {
          requested: wanted,
          note:
            "The request carried no tools array, so this should not " +
            "happen. If you see it, the request construction has a bug.",
        },
        {
          iteration: 1,
          actor: "app",
          because: "the single-call pattern stops after one response",
        },
      );

      return {
        text:
          text ||
          "Claude tried to use a tool, but this request offered none. " +
            "See the activity log.",
        cost: usage.cost,
        requests: 1,
      };
    }

    return { text, cost: usage.cost, requests: 1 };
  },
};
