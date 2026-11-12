/**
 * types.ts — what an orchestration pattern is.
 *
 * A "pattern" is a strategy for turning a question into an answer using
 * Claude. The simplest sends one request and returns what comes back.
 * The others do more: chain two calls so the second builds on the
 * first, route between a cheap model and an expensive one, fan out
 * across parallel calls and merge the results, or loop until a separate
 * evaluator is satisfied.
 *
 * ---------------------------------------------------------------------------
 * Why an interface rather than a switch statement
 * ---------------------------------------------------------------------------
 *
 * Seven patterns behind one signature means the route handler does not
 * know which one it is running, and a pattern does not know it is being
 * run from a web request. That buys three things:
 *
 *   - The UI dropdown can swap them at runtime, which is the whole
 *     point of the app: ask the same question under two patterns and
 *     compare the activity logs side by side.
 *
 *   - A pattern can be run from a script or a test with no server
 *     involved. Everything it needs arrives as arguments.
 *
 *   - Adding an eighth pattern touches one file and one array.
 *
 * Like server/tools/types.ts, this file imports nothing from the
 * modules that use it. Pattern implementations import from here, and
 * the registry imports the implementations; putting the interface in
 * the registry instead would make that a cycle.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../logger.js";
import type { ModelAssignment } from "../models.js";
import type { CacheMode } from "../caching.js";
import type { ThinkingDisplay } from "../thinking.js";
import type { Effort } from "../effort.js";

/**
 * Everything a pattern needs in order to run.
 *
 * Passed as one object rather than six positional arguments, because
 * several are optional and most patterns ignore at least one of them.
 */
export interface PatternContext {
  /**
   * The conversation so far, oldest first.
   *
   * Already validated by the route — every entry has a usable role and
   * non-empty content, and the array starts with a user turn.
   *
   * A pattern may append to this freely. It is a copy, not the
   * browser's array: the browser keeps its own history and the two are
   * reconciled by what the pattern finally returns.
   */
  messages: Anthropic.MessageParam[];

  /**
   * The system prompt, or null for none.
   *
   * Null rather than an empty string, because the two mean different
   * things on the wire: the field is omitted entirely rather than sent
   * blank. Patterns that use a specialist prompt of their own — routing
   * does — may ignore this or combine with it.
   */
  system: string | null;

  /**
   * The tool definitions to offer, already in the API's format, or
   * undefined when no tools are enabled.
   *
   * Undefined rather than an empty array for the same reason: omitting
   * `tools` tells the model no tools exist, which is what the Tools tab
   * means by unticking everything.
   */
  // ToolUnion rather than Tool: the array can hold both the custom
  // tools this server runs and the server tools Anthropic runs, and
  // they are different shapes. From the API's point of view there is
  // one tools list, and the type reflects that.
  tools: Anthropic.ToolUnion[] | undefined;

  /** The tool_choice setting, or undefined to let the API default. */
  toolChoice: Anthropic.ToolChoice | undefined;

  /**
   * Which model to use for each kind of job.
   *
   * Patterns read this rather than importing MODEL directly, so the
   * Settings tab can change what a pattern uses without the pattern
   * knowing. A pattern that hard-codes a model is one the user cannot
   * experiment with, and experimenting is the point.
   *
   * See server/models.ts for what each role means and why the
   * distinction is worth making.
   */
  models: ModelAssignment;

  /**
   * How much of the request to mark cacheable.
   *
   * A setting rather than a constant because the prefix rule is
   * easier to see than to read: switch it off, re-run the same
   * conversation, and compare the cost.
   */
  cacheMode: CacheMode;

  /**
   * Whether replies should carry a readable summary of the reasoning.
   *
   * Note what this does NOT control: whether Claude thinks. On these
   * models thinking is always on, and always billed. This only decides
   * whether the thinking blocks come back with text in them. See
   * server/thinking.ts.
   */
  thinkingDisplay: ThinkingDisplay;

  /**
   * How hard the model works before answering.
   *
   * Sent explicitly rather than left to default, because the default
   * differs by model — medium on Opus 5.5 and Haiku 5.5, high on
   * Sonnet 5.5. Comparing two models without pinning this compares
   * two different effort levels as well. See server/effort.ts.
   */
  effort: Effort;

  /**
   * Where the pattern reports what it is doing.
   *
   * Patterns should log generously. The activity panel is how a learner
   * sees the difference between a single call and an orchestrator, and
   * a pattern that runs silently teaches nothing. Each row should say
   * why it happened — see LogEvent.because.
   */
  log: Logger;

