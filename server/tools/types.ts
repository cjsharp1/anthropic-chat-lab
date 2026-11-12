/**
 * types.ts — what a tool is.
 *
 * Deliberately imports nothing but Zod's types. Every tool file imports
 * from here, and the registry imports every tool file; if the interface
 * lived in the registry, those two imports would form a cycle.
 *
 * A cycle like that does not always fail. Node resolves it when the thing
 * being used is a hoisted function declaration, so one tool worked fine —
 * and the second one crashed at startup with "Cannot access 'currentTime'
 * before initialization". That is the characteristic shape of this bug:
 * it looks like it works until something unrelated changes the order.
 *
 * The general rule is worth keeping: a module that defines shared types
 * should sit at the bottom of the dependency graph and import nothing from
 * the modules that use it.
 */

import type { z } from "zod";

/**
 * One tool Claude can call.
 *
 * Generic over its input type so that `run` receives properly typed,
 * already-validated arguments rather than `unknown`. The schema is the
 * single source of truth: it generates the JSON Schema sent to the API in
 * step 38, and validates what comes back in step 44.
 */
export interface LabTool<TInput = unknown> {
  /**
   * The name Claude uses to call this tool.
   *
   * Lowercase with underscores, matching the convention in Anthropic's
   * documentation. It must be unique across the registry, and it must not
   * change casually: a conversation that already contains a tool_use block
   * naming it will not match if it is renamed mid-session.
   */
  name: string;

  /**
   * What the tool does, written for the model rather than for a developer.
   *
   * Say what it is for and when to reach for it. Where a tool is easily
   * confused with another, say what it is NOT for — that single sentence
   * prevents more wrong calls than any amount of describing what it does.
   */
  description: string;

  /**
   * The arguments, as a Zod schema.
   *
   * Zod rather than hand-written JSON Schema because it does double duty:
   * it converts to JSON Schema for the API, and it validates the arguments
   * the model sends back. One definition, no chance of the two drifting.
   */
  inputSchema: z.ZodType<TInput>;

  /**
   * Runs the tool and returns a result for Claude to read.
   *
   * Always async, even where the work is synchronous, so that every tool
   * has the same signature and the executor in step 40 does not have to
   * care which is which.
   *
   * The return value is a string because that is what a tool_result block
   * carries. Return something the model can act on: a number, a sentence,
   * or JSON — but say what it is. "42" alone is less useful than
   * "7 × 6 = 42".
   *
   * Throwing is allowed and expected. Step 43 catches it and returns a
   * tool_result with is_error set, which lets Claude recover rather than
   * the whole request failing.
   */
  run(input: TInput): Promise<string>;

  /**
   * A prompt that reliably triggers this tool.
   *
   * Shown in the Tools tab and clickable. A tool nobody knows how to
   * invoke teaches nothing — and the prompts are chosen so that the
   * tool is genuinely needed, since a model asked something it can
   * answer unaided will not reach for a tool.
   */
  examplePrompt: string;

  /** What to watch for in the log when that prompt runs. */
  exampleWatch: string;

  /**
   * Whether this tool runs here or on Anthropic's servers.
   *
   * Most tools are "client" — our code executes them. Step 56 adds
   * web_search, which Anthropic runs for us, and step 57 tags the log rows
   * so the difference is visible. Defaults to client when omitted.
   */
  executedBy?: "client" | "server";
}

/**
 * A tool whose input type we have deliberately forgotten.
 *
 * Each tool is generic over its own input, which is what gives `run` a
 * properly typed argument where it is defined. But a list cannot hold
 * several different generic types at once, so the registry stores them
 * with the parameter widened.
 *
 * The trade is deliberate: inside a tool file the input is fully typed,
 * and at the point of execution it is unvalidated — which is correct,
 * because there the arguments came from the model. Step 44 parses them
 * through `inputSchema` before `run` is called, and that parse is what
 * makes them safe to use.
 */
export type AnyLabTool = LabTool<never>;

/**
 * Registers a tool.
 *
 * Exists so each tool file can keep its own precise input type while still
 * going into one shared list. The cast is contained here rather than
 * repeated in seven files.
 */
export function defineTool<TInput>(tool: LabTool<TInput>): AnyLabTool {
  return tool as AnyLabTool;
}
