/**
 * caching.ts — marking the stable part of a request as cacheable.
 *
 * Prompt caching stores the processed form of a request prefix so
 * later requests sharing that prefix skip the work. Cache reads cost
 * roughly a twentieth of fresh input tokens, which on a conversation
 * that resends its whole history every turn is the largest saving
 * available.
 *
 * ---------------------------------------------------------------------------
 * It is a PREFIX match, and that governs everything
 * ---------------------------------------------------------------------------
 *
 * The API renders a request in a fixed order:
 *
 *     tools  →  system  →  messages
 *
 * A cache entry covers everything up to a breakpoint. Any byte that
 * changes before that breakpoint invalidates it — not just the
 * changed part, everything after it too. So the question is not "what
 * is big" but "what is identical every time, and is it at the front".
 *
 * In this app:
 *
 *   tools     identical on every request while the Tools tab is
 *             unchanged, and routinely 90%+ of the request by size.
 *             The best possible thing to cache.
 *
 *   system    identical on every turn within a conversation. Also
 *             worth caching, and it sits immediately after the tools.
 *
 *   messages  grows every turn, so the tail is never stable — but the
 *             EARLIER turns are. A breakpoint after the last complete
 *             exchange caches the history while leaving the new
 *             question outside it.
 *
 * ---------------------------------------------------------------------------
 * Why the minimum matters
 * ---------------------------------------------------------------------------
 *
 * The estimate here counts only the tools and the system prompt,
 * because those are known before the request is sent. The real prefix
 * can be much longer — a turn that searched the web carries thousands
 * of tokens of results — so the warning can fire on a request that
 * caches perfectly well. It is a hint about the common case, not a
 * prediction.
 *
 * A prefix shorter than the model's minimum is silently not cached —
 * no error, no warning, and `cache_creation_input_tokens` simply
 * stays zero. For Opus and Sonnet the minimum is 1024 tokens; Haiku
 * needs 2048. A short system prompt with no tools will therefore
 * never cache however many times it is sent, which is the first thing
 * to check when caching "does not work".
 *
 * ---------------------------------------------------------------------------
 * The two log helpers at the foot of this file
 * ---------------------------------------------------------------------------
 *
 * `warnIfBelowCacheMinimum` and `describeCacheOutcome` build the two
 * caching rows the activity panel shows. They are here rather than in
 * each pattern because they describe caching, not any one pattern,
 * and they were previously written out identically in six files.
 * `tool-loop.ts` keeps its own wording for both, and says why at each
 * spot.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "./logger.js";
import type { UsageSummary } from "./usage.js";

/**
 * How much of the request to mark cacheable. Declared here because
 * the helpers below take it; the options themselves are at the foot
 * of the file.
 */
export type CacheMode = "off" | "prefix" | "full";

/** The marker that makes a block a cache breakpoint. */
const EPHEMERAL = { type: "ephemeral" as const };

/** Minimum cacheable prefix, by model family. */
export function cacheMinimum(model: string): number {
  return model.includes("haiku") ? 2048 : 1024;
}

/**
 * Marks the last tool definition as a cache breakpoint.
 *
 * One breakpoint covers everything before it, so marking the LAST
 * tool caches the whole array. Marking each one would waste
 * breakpoints — there are only four per request — on prefixes nothing
 * will ever match.
 *
 * Returns a new array; the input is not modified, because the same
 * definitions are logged elsewhere and mutating them would make the
 * log show cache_control markers that were added afterwards.
 */
export function withCachedTools(
  tools: Anthropic.ToolUnion[] | undefined,
  mode: CacheMode = "full",
): Anthropic.ToolUnion[] | undefined {
  if (mode === "off") return tools;
  if (!tools || tools.length === 0) return tools;

  return tools.map((tool, index) =>
    index === tools.length - 1
      ? ({ ...tool, cache_control: EPHEMERAL } as Anthropic.ToolUnion)
      : tool,
  );
}

/**
 * Turns a system prompt into a cacheable block.
 *
 * A plain string cannot carry cache_control, so the prompt becomes a
 * one-element array of text blocks instead. The content is identical
 * either way — this is purely about having somewhere to put the
 * marker.
 */
