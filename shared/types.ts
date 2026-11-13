/**
 * types.ts — the shapes that travel between the server and the browser.
 *
 * This file is the contract for the whole app. The server builds these
 * objects, serialises them as JSON over Server-Sent Events, and the browser
 * parses them back out. Nothing here has any behaviour: it is types only,
 * and it compiles to nothing at all.
 *
 * Keeping the definitions in one file means the two halves cannot quietly
 * disagree about what a log event looks like. When the log panel
 * renders a level tag, the set of levels it must handle is the one
 * defined here.
 */

// ---------------------------------------------------------------------------
// Log events
// ---------------------------------------------------------------------------

/**
 * How significant a log event is, and what kind of thing it describes.
 *
 * The four levels are deliberately about *what happened*, not about severity
 * in the usual logging sense. A learner watching the panel wants to tell an
 * API call apart from a tool call at a glance, which matters more here than
 * distinguishing debug from warn.
 *
 *   info   Something the app did on its own: a pattern starting, a route
 *          chosen, history trimmed. No external call involved.
 *
 *   api    A request to Anthropic, or its response. These are the rows that
 *          cost money, and each one shows the model, token counts and
 *          stop reason. Counting them is how you compare orchestration
 *          patterns honestly.
 *
 *   tool   A tool being invoked and its result. These are also tagged
 *          client, server or mcp, to distinguish tools this app
 *          executes from tools Anthropic runs and tools borrowed from
 *          an MCP server.
 *
 *   warn   Nothing failed, but you should know. A pattern ignoring the
 *          enabled tools; a planner reporting that it was not needed; a
 *          classifier returning something unexpected but recoverable.
 *
 *   error  Something failed. Always rendered prominently, because a silent
 *          failure in a teaching app teaches the wrong lesson.
 *
 * The line between warn and error is whether the thing that was asked
 * for still happened. A truncated reply is an error — the answer is
 * incomplete and nobody was told. Tools being ignored by a pattern that
 * never uses them is a warning: the run proceeds exactly as designed,
 * and the note exists so the Tools tab's count is not misleading.
 *
 * That distinction earns its place because of volume. Five of the seven
 * orchestration patterns do not run tools, and all six tools are
 * enabled by default — so without a warn level, every run of those
 * patterns opened with a red row, and red that appears every time stops
 * being read.
 */
export type LogLevel = "info" | "api" | "tool" | "warn" | "error";

/**
 * One line in the activity log.
 *
 * Deliberately small. Every field below is either shown in the panel or used
 * to decide how to show it — there is no metadata here that nobody reads.
 */
/**
 * Which way a logged event travelled, if it travelled at all.
 *
 * Separate from `level` because the two answer different questions.
 * Level says what KIND of thing happened; direction says WHO SENT IT TO
 * WHOM. A row can be an API event going out (a request) or an API event
 * coming back (a response), and reading a conversation depends on
 * telling those apart at a glance.
 *
 *   out   this app → Anthropic. A request.
 *   in    Anthropic → this app. A response.
 *   call  this app → a tool. A function call we execute ourselves.
 *   back  a tool → this app. Its return value.
 *   none  neither; an internal note about configuration or lifecycle.
 *
 * ---------------------------------------------------------------------------
 * The test for choosing one
 * ---------------------------------------------------------------------------
 *
 * Ask: did data cross a boundary AT THE MOMENT this row was logged?
 *
 * If not, the direction is "none", however much the row is ABOUT
 * something that crossed one. Three rows got this wrong and had to be
 * corrected, all in the same way — they described data that had already
 * arrived, or was about to leave later:
 *
 *   "Claude requested 2 tool calls"     was "in", but the response had
 *                                        already arrived on the row
 *                                        above; this is our code reading
 *                                        response.content
 *
 *   "Claude asked for an unknown tool"  was "back", but no tool ran, so
 *                                        nothing returned from one
 *
 *   "Built a user message with 2
 *    tool_result blocks"                was "out", but the message is
 *                                        pushed onto an array and does
 *                                        not leave until the next request
 *
 * The failure mode is consistent: a row that reports on a boundary
 * crossing gets marked as being one. Each of those made the panel claim
 * more round trips than actually happened, which is the specific
 * confusion this field exists to prevent.
 *
 * `actor` is a separate question and does not have to agree. "Claude
 * requested 2 tool calls" has no direction but its actor is "claude",
 * because the model made that decision even though our code is what
 * noticed it. Direction says where bytes moved; actor says whose
 * decision it was.
 */
export type LogDirection = "out" | "in" | "call" | "back" | "none";

