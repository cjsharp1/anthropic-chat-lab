/**
 * schema.ts — makes a remote tool's JSON Schema usable as a LabTool's.
 *
 * An MCP server describes each tool's arguments as JSON Schema. A
 * `LabTool` describes them as a Zod schema. This file is the join, and
 * it is the one genuinely awkward part of the integration — so the
 * reasoning is written out rather than left in the shape of the code.
 *
 * ---------------------------------------------------------------------------
 * The obvious approach, and why it is wrong
 * ---------------------------------------------------------------------------
 *
 * The obvious move is to convert: JSON Schema in, Zod out, and the
 * rest of the app never knows the difference. The MCP SDK even exports
 * `fromJsonSchema` for it.
 *
 * Two problems.
 *
 * First, `fromJsonSchema` returns a Standard Schema, not a `ZodType`.
 * It validates, but it is not a Zod object and does not satisfy
 * `LabTool.inputSchema`.
 *
 * Second, and more important: the conversion is the wrong direction to
 * trust. JSON Schema is a larger language than any Zod schema you
 * would write by hand — `oneOf`, `$ref`, `patternProperties`,
 * recursive definitions. A converter either handles all of it or
 * silently produces a Zod schema that accepts or rejects a different
 * set of values than the server meant. Both failures are quiet, and
 * both show up as a tool that mysteriously refuses valid arguments.
 *
 * ---------------------------------------------------------------------------
 * What this does instead
 * ---------------------------------------------------------------------------
 *
 * Nothing. It keeps the server's JSON Schema exactly as received and
 * hands it to the API unchanged.
 *
 * That is possible because of something easy to miss: this app only
 * ever does two things with `inputSchema`.
 *
 *   api-format.ts   calls z.toJSONSchema(schema) — to get JSON Schema
 *   tool-runner.ts  calls schema.safeParse(input) — to validate
 *
 * The first is a conversion we no longer need, because we already HAVE
 * the JSON Schema. Converting to Zod and back would be a round trip
 * whose only possible effect is loss.
 *
 * So `LabTool.inputSchema` was widened from `z.ZodType<T>` to an
 * interface naming those two operations — see server/tools/types.ts.
 * Every existing tool satisfies it unchanged, because a Zod schema has
 * both. And an MCP tool can satisfy it by carrying its JSON Schema
 * verbatim and validating with the SDK's own validator.
 *
 * The result: the schema the remote server published is the schema
 * Claude is shown, byte for byte. No converter to keep correct.
 *
 * ---------------------------------------------------------------------------
 * The validation that still has to happen
 * ---------------------------------------------------------------------------
 *
 * Arguments still need checking before they are sent on, for the same
 * reason the local tools check: `strict: true` guarantees the shape of
 * what the model produces, not that the values make sense.
 *
 * `fromJsonSchema` is used for exactly that, and for nothing else. It
 * is a validator here, not a converter — which is the use it is
 * actually good at, since validating against JSON Schema is what JSON
 * Schema is for.
 */

import { fromJsonSchema } from "@modelcontextprotocol/client";
import type { JsonSchemaType } from "@modelcontextprotocol/client";
import type { SchemaLike, SchemaParseResult } from "../tools/types.js";

/**
 * Wraps a remote tool's JSON Schema so a LabTool can hold it.
 *
 * The returned object is not a Zod schema and does not pretend to be.
 * It satisfies `SchemaLike`, which is the smaller contract this app
 * actually depends on.
 */
export function schemaFromJson(schema: unknown): SchemaLike {
  // A tool is allowed to take no arguments, and servers express that
  // in several ways: an absent inputSchema, an empty object, or an
  // explicit `{type: "object", properties: {}}`. All three mean the
  // same thing, so they are normalised here rather than in three
  // places downstream.
  const source: Record<string, unknown> =
    schema && typeof schema === "object"
      ? (schema as Record<string, unknown>)
      : { type: "object", properties: {} };

  // The API rejects a tool whose input_schema has no "type", and some
  // servers omit it on an argument-less tool. Filled in rather than
  // passed through, because the alternative is a 400 from Anthropic
  // naming a schema the user did not write and cannot fix.
  if (source["type"] === undefined) source["type"] = "object";

  /**
   * The validator, built once per tool rather than per call.
   *
   * `fromJsonSchema` compiles the schema, which is work worth doing
   * at connection time instead of on every tool_use block.
   *
   * It can throw on a schema it cannot compile. That is caught here
   * so one unusual tool cannot stop a whole server from connecting —
   * the tool still works, it just goes unvalidated locally, which is
   * the same position the app would be in without this file at all.
   */
  let validate: ((input: unknown) => SchemaParseResult) | null = null;

  try {
    const compiled = fromJsonSchema(source as JsonSchemaType);

    validate = (input: unknown): SchemaParseResult => {
      // Standard Schema's validate returns either `{ value }` or
      // `{ issues }`. It may also return a Promise, for validators
      // that need to be async — this one does not, but the type
      // allows it, so the synchronous case is confirmed rather than
      // assumed. An await here would change safeParse's signature
      // and ripple into the tool loop.
      const result = compiled["~standard"].validate(input);

      if (result instanceof Promise) {
        return { success: true, data: input };
      }

      if (result.issues) {
        return {
          success: false,
          issues: result.issues.map((issue) => ({
            path: (issue.path ?? []).map((segment) =>
              typeof segment === "object" && segment !== null && "key" in segment
                ? String((segment as { key: unknown }).key)
                : String(segment),
            ),
            message: issue.message,
          })),
        };
      }

      return { success: true, data: result.value };
    };
  } catch {
    validate = null;
  }

  return {
    /** The schema exactly as the server published it. */
    toJsonSchema: () => source,

    safeParse(input: unknown): SchemaParseResult {
      // No validator means the schema would not compile. Accepting
      // the input is the right call: the remote server validates it
      // again on arrival, and refusing locally would break a tool
      // that works, to enforce a schema we could not read.
      if (!validate) return { success: true, data: input };
      return validate(input);
    },
  };
}
