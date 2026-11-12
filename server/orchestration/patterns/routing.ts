/**
 * routing.ts — a cheap model decides who should answer.
 *
 * Call one asks Claude Haiku to pick a category. Call two answers the
 * question with a system prompt written for that category, on the main
 * model.
 *
 * ---------------------------------------------------------------------------
 * Why route at all
 * ---------------------------------------------------------------------------
 *
 * A single system prompt has to serve every question that might
 * arrive. The more kinds of question there are, the more hedged and
 * general it becomes — "explain clearly, give examples where helpful,
 * be concise unless detail is needed" is a prompt that says almost
 * nothing, because it is trying to cover a debugging question and a
 * conceptual one at the same time.
 *
 * Routing replaces one vague prompt with several specific ones. The
 * debugging prompt can say "name the symptom before the cause"; the
 * conceptual prompt can say "build from first principles". Neither has
 * to apologise for the other.
 *
 * ---------------------------------------------------------------------------
 * Why the classifier is a different model
 * ---------------------------------------------------------------------------
 *
 * Picking one of five labels is easy. It needs no reasoning, no
 * knowledge, no long output — just reading comprehension and a
 * constrained answer. Claude Haiku does it about as well as Opus and
 * costs a fortieth as much on input, a fortieth on output.
 *
 * That ratio is the whole economic argument for routing. If the
 * classifier cost the same as the answer, you would be paying twice to
 * answer once. Because it does not, the routing call is close to free:
 * watch the two cost figures in the log and compare them.
 *
 * This is the first pattern here that uses two models, and the cheap
 * one doing the cheap job is the point.
 *
 * ---------------------------------------------------------------------------
 * The risk
 * ---------------------------------------------------------------------------
 *
 * A misrouted question gets answered by the wrong specialist, and the
 * answer may be worse than the general prompt would have given. The
 * classifier is therefore given an explicit escape hatch: a "general"
 * category for anything that does not fit. A router without one will
 * force every question into a box, and the forcing is where the damage
 * happens.
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

/** Enough for one word. A classifier that writes an essay is misbehaving. */
const ROUTE_MAX_TOKENS = 20;

/** One destination the router can choose. */
interface Route {
  /** The label the classifier returns. */
  id: string;
  /** Shown in the log, so the choice is legible. */
  name: string;
  /** How the classifier is told to recognise this kind of question. */
  criteria: string;
  /** The specialist prompt used to answer it. */
  system: string;
}

/**
 * The destinations.
 *
 * Five is about the practical limit for a single classifier call — past
 * that the distinctions blur and misrouting climbs. A larger taxonomy
 * usually wants a tree of routers rather than one wide one.
 */
const ROUTES: Route[] = [
  {
    id: "debugging",
    name: "Debugging",
    criteria:
      "Something is broken, erroring, or behaving unexpectedly. Mentions " +
      "an error message, a status code, or a thing that 'does not work'.",
    system: `You are helping someone debug a problem with the Claude API.

- Name the most likely cause first, before explaining anything.
- Say what the symptom looks like, so they can confirm it is the same problem.
- Give the specific thing to check or change, not a list of possibilities.
- Name exact fields, error classes and status codes.
- If the question does not contain enough to diagnose it, say what information you need.`,
  },
  {
    id: "concept",
    name: "Concept",
    criteria:
      "Asks what something is, how it works, or why it behaves as it " +
      "does. Wants understanding rather than a fix.",
    system: `You are explaining how part of the Claude API works.

- Explain the mechanism, not just the behaviour. Say what is actually happening.
- Build from what the reader already has: relate the new idea to something they know.
- Use one concrete example with real values.
- Name the misconception people usually hold about this, and correct it directly.`,
  },
  {
    id: "code",
    name: "Code",
    criteria:
      "Asks for an implementation, a snippet, or how to write something. " +
      "Wants code back.",
    system: `You are writing code against the Claude API.

- Lead with the code. Explain after, briefly.
- TypeScript with the official @anthropic-ai/sdk unless another language is named.
- Use real field names and a real model id. No placeholders like YOUR_API_KEY_HERE in logic.
- Comment the line that is easy to get wrong, and nothing else.
- Say what the code does NOT handle, in one line.`,
  },
  {
    id: "cost",
    name: "Cost",
    criteria:
      "Asks about pricing, token counts, what something costs, or how to " +
      "make something cheaper.",
    system: `You are advising on what Claude API usage costs.

- Give the arithmetic, with the per-million rates you used.
- Distinguish input tokens from output tokens: output costs five times input.
- Name the biggest lever for this particular case before the smaller ones.
- Say when an optimisation is not worth the complexity.
- Note that published prices change, and where to check them.`,
  },
  {
    id: "general",
    name: "General",
    criteria:
      "Anything that does not clearly fit the others, including " +
      "greetings, follow-ups, and questions spanning several categories.",
    system: `You are a knowledgeable assistant for someone learning the Claude API.

Answer directly and at whatever length the question deserves.`,
  },
];

