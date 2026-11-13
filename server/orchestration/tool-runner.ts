/**
 * tool-runner.ts — running one tool call, safely.
 *
 * Extracted from the route because every pattern that uses tools needs
 * it, and because the logic is worth reading on its own: validate the
 * arguments, run the function, and turn whatever happens into a
 * tool_result block that Claude can respond to.
 *
 * The invariant that matters here is that runOneTool NEVER REJECTS.
 * Patterns call it through Promise.all, which abandons every other
 * promise the moment one rejects — so a single failing tool would
 * leave its siblings uncollected, and the next request would be
 * missing answers the API requires. Every tool_use block must be
 * answered, including the ones whose neighbour failed.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../logger.js";
import { activeToolNames, findTool } from "../tools/registry.js";

/**
 * Shortens text for a log label.
 *
 * The full value always goes in the event's detail, so nothing is lost —
 * this only keeps the one-line summary scannable. A tool returning a
 * 10KB file would otherwise produce a log row taller than the panel.
 */
export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/**
 * Runs one tool and returns the result block to send back to Claude.
 *
 * Extracted from the loop so several can run through Promise.all. The
 * important property is that it NEVER REJECTS: every failure path returns
 * an errored tool_result instead of throwing.
 *
 * That matters more than it looks. Promise.all rejects as soon as any one
 * of its promises does, abandoning the rest — so a single failing tool
 * would leave the other results uncollected, and the request that follows
 * would be missing answers the API requires. Every tool_use block must be
 * answered, including the ones whose sibling failed.
 */
