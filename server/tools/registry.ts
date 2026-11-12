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
import type { AnyLabTool } from "./types.js";

// Re-exported so the rest of the server can import everything about tools
// from one place, without needing to know which file defines what.
export type { AnyLabTool, LabTool } from "./types.js";
export { defineTool } from "./types.js";

/**
 * Every tool the app offers, in the order the UI lists them.
 *
 * Steps 30 to 36 each add one. Step 37 is where the full set is wired into
 * the API and the interface.
 */
export const TOOLS: AnyLabTool[] = [
  calculator,
  currentTime,
  notesTool,
  searchDocs,
  readFileTool,
  flakyService,
];

/**
 * Tools indexed by name, for the executor to look up what Claude asked for.
 *
 * Built once from TOOLS rather than searched each time. A Map also makes
 * the "unknown tool" case explicit: `get` returns undefined, which step 40
 * has to handle, rather than a find() that silently returns nothing.
 */
export const TOOLS_BY_NAME = new Map<string, AnyLabTool>(
  TOOLS.map((tool) => [tool.name, tool]),
);

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