  /**
   * Streams a fragment of the answer to the browser as it is generated.
   *
   * Not every pattern can use this. A single call streams naturally; an
   * evaluator loop cannot, because its first draft may be thrown away
   * and showing the user text that is about to be discarded would be
   * worse than a pause. Those patterns leave this unused and return
   * their text at the end.
   */
  emitText: (fragment: string) => void;

  /**
   * Reports a reasoning summary, when one came back.
   *
   * Separate from emitText because it is not part of the answer: it
   * describes how the answer was reached, and running the two
   * together would misrepresent both.
   */
  emitThinking: (text: string) => void;

  /**
   * Reports a tool starting, for the transcript's tool cards.
   *
   * Separate from `log` because the two have different audiences: the
   * log is a record, these drive the UI.
   */
  onToolStart: (id: string, name: string, input: unknown, iteration: number) => void;

  /** Reports a tool finishing. */
  onToolEnd: (
    id: string,
    name: string,
    result: string,
    isError: boolean,
    elapsedMs: number,
  ) => void;
}

/** What a pattern produces. */
export interface PatternResult {
  /**
   * The answer to show the user.
   *
   * Returned even when it was also streamed through emitText: the
   * browser uses this as the authoritative version rather than
   * reassembling fragments, so a dropped fragment cannot leave a
   * subtly wrong message in the conversation history.
   */
  text: string;

  /** What the whole pattern cost, in US dollars. */
  cost: number;

  /** How many requests it made. One for a single call; more otherwise. */
  requests: number;
}

/**
 * One selectable orchestration pattern.
 */
export interface Pattern {
  /** Stable identifier, sent by the browser. Lowercase with hyphens. */
  id: string;

  /** Short label for the dropdown. */
  name: string;

  /**
   * What this pattern does and when to reach for it, written for
   * someone learning the material rather than for the model.
   *
   * Shown under the selector in the Settings tab, so it has room to be
   * a few sentences. Say what shape of work it suits and what it costs
   * relative to a single call — the trade is the lesson.
   */
  description: string;

  /**
   * Roughly how many requests this makes for one question.
   *
   * Displayed beside the name so the cost is visible before the pattern
   * is selected rather than after the bill arrives.
   */
  typicalRequests: string;

  /**
   * When this is the right choice, and when it is not.
   *
   * Written as advice rather than description. A learner choosing from
   * a dropdown of seven needs to know which one to reach for, and
   * "sends the question three times at once" does not answer that.
   *
   * Say what shape of question suits it, and say plainly where it is
   * wasteful — the patterns that are wrong for a given question are
   * more informative than the one that is right.
   */
  whenToUse: string;

  /**
   * What it cost on one measured question, for comparison.
   *
   * Every pattern here was run against "Explain prompt caching" with
   * the Terse prompt, so the figures are comparable. Real numbers
   * rather than adjectives: "expensive" means nothing next to another
   * pattern also described as expensive.
   *
   * These will drift as prices and models change, which is noted in
   * the UI.
   */
  measuredCost: string;

  /**
   * Which model roles this pattern actually uses.
   *
   * The Settings tab shows only these, because offering a Judging
   * dropdown next to a pattern with no evaluator invites an
   * experiment that cannot produce a result — the setting changes and
   * nothing happens, which teaches that model choice does not matter.
   *
   * Declared here rather than inferred, because a pattern knows what
   * it does and inferring it would mean parsing its source.
   */
  usesRoles: Array<"deciding" | "producing" | "judging">;

  /**
   * Questions that show this pattern doing its thing.
   *
   * Each pattern needs a different SHAPE of question to be worth
   * watching, and that shape is not obvious from the description. A
   * pattern tested with the wrong question looks identical to a single
   * call, which teaches the opposite of what it should.
   *
   * Two per pattern, each with a note on what to watch for:
   *
   *   - one where the pattern earns its cost
   *   - one where it does not, because the patterns that are WRONG
   *     for a question teach more than the one that is right
   *
   * Clicking an example fills the composer, so trying one is a click
   * rather than a retype.
   */
  examples: Array<{
    /** The prompt text, loaded into the composer when clicked. */
    prompt: string;
    /** What to watch for in the activity log when it runs. */
    watch: string;
    /** Whether this shows the pattern at its best or its worst. */
    kind: "good-fit" | "poor-fit";
  }>;

  /** Runs the pattern. */
  run(context: PatternContext): Promise<PatternResult>;
}