export function withCachedSystem(
  system: string | null,
  mode: CacheMode = "full",
): Anthropic.TextBlockParam[] | undefined {
  if (!system) return undefined;

  // Still a block array when caching is off — the shape is the same
  // either way, and only the marker differs. Returning a plain string
  // here would change the request shape between modes and muddy the
  // comparison the setting exists to support.
  if (mode === "off") return [{ type: "text", text: system }];

  return [{ type: "text", text: system, cache_control: EPHEMERAL }];
}

/**
 * Marks the end of the settled conversation as a breakpoint.
 *
 * The newest user message is deliberately left outside the cached
 * prefix: it is different every turn, so including it would mean the
 * cache never matched anything. Everything before it — the question
 * and answer from previous turns, and any tool exchanges — is stable
 * and worth caching.
 *
 * On the first turn there is nothing settled yet, so this does
 * nothing and only the tools and system prompt are cached.
 */
export function withCachedHistory(
  messages: Anthropic.MessageParam[],
  mode: CacheMode = "full",
): Anthropic.MessageParam[] {
  // Only "full" caches the history. "prefix" stops at the system
  // prompt, which is the stable part that never needs rewriting.
  if (mode !== "full") return messages;
  // Nothing to cache until there is at least one complete exchange
  // plus the new question.
  if (messages.length < 3) return messages;

  const lastSettled = messages.length - 2;

  return messages.map((message, index) => {
    if (index !== lastSettled) return message;

    // cache_control attaches to a content block, not to the message,
    // so a string content has to become a block array first.
    const content =
      typeof message.content === "string"
        ? [
            {
              type: "text" as const,
              text: message.content,
              cache_control: EPHEMERAL,
            },
          ]
        : message.content.map((block, blockIndex) =>
            blockIndex === message.content.length - 1
              ? ({ ...block, cache_control: EPHEMERAL } as typeof block)
              : block,
          );

    // Rebuilt per role rather than spread. MessageParam is a union,
    // and spreading it widens the role to a string — which no longer
    // satisfies the union's correlation between role and content.
    return message.role === "assistant"
      ? { role: "assistant" as const, content }
      : { role: "user" as const, content };
  });
}

/** What was marked, for the log. */
export interface CachePlan {
  tools: boolean;
  system: boolean;
  history: boolean;
  /** Rough size of the cacheable prefix, for the minimum-length check. */
  approximateTokens: number;
  /** Whether that looks long enough to cache at all. */
  meetsMinimum: boolean;
  minimum: number;
}

/**
 * Describes what caching will and will not cover, for the log panel.
 *
 * Worth logging explicitly rather than leaving the reader to infer it
 * from the token counts, because the failure mode is silence: a
 * prefix below the minimum produces no error and no cache, and the
 * only symptom is that cache_creation_input_tokens stays zero.
 */
export function describeCachePlan(
  tools: Anthropic.ToolUnion[] | undefined,
  system: string | null,
  messages: Anthropic.MessageParam[],
  model: string,
): CachePlan {
  const toolBytes = tools ? JSON.stringify(tools).length : 0;
  const systemBytes = system?.length ?? 0;

  // Only the prefix up to the first breakpoint counts toward the
  // minimum, and the tools come first.
  //
  // Four characters per token is the usual rule of thumb for English.
  // It is only used to warn when a prefix looks too short to cache, so
  // being approximate is fine — the real count comes back in the
  // response, in usage.cache_creation_input_tokens.
  const approximateTokens = Math.ceil((toolBytes + systemBytes) / 4);

  const minimum = cacheMinimum(model);

  return {
    tools: Boolean(tools && tools.length > 0),
    system: Boolean(system),
    history: messages.length >= 3,
    approximateTokens,
    meetsMinimum: approximateTokens >= minimum,
    minimum,
  };
}


// ---------------------------------------------------------------------------
// Which breakpoints to use
// ---------------------------------------------------------------------------

