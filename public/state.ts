/**
 * state.ts — the handful of values that more than one module changes.
 *
 * Most state in this app belongs to one place and stays there: the
 * tool list lives with the tool controls, the effort options with the
 * effort selector. Those did not need moving when the frontend was
 * split into files, because nothing outside their own module touches
 * them.
 *
 * These are the exceptions. A running cost is written by the code
 * that reads a response and displayed by the code that draws the
 * header; a log counter is incremented when a row is appended and
 * reset when the panel is cleared. Each is genuinely shared.
 *
 * ---------------------------------------------------------------------------
 * Why an object rather than exported variables
 * ---------------------------------------------------------------------------
 *
 * An ES module's exports are live bindings that only the defining
 * module may assign to. `import { sessionCost }` followed by
 * `sessionCost += x` is a compile error, not a runtime surprise —
 * which is the language stopping you from doing something that could
 * not work.
 *
 * So the shared values live on one object. `state.sessionCost += x`
 * mutates a property of a thing every module has the same reference
 * to, which is allowed and behaves the way the single-file version
 * did. The `state.` prefix is the visible cost, and it is also a
 * useful signal: it marks every place where one part of the UI
 * reaches into another.
 */

import type { LogLevel } from "../shared/types.js";
import type { ChatMessage, RunOutcome, RunSnapshot } from "./types.js";

/** Everything written in one module and read in another. */
export const state = {
  // --- The conversation ----------------------------------------------------

  /**
   * Every turn so far, oldest first.
   *
   * The single most important thing to understand about the Messages
   * API: it is STATELESS. Anthropic keeps nothing between requests,
   * so this array is the entire memory of the conversation and all of
   * it is resent every turn.
   */
  conversation: [] as ChatMessage[],

  /** The assistant turn currently being streamed into, if any. */
  openTurn: null as HTMLElement | null,

  /** The raw text of that turn, before Markdown rendering. */
  openTurnRaw: "",

  // --- The last run, for the A/B comparison --------------------------------

  /** What was sent last turn, so a re-run can hold it constant. */
  lastRun: null as RunSnapshot | null,

  /** What that turn cost and produced, to compare against. */
  lastOutcome: null as RunOutcome | null,

  /** True while a comparison run is in flight. */
  isRerunning: false,

  /** When the current turn started, for the elapsed figure. */
  runStartedAt: 0,

  /** This turn's accumulating cost and request count, from the log. */
  turnCost: 0,
  turnRequests: 0,

  // --- Session totals ------------------------------------------------------

  /**
   * What this session has cost, in US dollars.
   *
   * Accumulated from the per-turn totals the server reports, and
   * displayed in the activity log's header. A single question
   * answered through three tool calls costs four requests, and a
   * per-call figure hides that.
   */
  sessionCost: 0,

  /** What caching has saved this session, shown beside the cost. */
  sessionCacheSaved: 0,

  // --- The log panel -------------------------------------------------------

  /** How many rows the panel holds, for the count beside its title. */
  logEventCount: 0,

  /** Which request group new rows are filed under. */
  logTurn: 0,

  /** The label on that group, e.g. "Message 3" or "Run B". */
  logTurnLabel: "",

  /** Levels the reader has unticked. Rows at these levels are hidden. */
  hiddenLevels: new Set<LogLevel>(),
};
