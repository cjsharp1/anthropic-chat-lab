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
 * Through Portkey the app reaches Claude on Vertex AI, where this tool
 * does not work: Vertex accepts only the older `web_search_20250305`,
 * and an organisation policy can block web search outright. So with
 * Portkey selected it is hidden — see availableServerTools below — and
 * tools/definitions/search-web.ts does the job as a client tool.
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
import { getProvider } from "../api-key.js";

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
  /**
   * Why this tool cannot work through Portkey, or null if it can. A tool
   * with a reason here is left out of the Tools tab and of every request
   * while Portkey is the provider, and the reason is shown instead.
   */
  unavailableThroughPortkey: string | null;
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
    },
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
    unavailableThroughPortkey:
      "web_search is hidden: through Portkey, Claude runs on Vertex AI, " +
      "where an organisation policy can block it (and the version this " +
      "app sends is not accepted there). Use search_web instead — this " +
      "server runs that search itself.",
  },
];

/**
 * The server tools that can work with the current provider.
 *
 * A function rather than a filtered constant, for the same reason as
 * getActiveTools() in registry.ts: the provider can change in Settings
 * while the server runs, so a list captured at startup would be wrong.
 *
 * SERVER_TOOLS itself stays the full list. The MCP client reads it to
 * reserve these names, and a name stays taken even while its tool is
 * hidden.
 */
export function availableServerTools(): ServerTool[] {
  if (getProvider() !== "portkey") return SERVER_TOOLS;
  return SERVER_TOOLS.filter((tool) => tool.unavailableThroughPortkey === null);
}

/** Finds a server tool by name, if the current provider can use it. */
export function findServerTool(name: string): ServerTool | undefined {
  return availableServerTools().find((tool) => tool.name === name);
}

/** Why each hidden server tool is hidden, for the Tools tab. */
export function hiddenServerToolNotices(): string[] {
  if (getProvider() !== "portkey") return [];
  return SERVER_TOOLS.flatMap((tool) =>
    tool.unavailableThroughPortkey === null ? [] : [tool.unavailableThroughPortkey],
  );
}

/**
 * Pulls the server-tool counts out of a response's usage.
 *
 * Absent on a response that used none, so defaulted rather than
 * assumed — the same reason the cache fields are defaulted in
 * usage.ts.
 *
 * The SDK types `server_tool_use` as `ServerToolUsage | null`, which
 * is why it is read with optional chaining rather than a cast. The
 * two counts inside it are plain numbers, not optional: it is the
 * whole object that is missing when no server tool ran, not the
 * fields within it.
 */
export function serverToolCounts(usage: Anthropic.Usage): {
  searches: number;
  fetches: number;
} {
  return {
    searches: usage.server_tool_use?.web_search_requests ?? 0,
    fetches: usage.server_tool_use?.web_fetch_requests ?? 0,
  };
}