/**
 * How much of the request to mark cacheable.
 *
 * Offered as a setting because the prefix rule is easier to see than
 * to read about: move a breakpoint earlier and watch the hit rate
 * fall on the next request.
 *
 *   off     no cache_control at all. The baseline — run the same
 *           conversation with and without and compare the cost.
 *
 *   prefix  tools and the system prompt. The stable front of the
 *           request, and the part that never changes within a
 *           conversation.
 *
 *   full    the above plus the settled history. Caches more, but the
 *           entry is rewritten every turn as the conversation grows —
 *           so the write cost is paid repeatedly.
 */
export const DEFAULT_CACHE_MODE: CacheMode = "full";

/** The modes, as offered to the browser. */
export const CACHE_MODES: Array<{
  id: CacheMode;
  name: string;
  description: string;
  effect: string;
}> = [
  {
    id: "off",
    name: "Off",
    description:
      "No cache_control markers are sent. Every input token is billed " +
      "at the full rate, every turn.",
    effect:
      "The baseline. Run a three-turn conversation this way, note the " +
      "total, then switch to Full and run it again — the difference is " +
      "what caching is worth on your traffic rather than on someone " +
      "else's benchmark.",
  },
  {
    id: "prefix",
    name: "Tools and system prompt",
    description:
      "Marks the end of the tool definitions and the system prompt. " +
      "These never change within a conversation.",
    effect:
      "Caches roughly 1,100 tokens of tool definitions plus the prompt, " +
      "written once and read on every later request. The conversation " +
      "history is still billed fresh each turn, so the saving is flat " +
      "rather than growing.",
  },
  {
    id: "full",
    name: "Tools, system prompt and history",
    description:
      "Also marks the last settled message, so previous turns are " +
      "cached too. The newest question stays outside the prefix.",
    effect:
      "The saving grows with the conversation, because the history is " +
      "the part that grows. The cost is a rewrite each turn: the entry " +
      "covers one more exchange than last time, and a write costs 25% " +
      "more than fresh input. Worth it past two or three turns.",
  },
];

/** Reads a mode from an untrusted request body. */
export function parseCacheMode(input: unknown): CacheMode {
  return input === "off" || input === "prefix" || input === "full"
    ? input
    : DEFAULT_CACHE_MODE;
}

// ---------------------------------------------------------------------------
// Log rows about caching
// ---------------------------------------------------------------------------
//
// Both of these were written out in full in each of six pattern files,
// identically. They are about caching rather than about any pattern, so
// they live here with the rest of the caching logic and each pattern
// calls one line.
//
// tool-loop.ts deliberately keeps its own wording for both. Its warning
// fires only on the first iteration, and its explanation is the long
// form, because the tool loop is where a reader first meets caching
// across several requests.

/**
 * Warns when the cacheable prefix is too short to be worth caching.
 *
 * Feeds the `warn` row that appears before the first request of a
 * pattern. The failure this describes is silent — the API returns no
 * error for a prefix below the minimum, it simply does not cache —
 * which is exactly why the app says so out loud.
 */
export function warnIfBelowCacheMinimum(plan: CachePlan, log: Logger): void {
  if (!plan.meetsMinimum) {
    log.warn(
      `Cacheable prefix is about ${plan.approximateTokens} tokens, ` +
        `below the ${plan.minimum}-token minimum`,
      {
        plan,
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
}

/**
 * Says in words which of the three caching states a response was in.
 *
 * Feeds `caching.what_happened` in the response row. The raw
 * cache_read and cache_write numbers are the ones in the
 * documentation, but they do not say which state the request was in,
 * and the three look similar until you know what to compare.
 */
export function describeCacheOutcome(usage: UsageSummary): string {
  return usage.cacheRead > 0
    ? `${usage.cacheRead} tokens were served from cache at ` +
        "about a twentieth of the normal input price."
    : usage.cacheWrite > 0
      ? `${usage.cacheWrite} tokens were WRITTEN to the cache, ` +
          "which costs 25% more than fresh input. The next " +
          "request with this prefix is where it pays off."
      : "No caching. Either the prefix is below the minimum " +
        "length, something in it changed, or the entry " +
        "expired after about five minutes idle.";
}
