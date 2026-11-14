/**
 * registry.ts — the list of every tool the app has.
 *
 * A "tool" here is a function Claude can ask us to run. The model does not
 * execute anything itself: it replies saying "please call calculator with
 * these arguments", our server runs the function, and we send the result
 * back. Phase 7 builds that loop; this file is what it loops over.
 *
 * The layout:
 *
 *   types.ts        what a tool IS. Imports nothing.
 *   definitions/    one file per tool. Each imports types.ts.
 *   registry.ts     this file. Imports the definitions and lists them.
 *
 * The three levels are a dependency order, not just tidiness. An earlier
 * version had the interface in this file, which meant tool files and this
 * file imported each other — a cycle that worked with one tool and threw
 * "Cannot access 'currentTime' before initialization" with two. A module
 * defining shared types belongs at the bottom of the graph, importing
 * nothing from the modules that use it.
 */

import { calculator } from "./definitions/calculator.js";
import { currentTime } from "./definitions/current-time.js";
import { flakyService } from "./definitions/flaky-service.js";
import { notesTool } from "./definitions/notes.js";
import { readFileTool } from "./definitions/read-file.js";
import { searchDocs } from "./definitions/search-docs.js";
import { searchWeb } from "./definitions/search-web.js";
import type { AnyLabTool } from "./types.js";
// Imported for its value, not its type: getMcpTools() is called at
// request time. server/mcp/client.ts imports THIS module back (to
// read local tool names when checking for collisions), so the two
// form a cycle — resolved because neither calls the other at module
// load, only inside functions.
import { getMcpTools } from "../mcp/client.js";

// Re-exported so the rest of the server can import everything about tools
// from one place, without needing to know which file defines what.
export type { AnyLabTool, LabTool } from "./types.js";
export { defineTool } from "./types.js";

/**
 * Every LOCAL tool the app offers, in the order the UI lists them.
 *
 * Local only. web_search is in tools/server-tools.ts because
 * Anthropic runs it, and a tool borrowed over MCP never appears here
 * at all — `getActiveTools()` below is what merges the three.
 */
export const TOOLS: AnyLabTool[] = [
  calculator,
  currentTime,
  notesTool,
  searchDocs,
  searchWeb,
  readFileTool,
  flakyService,
];

/**
 * The local tools indexed by name.
 *
 * Built once from TOOLS rather than searched each time. A Map also makes
 * the "unknown tool" case explicit: `get` returns undefined, which the
 * caller has to handle, rather than a find() that silently returns
 * nothing.
 *
 * Not exported, deliberately. It is fixed at import time and cannot see
 * a tool borrowed over MCP, so a caller that reached for it directly
 * would miss them — `findTool()` below is the one every call site
 * should use.
 */
const TOOLS_BY_NAME = new Map<string, AnyLabTool>(
  TOOLS.map((tool) => [tool.name, tool]),
);

/**
 * Every tool available right now: the local ones, plus any borrowed
 * from a connected MCP server.
 *
 * A FUNCTION rather than an array, which is the whole point. TOOLS
 * above is fixed at import time and TOOLS_BY_NAME with it; the MCP
 * tools arrive when someone connects in Settings and leave when they
 * disconnect. Anything that captured a list at startup would be
 * permanently wrong in one direction or the other.
 *
 * This module and server/mcp/client.ts import each other: it reads
 * local tool names to check for collisions, this reads its borrowed
 * tools. That is a genuine cycle, and it works for one specific
 * reason — NEITHER SIDE CALLS THE OTHER WHILE MODULES ARE LOADING.
 * Both imports are only dereferenced inside functions, by which time
 * both modules have finished evaluating.
 *
 * That is a narrower guarantee than it looks, and it is the same trap
 * the header of types.ts describes: a cycle that resolves today
 * breaks the moment someone adds a top-level call. If anything here
 * ever needs getMcpTools() at module scope, the cycle has to be
 * broken properly rather than the call moved.
 */
export function getActiveTools(): AnyLabTool[] {
  return [...TOOLS, ...getMcpTools()];
}

/**
 * Finds a tool by name, local or borrowed.
 *
 * Replaces direct reads of TOOLS_BY_NAME in the tool loop. That Map
 * is still exported and still correct for what it describes — the
 * tools registered in this repository — but it cannot see a tool that
 * arrived over a connection, and a loop that consulted it would
 * report every MCP tool as unknown.
 *
 * Local tools are searched first. A remote tool can never shadow a
 * local one anyway, because the connection code refuses to adapt a
 * tool whose name is already taken, but the ordering here makes that
 * guarantee hold even if that check were ever weakened.
 */
export function findTool(name: string): AnyLabTool | undefined {
  return TOOLS_BY_NAME.get(name) ?? getMcpTools().find((t) => t.name === name);
}

/** Names of every tool available right now, for an error message. */
export function activeToolNames(): string[] {
  return getActiveTools().map((tool) => tool.name);
}

/**
 * Throws if two tools share a name.
 *
 * Called at startup. A duplicate name is not a runtime error that shows up
 * in the logs — it is a tool that silently never runs, because the Map
 * keeps only the last one registered. Far better to fail loudly on boot.
 */
export function assertUniqueToolNames(): void {
  const seen = new Set<string>();

  for (const tool of TOOLS) {
    if (seen.has(tool.name)) {
      throw new Error(
        `Two tools are registered as "${tool.name}". Tool names must be unique.`,
      );
    }
    seen.add(tool.name);
  }
}
