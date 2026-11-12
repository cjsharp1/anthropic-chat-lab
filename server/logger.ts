/**
 * logger.ts — builds the events that fill the activity panel.
 *
 * Every part of the server that does something worth watching takes a
 * Logger and calls one of its four methods. The logger builds a
 * well-formed LogEvent and hands it to whatever `emit` function it was
 * given.
 *
 * That indirection is the whole design. The code doing the work does not
 * know or care where its events go:
 *
 *   in a request    emit writes to the browser's open SSE connection
 *   in a test       emit pushes onto an array you then assert against
 *   in a script     emit is console.log
 *
 * This matters because from step 46 the orchestration patterns all take
 * a logger. A pattern should be runnable from a test or a script without
 * an HTTP response object existing at all — if patterns wrote to `res`
 * directly, they could only ever run inside a live request.
 */

import type { LogDirection, LogEvent, LogLevel } from "./types.js";

/**
 * Where a log event goes once it has been built.
 *
 * Returns void: logging must never be something a caller has to await,
 * or every line of the patterns would need an `await` in front of it.
 */
export type LogEmitter = (event: LogEvent) => void;

/**
 * The context around an event: what caused it and where it belongs.
 *
 * An options object rather than positional arguments, because four
 * optional parameters in a row is a call site nobody can read:
 * `log.tool("…", detail, "call", 2, "Claude asked", "claude")`.
 */
export interface LogContext {
  /** Which way the data moved, if it crossed a boundary at all. */
  direction?: LogDirection;
  /** Which request this row belongs to. */
  iteration?: number;
  /** Why it happened, completing the phrase "because…". */
  because?: string;
  /** What initiated it. */
  actor?: "user" | "app" | "claude" | "tool";
}

/**
 * The four logging methods, one per level.
 *
 * Each takes a human-readable label, optional detail, and optional
 * context. See types.ts for what each level and field means.
 */
export interface Logger {
  /** Something the app did on its own — no external call. */
  info(label: string, detail?: unknown, context?: LogContext): void;
  /** A request to Anthropic, or its response. These rows cost money. */
  api(label: string, detail?: unknown, context?: LogContext): void;
  /** A tool being invoked, or its result. */
  tool(label: string, detail?: unknown, context?: LogContext): void;
  /** Nothing failed, but the reader should know. */
  warn(label: string, detail?: unknown, context?: LogContext): void;
  /** Something failed. */
  error(label: string, detail?: unknown, context?: LogContext): void;
}

/**
 * Creates a logger that sends its events to `emit`.
 *
 * @param emit     Called once per event, with a complete LogEvent.
 * @param defaults Context applied to every event unless overridden. The
 *                 request handler sets `iteration` here once per pass,
 *                 so individual call sites do not each have to remember
 *                 it — and cannot forget.
 */
export function makeLogger(
  emit: LogEmitter,
  defaults: LogContext = {},
): Logger {
  /**
   * Builds one event and emits it.
   *
   * The timestamp is applied here rather than by the caller, so every
   * event is stamped the same way and no call site can forget it.
   */
  function send(
    level: LogLevel,
    label: string,
    detail?: unknown,
    context?: LogContext,
  ): void {
    const merged = { ...defaults, ...context };
    const event: LogEvent = { level, label, at: Date.now() };

    // Each field is attached only when present. Writing them
    // unconditionally would put "direction": null and friends into the
    // JSON on the wire, and give the renderer empty values to handle.
    if (detail !== undefined) event.detail = detail;
    if (merged.direction && merged.direction !== "none") {
      event.direction = merged.direction;
    }
    if (merged.iteration !== undefined) event.iteration = merged.iteration;
    if (merged.because) event.because = merged.because;
    if (merged.actor) event.actor = merged.actor;

    emit(event);
  }

  return {
    info: (label, detail, context) => send("info", label, detail, context),
    api: (label, detail, context) => send("api", label, detail, context),
    tool: (label, detail, context) => send("tool", label, detail, context),
    warn: (label, detail, context) => send("warn", label, detail, context),
    error: (label, detail, context) => send("error", label, detail, context),
  };
}

/**
 * Returns a logger that adds the given context to everything it emits.
 *
 * Used by the request handler to stamp an iteration number onto every
 * row produced during that pass, without touching any of the call sites
 * inside it.
 */
export function withContext(base: Logger, context: LogContext): Logger {
  return {
    info: (label, detail, extra) => base.info(label, detail, { ...context, ...extra }),
    api: (label, detail, extra) => base.api(label, detail, { ...context, ...extra }),
    tool: (label, detail, extra) => base.tool(label, detail, { ...context, ...extra }),
    warn: (label, detail, extra) => base.warn(label, detail, { ...context, ...extra }),
    error: (label, detail, extra) => base.error(label, detail, { ...context, ...extra }),
  };
}

/**
 * A logger that discards everything.
 *
 * Useful when a function needs a logger but the caller has nowhere
 * sensible to send events — a unit test that does not care about
 * logging, say. Having this means a Logger parameter can stay required
 * rather than optional, so no code has to be written defensively around
 * `log?.info(...)`.
 */
export const silentLogger: Logger = makeLogger(() => {});

/**
 * A logger that prints to the terminal, for scripts and for debugging.
 *
 * Deliberately separate from the real one: the browser panel and the
 * terminal want different formatting, and conflating them would mean
 * neither reads well.
 */
export const consoleLogger: Logger = makeLogger((event) => {
  const time = new Date(event.at).toISOString().slice(11, 23); // HH:MM:SS.mmm
  const level = event.level.toUpperCase().padEnd(5);
  const where = event.iteration ? `[${event.iteration}] ` : "    ";
  console.log(`${time}  ${level}  ${where}${event.label}`);

  if (event.because) {
    console.log(`                      because ${event.because}`);
  }

  // Indent the detail under its label so a multi-line object stays
  // readable.
  if (event.detail !== undefined) {
    const text = JSON.stringify(event.detail, null, 2) ?? String(event.detail);
    console.log(
      text
        .split("\n")
        .map((line) => "                      " + line)
        .join("\n"),
    );
  }
});
