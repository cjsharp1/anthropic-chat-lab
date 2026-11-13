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

// A value import, not `import type`: fromZod() below calls
// z.toJSONSchema at runtime. It was type-only until this file gained
// that adapter.
import { z } from "zod";

/**
 * One problem found while validating a tool's arguments.
 *
 * A narrowing of what Zod reports, carrying only the two fields the
 * tool loop actually formats into a message for the model. Declared
 * here rather than importing Zod's own issue type because the MCP
 * tools added in `server/mcp/` validate with a different library and
 * have to produce the same shape.
 */
export interface SchemaIssue {
  /** Which field, as a path: `["limit"]`, or `[]` for the root. */
  path: Array<string | number>;
  /** What is wrong with it, written for a model to read and retry. */
  message: string;
}

/** The outcome of validating arguments. */
export type SchemaParseResult =
  | { success: true; data: unknown }
  | { success: false; issues: SchemaIssue[] };

/**
 * What this app needs from a tool's schema.
 *
 * ---------------------------------------------------------------------------
 * Why this is not simply `z.ZodType`
 * ---------------------------------------------------------------------------
 *
 * It was, until tools could arrive from an MCP server.
 *
 * A remote MCP server publishes each tool's arguments as JSON Schema.
 * Turning that into Zod means writing a converter, and a converter is
 * the wrong thing to own here: JSON Schema is a larger language than
 * the Zod subset anyone writes by hand — `oneOf`, `$ref`,
 * `patternProperties`, recursion — so a converter either handles all
 * of it or silently produces a schema that accepts a different set of
 * values than the server meant. The failure is quiet, and it looks
 * like a tool mysteriously rejecting valid arguments.
 *
 * The way out came from noticing how little this app asks of a
 * schema. In the whole codebase there are exactly two uses:
 *
 *   api-format.ts   converts it to JSON Schema, for the API
 *   tool-runner.ts  validates arguments against it, before `run`
 *
 * So the type names those two operations and nothing else. Every
 * local tool satisfies it through the adapter below, unchanged. An
 * MCP tool satisfies it by carrying the JSON Schema the server
 * published, verbatim, and validating with a JSON Schema validator —
 * no conversion, nothing to keep correct, and the schema Claude is
 * shown is byte-for-byte the one the remote server advertised.
 */
export interface SchemaLike {
  /** The JSON Schema to send to the API. */
  toJsonSchema(): Record<string, unknown>;

  /** Checks arguments before `run` sees them. Never throws. */
  safeParse(input: unknown): SchemaParseResult;
}

/**
 * Wraps a Zod schema as a SchemaLike.
 *
 * Every local tool declares `inputSchema` as a plain Zod object, which
 * is what keeps those files readable — so the adaptation happens here,
 * once, rather than in seven tool files.
 *
 * `z.toJSONSchema` is called lazily rather than at registration. It is
 * only needed when a request is built, and doing it eagerly would run
 * it for every tool on every startup including the ones nobody ticks.
 */
export function fromZod<TInput>(schema: z.ZodType<TInput>): SchemaLike {
  return {
    toJsonSchema: () =>
      z.toJSONSchema(schema) as unknown as Record<string, unknown>,

    safeParse(input: unknown): SchemaParseResult {
      const parsed = schema.safeParse(input);

      if (parsed.success) return { success: true, data: parsed.data };

      return {
        success: false,
        // Zod's issues carry more than this — a code, the expected
        // type, the received value — and the tool loop formats only
        // the path and the message. Narrowing here keeps the two
        // schema implementations honestly interchangeable rather than
        // letting one quietly depend on a field the other lacks.
        issues: parsed.error.issues.map((issue) => ({
          path: [...issue.path] as Array<string | number>,
          message: issue.message,
        })),
      };
    },
  };
}

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
   *
   * Still declared as a Zod type here, so every tool file writes a
   * plain `z.object({...})` and reads the way it always did. The
   * widening to `SchemaLike` happens in `defineTool` below, which is
   * where a tool joins the registry — see that function, and the long
   * note on `SchemaLike`, for why MCP tools need the wider contract.
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
   *
   * "mcp" is a third place, added when this app learned to connect to
   * an MCP server. Those tools run on a DIFFERENT MACHINE — or at
   * least a different process — reached over the Model Context
   * Protocol. From the model's point of view all three are identical:
   * one `tools` array, one `tool_use` block, one result. Where the
   * work happened is this server's problem, and the tag is how the
   * Tools tab and the log say which of the three it was.
   */
  executedBy?: "client" | "server" | "mcp";
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
/**
 * A registered tool, as the registry and the tool loop see it.
 *
 * Two differences from `LabTool`, both deliberate:
 *
 *   - the input type is widened to `never`, for the reason above;
 *   - `inputSchema` is a `SchemaLike` rather than a Zod schema, so
 *     the same list can hold local tools and tools whose schema came
 *     from a remote MCP server as JSON Schema.
 *
 * Nothing downstream notices. `api-format.ts` asks for JSON Schema
 * and `tool-runner.ts` validates; both operations are on `SchemaLike`,
 * and a Zod schema supplies them through `fromZod`.
 */
export type AnyLabTool = Omit<LabTool<never>, "inputSchema"> & {
  inputSchema: SchemaLike;
};

/**
 * Registers a tool.
 *
 * Exists so each tool file can keep its own precise input type while still
 * going into one shared list. The cast is contained here rather than
 * repeated in seven files.
 *
 * It also adapts the Zod schema to `SchemaLike` on the way through,
 * which is what keeps that widening invisible to the tool files: they
 * declare `z.object({...})` as they always did, and the registry
 * receives something the MCP tools can also satisfy.
 */
export function defineTool<TInput>(tool: LabTool<TInput>): AnyLabTool {
  return {
    ...tool,
    inputSchema: fromZod(tool.inputSchema),
  } as AnyLabTool;
}
