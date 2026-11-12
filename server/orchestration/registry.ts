/**
 * registry.ts — the list of every orchestration pattern.
 *
 * Same shape as the tool registry, and for the same reasons: the
 * interface lives in types.ts so that pattern files and this file do
 * not import each other, and the lookup Map makes the "unknown id"
 * case explicit rather than silently returning nothing.
 */

import { chaining } from "./patterns/chaining.js";
import { evaluator } from "./patterns/evaluator.js";
import { orchestrator } from "./patterns/orchestrator.js";
import { parallel } from "./patterns/parallel.js";
import { routing } from "./patterns/routing.js";
import { singleCall } from "./patterns/single-call.js";
import { toolLoop } from "./patterns/tool-loop.js";
import type { Pattern } from "./types.js";

export type { Pattern, PatternContext, PatternResult } from "./types.js";

/**
 * Every pattern, in the order the dropdown lists them.
 *
 * Ordered by how much they do, which is also roughly by cost: a single
 * call first, the elaborate ones last. Moving down the list is moving
 * up the bill, and that ordering is itself a lesson.
 */
export const PATTERNS: Pattern[] = [
  singleCall,
  toolLoop,
  chaining,
  routing,
  parallel,
  orchestrator,
  evaluator,
];

/** Patterns by id, for the route to look up what the browser asked for. */
export const PATTERNS_BY_ID = new Map<string, Pattern>(
  PATTERNS.map((pattern) => [pattern.id, pattern]),
);

/** Which pattern runs when the browser does not name one. */
export const DEFAULT_PATTERN_ID = "tool-loop";

/**
 * Looks up a pattern by id, falling back to the default.
 *
 * The id arrives from the browser, so it is untrusted: an unknown
 * value must not throw. The caller logs a warning when the fallback is
 * used, so a typo is visible rather than silently ignored.
 */
export function getPattern(id: unknown): { pattern: Pattern; fellBack: boolean } {
  const found = PATTERNS_BY_ID.get(String(id));
  if (found) return { pattern: found, fellBack: false };

  return {
    pattern: PATTERNS_BY_ID.get(DEFAULT_PATTERN_ID)!,
    fellBack: true,
  };
}