export async function runOneTool(
  request: Anthropic.ToolUseBlock,
  iteration: number,
  log: Logger,
  onToolStart: (id: string, name: string, input: unknown, iteration: number) => void,
  onToolEnd: (
    id: string,
    name: string,
    result: string,
    isError: boolean,
    elapsedMs: number,
  ) => void,
): Promise<Anthropic.ToolResultBlockParam> {
  // Tell the browser the tool is starting, before it runs. The transcript
  // then shows the call in progress rather than nothing at all, which
  // matters for anything slower than instant.
  onToolStart(request.id, request.name, request.input, iteration);

  // The function call itself. Distinct from the row above it — that one
  // is Claude ASKING, this one is our server RUNNING. Those are two
  // different events on two sides of a boundary, and collapsing them
  // hides the fact that the model never executes anything itself.
  log.tool(
    `[client] ${request.name}(${summariseArgs(request.input)})`,
    { tool: request.name, tool_use_id: request.id, input: request.input },
    {
      direction: "call",
      iteration,
      actor: "app",
      because: `Claude's response asked for ${request.name}`,
    },
  );

  /** Reports the outcome to the browser and returns the result block. */
  const finish = (
    result: string,
    isError: boolean,
    elapsedMs: number,
  ): Anthropic.ToolResultBlockParam => {
    onToolEnd(request.id, request.name, result, isError, elapsedMs);

    return {
      type: "tool_result",
      tool_use_id: request.id,
      content: result,
      ...(isError ? { is_error: true as const } : {}),
    };
  };

  // findTool rather than a direct Map read: a tool may have arrived
  // from a connected MCP server after startup, and the static Map
  // cannot see those. Looking in the Map alone reported every remote
  // tool as unknown.
  const tool = findTool(request.name);

  // The model asked for something that does not exist. Rare, but it
  // happens — and it must still be answered.
  if (!tool) {
    // warn, not error: an errored tool_result goes back and Claude recovers from it.
    log.warn(
      `Claude asked for an unknown tool: ${request.name}`,
      { requested: request.name, available: activeToolNames() },
      {
        // No direction. The lookup failed here, in our own code — no
        // tool ran, so nothing returned from one. The errored
        // tool_result that results does travel to Anthropic, but it
        // goes on the NEXT request, not now.
        iteration,
        actor: "app",
        because: "no tool is registered under that name",
      },
    );
    return finish(`No tool called "${request.name}" exists.`, true, 0);
  }

  // --- Validate the arguments before running anything ----------------------
  //
  // `strict: true` on the tool definition guarantees the SHAPE of the
  // input — which fields exist and of what type. It does not check
  // values, and step 39 had to strip the numeric bounds from the schema
  // entirely because strict mode rejects them.
  //
  // So without this parse, measurably wrong input reaches the tools:
  //
  //   searchDocs limit: 500   returns 7 documents, ignoring max(5)
  //   calculator a: "7"       returns 72, because "7" + 2 concatenates
  //   notes action: "drop"    crashes with "Cannot read properties of
  //                           undefined" — an internal error message
  //                           that tells Claude nothing it can act on
  //
  // Parsing here turns all three into a clear message naming the bad
  // field, which Claude can correct and retry. It also means `run`
  // receives values its types actually promise, rather than whatever
  // arrived over the network.
  const parsed = tool.inputSchema.safeParse(request.input);

  if (!parsed.success) {
    // The issues are precise: which field, and what is wrong with it.
    // Formatting them for the model rather than dumping the raw error
    // is what makes the retry work.
    //
    // `parsed.issues` rather than `parsed.error.issues`: the schema is
    // now a SchemaLike, which reports a narrowed issue shape so that a
    // Zod schema and an MCP server's JSON Schema can be validated
    // through the same interface. See server/tools/types.ts.
    const problems = parsed.issues
      .map((issue) => {
        const field = issue.path.join(".") || "(root)";
        return `${field}: ${issue.message}`;
      })
      .join("; ");

    // warn, not error: validation did its job; Claude reads the message and retries.

    log.warn(
      `${request.name} rejected: ${truncate(problems, 46)}`,
      {
      iteration,
      tool: request.name,
      tool_use_id: request.id,
      received: request.input,
      problems: parsed.issues,
      note:
        "Rejected before the tool ran. strict:true checks the shape of " +
        "the arguments, not their values — the numeric bounds are not " +
          "even in the schema the API sees, because strict mode rejects " +
          "them. This parse is what enforces them.",
      },
      {
        // No direction, for the same reason: the parse happened here and
        // the tool was never called. "back" would imply a return value
        // from something that did not run.
        iteration,
        actor: "app",
        because: "the arguments failed schema validation before the tool ran",
      },
    );

    return finish(
      `Invalid arguments for ${request.name} — ${problems}`,
      true,
      0,
    );
  }

  const started = Date.now();

  try {
    // parsed.data, not request.input: Zod has coerced defaults, stripped
    // unknown keys, and guaranteed the types.
    const result = await tool.run(parsed.data as never);
    const elapsed = Date.now() - started;

    // "←" rather than "→": this row is the answer coming back, not
    // another request going out.
    log.tool(
      `[client] ${request.name} → ${truncate(result, 50)}`,
      {
      iteration,
      tool: request.name,
      tool_use_id: request.id,
      input: request.input,
      // The full result, however long. The label is truncated; this is
      // not — a 3KB search result is exactly the thing worth expanding
      // a row to read.
      result,
        result_characters: result.length,
        elapsed_ms: elapsed,
      },
      {
        direction: "back",
        iteration,
        actor: "tool",
        because: `${request.name} finished successfully`,
      },
    );

    return finish(result, false, elapsed);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    log.error(
      `${request.name} failed: ${truncate(message, 50)}`,
      {
      iteration,
      tool: request.name,
      tool_use_id: request.id,
      input: request.input,
      error: message,
      elapsed_ms: Date.now() - started,
        note:
          "Returned to Claude as a tool_result with is_error: true, so it " +
          "can respond to the failure rather than the request dying.",
      },
      {
        direction: "back",
        iteration,
        actor: "tool",
        because: `${request.name} threw`,
      },
    );

    // The message is written for the model to read. A tool that says
    // "429 Too Many Requests, retry after 30s" gives Claude something to
    // act on; one that says "Error" does not.
    return finish(message, true, Date.now() - started);
  }
}

/**
 * Renders tool arguments as a compact call signature.
 *
 * "calculator(a: 847293, b: 61847, op: multiply)" reads as a function
 * call, which is what it is. The full input is in the row's detail.
 */
export function summariseArgs(input: unknown): string {
  if (input === null || typeof input !== "object") return String(input);

  const parts = Object.entries(input as Record<string, unknown>).map(
    ([key, value]) =>
      `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );

  const joined = parts.join(", ");
  return joined.length <= 54 ? joined : `${joined.slice(0, 54)}…`;
}