/** Built once: the classifier's instructions, listing every route. */
const CLASSIFIER_SYSTEM = `You are a classifier. Read the user's latest message and choose which category it belongs to.

Categories:

${ROUTES.map((r) => `- ${r.id}: ${r.criteria}`).join("\n")}

Reply with the category id and nothing else. No punctuation, no explanation, no quotes. One word.`;

export const routing: Pattern = {
  id: "routing",
  name: "Routing",

  description:
    "A cheap model (Haiku) picks a category, then the main model answers " +
    "with a system prompt written for that kind of question. The " +
    "classifier costs a fraction of the answer.",

  typicalRequests: "2",

  whenToUse:
    "When the questions arriving vary in kind and one system prompt " +
    "cannot serve them all. A debugging question and a conceptual one " +
    "want different instructions, and a prompt covering both says " +
    "almost nothing. Pointless when every question is the same shape.",

  measuredCost:
    "2 requests, $0.0809 — the most expensive of the seven on the test " +
    "question, despite making the fewest requests after Single call. " +
    "The classifier is 0.1% of that; the specialist prompt simply " +
    "produced a much longer answer. Request count is not cost.",

  // The classifier picks a category; the specialist answers.
  usesRoles: ["deciding", "producing"],

  examples: [
    {
      prompt: "My response got cut off halfway through a sentence.",
      watch:
        "Routes to Debugging. Then ask \"what is max_tokens?\" — same " +
        "topic, routes to Concept, and the answers are shaped " +
        "differently. That difference is the pattern working.",
      kind: "good-fit" as const,
    },
    {
      prompt: "Explain tool use, show me the code, and tell me what it costs.",
      watch:
        "Spans three categories, so it routes to General rather than " +
        "being forced into one. A router without that escape hatch would " +
        "pick one and answer worse than a general prompt would have.",
      kind: "poor-fit" as const,
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

    let totalCost = 0;

    // Say so rather than discarding them silently — see no-tools.ts.
    const serverTools = warnToolsIgnored(
      tools,
      "Routing",
      "Routing is two single calls. Neither can handle a tool_use " +
        "response, because that needs the loop the Tool loop provides. " +
        "A production router would compose the two: classify, then run " +
        "the tool loop with the specialist prompt.",
      log,
    );

    // --- Call one: classify --------------------------------------------------
    //
    // Only the latest user message is sent, not the whole conversation.
    // The classifier is answering "what kind of question is this", and
    // ten turns of prior context make that harder rather than easier —
    // as well as costing input tokens on every routing call.
    const latest = messages[messages.length - 1];
    const toClassify =
      typeof latest?.content === "string"
        ? latest.content
        : JSON.stringify(latest?.content ?? "");

    // Built once, then both logged and sent.
    const routeRequest = {
      model: deciding,
      max_tokens: ROUTE_MAX_TOKENS,
      system: CLASSIFIER_SYSTEM,
      // Just the question. No system prompt from the user, no history:
      // the classifier is deciding what KIND of question this is, and
      // ten turns of context make that harder as well as costlier.
      messages: [{ role: "user" as const, content: toClassify }],
      // Thinking is always on; this decides whether its
      // summary comes back readable. See server/thinking.ts.
      ...thinkingConfig(thinkingDisplay),
      ...withEffort(effort),
    };

    log.api(
      `Classifying with ${deciding}`,
      {
        request: routeRequest,
        note:
          "A different model from the one that answers. Picking one of " +
          "five labels needs no reasoning and no long output, so it goes " +
          "to the cheapest model available. Compare the two cost figures " +
          "below — that ratio is the argument for routing.",
      },
      {
        direction: "out",
        iteration: 1,
        actor: "app",
        because: "this pattern classifies before it answers",
      },
    );

    const routeStarted = Date.now();

    const routeResponse = await client.messages.create(routeRequest);

    const routeElapsed = Date.now() - routeStarted;

    const raw = routeResponse.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim()
      .toLowerCase();

    const routeUsage = summariseUsage(routeResponse.usage, routeResponse.model);
    totalCost += routeUsage.cost;

    // The classifier is told to reply with one word, and usually does.
    // It is still a language model, so match leniently and fall back
    // rather than trusting the output to be exactly a known id.
    const chosen =
      ROUTES.find((r) => raw === r.id) ??
      ROUTES.find((r) => raw.includes(r.id)) ??
      ROUTES[ROUTES.length - 1]!;

    const wasExact = raw === chosen.id;

    log.api(
      `${routeUsage.totalInput} in / ${routeUsage.output} out · ` +
        `${formatCost(routeUsage.cost)} · ${routeElapsed}ms`,
      {
        iteration: 1,
        elapsed_ms: routeElapsed,
        estimated_cost: formatCost(routeUsage.cost),
        classifier_said: raw,
        response: {
          model: routeResponse.model,
          stop_reason: routeResponse.stop_reason,
          usage: routeResponse.usage,
        },
      },
      {
        direction: "in",
        iteration: 1,
        actor: "claude",
        because: "the classifier returned a category",
      },
    );

    if (!wasExact) {
      // warn, not error: the lenient match recovered and the right specialist answered.
      log.warn(
        `Classifier returned "${raw}", matched to "${chosen.id}"`,
        {
          returned: raw,
          matched: chosen.id,
          note:
            "The classifier was told to reply with one word and did not. " +
            "Matching leniently and falling back to 'general' is what " +
            "stops an unexpected reply breaking the request — a router " +
            "that trusts its classifier's output exactly will eventually " +
            "crash on a stray full stop.",
        },
        {
          iteration: 1,
          actor: "app",
          because: "the reply did not exactly match a known category id",
        },
      );
    }

    log.info(
      `Route: ${chosen.name}`,
      {
        route: chosen.id,
        criteria: chosen.criteria,
        specialist_system: chosen.system,
        note:
          "This replaces the system prompt selected in Settings. Ask a " +
          "debugging question and a conceptual one and compare the routes.",
      },
      {
        iteration: 1,
        actor: "claude",
        because: `the classifier chose "${chosen.id}"`,
      },
    );

    // --- Call two: answer ----------------------------------------------------
    //
    // The specialist prompt replaces the user's selected prompt rather
    // than appending to it. Two sets of instructions about how to
    // answer would compete, and the more specific one should win —
    // that specificity is the entire reason for routing.

    const answerSystem = chosen.system;

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

const answerRequest = {
      model: producing,
      max_tokens: MAX_TOKENS,
      system: withCachedSystem(answerSystem),
      // Server tools go on the specialist answer, the call that produces what
      // the user reads. A planner or classifier has no business
      // searching the web — it would research something it is
      // about to throw away.
      ...(serverTools ? { tools: withCachedTools(serverTools, cacheMode) } : {}),
      messages: withCachedHistory(messages, cacheMode),
      // Thinking is always on; this decides whether its
      // summary comes back readable. See server/thinking.ts.
      ...thinkingConfig(thinkingDisplay),
      ...withEffort(effort),
    };

    log.api(
      `Answering with ${producing} as ${chosen.name}`,
      {
        request: answerRequest,
        replaced_system_prompt: system
          ? `${system.slice(0, 60)}… (${system.length} chars, not used)`
          : "(none was selected)",
      },
      {
        direction: "out",
        iteration: 2,
        actor: "app",
        because: `the question was routed to the ${chosen.name} specialist`,
      },
    );

    const answerStarted = Date.now();

    const stream = client.messages.stream(answerRequest);

    stream.on("text", (fragment: string) => emitText(fragment));

    const answerResponse = await stream.finalMessage();

    // The reasoning summary, if one came back. Empty under the
    // default display setting: the blocks arrive either way,
    // but with no text in them.
    {
      const summary = answerResponse.content
        .filter((block) => block.type === "thinking")
        .map((block) => block.thinking)
        .join("")
        .trim();
      if (summary) emitThinking(summary);
    }
    const answerElapsed = Date.now() - answerStarted;

    const text = answerResponse.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    const answerUsage = summariseUsage(
      answerResponse.usage,
      answerResponse.model,
    );
    totalCost += answerUsage.cost;

    log.api(
      `${answerUsage.totalInput} in / ${answerUsage.output} out · ` +
        `${formatCost(answerUsage.cost)} · ${answerElapsed}ms · ` +
        `${answerResponse.stop_reason} · ${snippet(text)}`,
      {
        iteration: 2,
        elapsed_ms: answerElapsed,
        estimated_cost: formatCost(answerUsage.cost),
        // What caching did, in words. The raw cache_read and
        // cache_write numbers are the ones in the documentation, but
        // they do not say which of three states this request was in,
        // and the three look similar until you know what to compare.
        caching: {
          hit_rate: `${Math.round(answerUsage.cacheHitRate * 100)}%`,
          read_from_cache: answerUsage.cacheRead,
          written_to_cache: answerUsage.cacheWrite,
          fresh: answerUsage.input,
          what_happened:
            answerUsage.cacheRead > 0
              ? `${answerUsage.cacheRead} tokens were served from cache at ` +
                "about a twentieth of the normal input price."
              : answerUsage.cacheWrite > 0
                ? `${answerUsage.cacheWrite} tokens were WRITTEN to the cache, ` +
                  "which costs 25% more than fresh input. The next " +
                  "request with this prefix is where it pays off."
                : "No caching. Either the prefix is below the minimum " +
                  "length, something in it changed, or the entry " +
                  "expired after about five minutes idle.",
        },
        response: {
          model: answerResponse.model,
          stop_reason: answerResponse.stop_reason,
          usage: answerResponse.usage,
        },
      },
      {
        direction: "in",
        iteration: 2,
        actor: "claude",
        because: "the specialist returned the answer",
      },
    );

    if (answerResponse.stop_reason === "max_tokens") {
      log.error(
        "Reply was truncated: it hit the max_tokens ceiling.",
        { max_tokens: MAX_TOKENS, output_tokens: answerUsage.output },
        {
          iteration: 2,
          actor: "claude",
          because: "the reply reached max_tokens before finishing",
        },
      );
    }

    // The ratio that justifies the pattern.
    const share = totalCost > 0 ? (routeUsage.cost / totalCost) * 100 : 0;

    log.info(
      `Routed to ${chosen.name} · ${formatCost(totalCost)} total · ` +
        `classifier was ${share.toFixed(1)}% of it`,
      {
        route: chosen.id,
        classifier_model: deciding,
        classifier_cost: formatCost(routeUsage.cost),
        answer_model: producing,
        answer_cost: formatCost(answerUsage.cost),
        classifier_share_percent: Number(share.toFixed(1)),
        total_cost: totalCost,
        note:
          "Routing is only worth it while the classifier is a small " +
          "fraction of the bill. Run the same classifier on the main " +
          "model and that fraction stops being negligible.",
      },
      {
        iteration: 2,
        actor: "app",
        because: "both calls have completed",
      },
    );

    return { text, cost: totalCost, requests: 2 };
  },
};