export interface LogEvent {
  /** Which kind of event this is. Decides the colour and the tag text. */
  level: LogLevel;

  /**
   * Which way it travelled. Defaults to "none" when absent — an
   * internal note rather than something crossing a boundary.
   */
  direction?: LogDirection;

  /**
   * Which request this row belongs to.
   *
   * Every row produced while handling iteration N carries N, including
   * the ones that are not themselves requests. That is what lets the
   * panel group a turn's rows under the exchange that caused them,
   * rather than presenting fifteen unrelated lines.
   */
  iteration?: number;

  /**
   * Why this happened, in one phrase.
   *
   * The question the panel exists to answer is not only "what was sent"
   * but "why was it sent". A row saying `calling calculator(...)` is
   * only half the story; the other half is that Claude asked for it in
   * the response to request 1.
   *
   * Written as a sentence fragment that completes "because…":
   * "Claude's response asked for it", "the tool results are ready".
   */
  because?: string;

  /**
   * What initiated this, as a short actor name.
   *
   * Four actors appear in this app, and confusing them is the root of
   * most misunderstandings about tool use:
   *
   *   user     the person typing
   *   app      this server's own code
   *   claude   the model, via something in its response
   *   tool     a tool function this server ran
   */
  actor?: "user" | "app" | "claude" | "tool";

  /**
   * A short, human-readable summary — the whole of what the row shows by
   * default. Write it as a complete thought a learner can scan without
   * expanding anything: "Calling claude-opus-5-5", not "api_call_start".
   */
  label: string;

  /**
   * The full data behind the event: a request body, a tool result, a token
   * breakdown, an error with its stack.
   *
   * Rendered inside a collapsed <details> element, so the panel
   * stays scannable while the detail stays one click away. Optional, because
   * plenty of events are fully described by their label.
   *
   * Typed as `unknown` rather than `any`: this is arbitrary JSON from many
   * different call sites, and `unknown` forces the rendering code to handle
   * it defensively instead of assuming a shape.
   */
  detail?: unknown;

  /**
   * When the event happened, as milliseconds since the epoch (Date.now()).
   *
   * A number rather than a Date object, because this crosses the wire as
   * JSON and JSON has no date type — a Date would arrive as a string and
   * need parsing back. The browser formats it for display.
   */
  at: number;
}

// ---------------------------------------------------------------------------
// The stream the browser receives
// ---------------------------------------------------------------------------

/**
 * Every message the server can send over the chat stream.
 *
 * This is a discriminated union: the `type` field says which variant it is,
 * and TypeScript narrows the rest of the object once you check it. The
 * browser's event handler switches on `type`, and the compiler will complain
 * if a new variant is added here and not handled there.
 *
 * Steps 19 to 24 fill these in. They are declared together now so the shape
 * of the stream is settled before anything depends on it.
 */
export type StreamEvent =
  /** A log row for the activity panel. */
  | { type: "log"; event: LogEvent }
  /** A fragment of Claude's reply, as it is generated. */
  | { type: "delta"; text: string }
  /**
   * A summary of the reasoning behind the reply.
   *
   * Only sent when the request asked for display "summarized" — the
   * default returns thinking blocks with no text in them. See
   * server/thinking.ts for why that default surprises people.
   */
  | { type: "thinking"; text: string }
  /**
   * A tool is about to run.
   *
   * Sent before execution rather than after, so the transcript shows
   * "calling calculator…" while it happens. A tool taking three seconds
   * would otherwise be three seconds of nothing, and the user cannot
   * tell a slow tool from a hung app.
   */
  | {
      type: "tool_start";
      id: string;
      name: string;
      input: unknown;
      iteration: number;
    }
  /** A tool has finished, successfully or not. */
  | {
      type: "tool_end";
      id: string;
      name: string;
      result: string;
      isError: boolean;
      elapsedMs: number;
    }
  /**
   * A structured extraction finished.
   *
   * Separate from "done" because it carries an object rather than
   * prose: the whole point of structured outputs is that the result
   * feeds code instead of a reader.
   */
  | {
      type: "extracted";
      data: Record<string, unknown> | null;
      raw: string;
      model: string;
      cost: number;
      elapsedMs: number;
    }
  /**
   * The reply is complete. Carries the final text for the transcript.
   *
   * Also carries what the turn cost, how long it took, how many
   * requests it needed and which models ran — so the reply can show
   * its own price without the reader opening the activity log.
   */
  | {
      type: "done";
      text: string;
      cost: number;
      elapsedMs: number;
      requests: number;
      models: string[];
    }
  /** Something failed; the message is safe to show the user. */
  | { type: "error"; message: string };
