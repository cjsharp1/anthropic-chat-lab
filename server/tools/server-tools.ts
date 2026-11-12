/**
 * server-tools.ts — tools Anthropic runs, rather than this server.
 *
 * Every tool in tools/definitions/ is a function in this codebase: the
 * model asks for it, our loop executes it, and we send the result
 * back. A server tool is different in a way that is worth seeing
 * rather than reading about.
 *
 * ---------------------------------------------------------------------------
 * What actually differs
 * ---------------------------------------------------------------------------
 *
 * Declare `{ type: "web_search_20260209", name: "web_search" }` in the
 * tools array and that is the whole integration. There is no schema to
 * write, no function to implement, no result to send back. Anthropic
 * runs the search, reads the results, and continues generating — all
 * inside one request.
 *
 * The clearest evidence is `stop_reason`. A client tool produces
 * "tool_use" and the conversation stops dead until we answer it. A
 * server tool produces "end_turn": the work happened during the
 * response, and the loop never sees a pause.
 *
 * The response does carry a record of what happened. A search produces
 * `server_tool_use` and `web_search_tool_result` blocks alongside the
 * text, which is how you audit what Claude looked at.
 *
 * ---------------------------------------------------------------------------
 * What it costs
 * ---------------------------------------------------------------------------
 *
 * Searches are billed separately from tokens, and reported in
 * `usage.server_tool_use.web_search_requests` rather than in the token
 * counts. The content Claude reads from the results IS charged as
 * input tokens, so a search-heavy turn is expensive twice over — worth
 * watching in the log, because the token count alone understates it.
 *
 * `max_uses` caps the searches per request. Without it an open-ended
 * question can run several, and the bill is not obvious from the
 * tokens.
 */

import type Anthropic from "@anthropic-ai/sdk";

/** A server tool the UI can offer. */
export interface ServerTool {
  /** The name Claude calls it by, matching the tool definition. */
  name: string;
  /** Shown in the Tools tab. */
  description: string;
  /** The definition as sent to the API. */
  definition: Anthropic.ToolUnion;
  /** A prompt that triggers it, shown in the Tools tab. */
  examplePrompt: string;
  /** What to watch for in the log when that prompt runs. */
  exampleWatch: string;
  /**
   * What to tell a learner about this one specifically, beyond the
   * generic "Anthropic runs it".
   */
  note: string;
}

/**
 * Caps searches per request.
 *
 * Three is enough for a real question and low enough that a runaway
 * does not quietly cost much. The cap is enforced by the API, not by
 * us — another difference from a client tool, where the loop's
 * iteration limit is ours to impose.
 */
const MAX_SEARCHES = 3;

export const SERVER_TOOLS: ServerTool[] = [
  {
    name: "web_search",
    description:
      "Searches the web. Anthropic runs this one — there is no function " +
      "for it in this codebase, and no tool_result is sent back.",
    definition: {
      type: "web_search_20260209",
      name: "web_search",
      max_uses: MAX_SEARCHES,
    } as Anthropic.ToolUnion,
    examplePrompt:
      "Search the web for the current Bank of England base rate.",
    exampleWatch:
      "One request, not two: stop_reason is end_turn and no tool_result " +
      "is sent. Watch the input token count — search results are read " +
      "into the context, so a search costs far more than its token " +
      "count alone suggests.",
    note:
      "Compare the activity log with a client tool's. A client tool " +
      "produces stop_reason 'tool_use' and a second request; this " +
      "produces 'end_turn' and the search happened inside the first " +
      "one. Searches are billed separately from tokens and appear in " +
      `usage.server_tool_use, capped at ${MAX_SEARCHES} per request.`,
  },
];

/** Server tools by name, for the route to look up what is enabled. */
export const SERVER_TOOLS_BY_NAME = new Map<string, ServerTool>(
  SERVER_TOOLS.map((tool) => [tool.name, tool]),
);

/**
 * Pulls the server-tool counts out of a response's usage.
 *
 * Absent on a response that used none, so defaulted rather than
 * assumed — the same reason the cache fields are defaulted in
 * usage.ts.
 */
export function serverToolCounts(usage: Anthropic.Usage): {
  searches: number;
  fetches: number;
} {
  const raw = (usage as unknown as Record<string, unknown>)["server_tool_use"];
  const counts = (raw ?? {}) as {
    web_search_requests?: number;
    web_fetch_requests?: number;
  };

  return {
    searches: counts.web_search_requests ?? 0,
    fetches: counts.web_fetch_requests ?? 0,
  };
}
