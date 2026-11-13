/**
 * api-format.ts — turns our tools into the shape the Messages API expects.
 *
 * A LabTool is built for us: it has a Zod schema and a run function. The
 * API wants something simpler and quite different:
 *
 *     {
 *       name: "calculator",
 *       description: "Performs exact arithmetic...",
 *       input_schema: { type: "object", properties: {...}, required: [...] }
 *     }
 *
 * Note what is NOT in that object: the run function. Claude is never told
 * how a tool works, only what it is called, what it does, and what
 * arguments it takes. The model decides *that* a tool should run and with
 * what; our server decides *how*.
 *
 * ---------------------------------------------------------------------------
 * Why Zod rather than hand-written JSON Schema
 * ---------------------------------------------------------------------------
 *
 * The API needs JSON Schema. We could write that by hand in each tool
 * file. The reason not to is that the same shape is needed twice: once to
 * tell Claude what arguments are valid, and once to check the arguments
 * that come back (step 44). Two hand-written copies drift — someone adds
 * a field to the validator and forgets the schema, and the model keeps
 * sending the old shape with no indication anything is wrong.
 *
 * One Zod schema generates both. It cannot drift from itself.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { AnyLabTool } from "./types.js";

/**
 * Converts one tool into an API tool definition.
 *
 * Exported separately from the plural version so a single tool can be
 * inspected in a test or a script without building the whole array.
 */
export function toApiTool(tool: AnyLabTool): Anthropic.Tool {
  // The schema asks itself for its JSON Schema form.
  //
  // For a local tool that is z.toJSONSchema under the hood — it
  // produces correct types, carries every .describe() through as a
  // "description", computes "required" from which fields are
  // optional, and sets additionalProperties: false.
  //
  // For a tool from an MCP server there is nothing to convert: the
  // server published JSON Schema and it is returned verbatim. See
  // SchemaLike in ./types.ts for why that distinction is kept out of
  // this file.
  //
  // Deep-copied before editing, and the depth matters.
  //
  // The steps below DELETE keys, and stripUnsupportedKeywords walks
  // the whole tree doing it. A local tool is unaffected either way —
  // z.toJSONSchema builds a fresh object per call — but an MCP tool
  // returns the schema its server published, the same object every
  // time. Editing that in place would strip the bounds permanently on
  // the first request instead of per request, and the Tools tab would
  // then show a schema missing the constraints the remote server
  // actually advertises.
  //
  // A shallow spread is not enough: it protects the top level while
  // leaving every nested `properties` object shared. structuredClone
  // is the one-line correct answer and has been in Node since 17.
  const schema = structuredClone(
    tool.inputSchema.toJsonSchema(),
  ) as Record<string, unknown>;

  // Drop the $schema declaration. The API does not need it, and it is
  // sent on every request for every tool — small, but it is pure waste,
  // and the request body is something worth keeping readable in the log
  // panel.
  delete schema["$schema"];

  // Guarantee a "required" array even when it is empty.
  //
  // Zod omits the key entirely when every field is optional, which is the
  // case for get_current_time. Strict mode is documented as needing both
  // additionalProperties: false and a required array; the API happens to
  // accept the omission today, but depending on that is depending on
  // leniency rather than on the contract. An explicit empty array costs
  // nothing and says what is meant.
  schema["required"] ??= [];

  // Guarantee additionalProperties: false, for the same reason.
  //
  // z.toJSONSchema sets this for every local tool, so for a long time
  // nothing here had to. An MCP tool's schema is the remote server's
  // own JSON Schema carried verbatim, and a server is under no
  // obligation to include the key — the MCP Lab's own tools do not.
  // Sending one of those alongside strict: true gets the whole request
  // rejected:
  //
  //   tools.6.custom: For 'object' type, 'additionalProperties' must be
  //   explicitly set to false
  //
  // Note "tools.6": the failure names the first BORROWED tool, and the
  // six local ones ahead of it are fine. That is the shape of every bug
  // in this file — an assumption that held because every tool came from
  // Zod, met by a tool that did not.
  //
  // Setting it rather than refusing to send the tool: strict mode's
  // contract is that the arguments match the schema's shape exactly,
  // and a schema that does not pin this is not describing a looser
  // tool, only an underspecified one. Anything the model sends beyond
  // the declared properties would be rejected by the remote server's
  // own validation anyway.
  normaliseObjectSchemas(schema);

  // Remove the numeric bounds that strict mode does not accept.
  //
  // Zod turns .min(1).max(5) into "minimum" and "maximum", and the API
  // rejects the whole request with:
  //
  //   tools.N.custom: For 'integer' type, properties maximum, minimum
  //   are not supported
  //
  // Strict mode constrains the SHAPE of the arguments — which fields
  // exist and of what type — not their values. The bounds are not lost:
  // the same Zod schema validates the arguments in step 44, where a
  // limit of 50 is rejected before the tool runs. Describing the range
  // in the field's .describe() text is what actually steers the model.
  stripUnsupportedKeywords(schema);

  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema as Anthropic.Tool["input_schema"],

    // strict: true asks the API to guarantee the arguments validate
    // against the schema exactly. It requires additionalProperties: false
    // and a "required" array, both of which z.toJSONSchema already
    // produces.
    //
    // This does not remove the need to validate in step 44. The guarantee
    // covers the shape; it does not cover whether the values make sense
    // for the tool, and a defensive parse at the point of execution costs
    // nothing.
    strict: true,
  };
}

/**
 * Sets additionalProperties: false on every object in a schema.
 *
 * Recursive, because a nested object is still an object as far as the
 * API's strict mode is concerned: a top-level fix would send a tool
 * whose outer shape is pinned and whose nested one is not, and the
 * request would be rejected naming the inner path instead.
 *
 * Only touches schemas that say type: "object". A node without a type,
 * or with some other type, is left exactly as the server published it
 * — this normalises for strict mode, it does not rewrite the server's
 * schema language.
 *
 * An explicit `true` is overwritten rather than respected. A server
 * asking for open-ended arguments cannot have that under strict mode,
 * and the choice is between tightening the schema and refusing to send
 * the tool at all.
 */
function normaliseObjectSchemas(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) normaliseObjectSchemas(item);
    return;
  }

  if (typeof node !== "object" || node === null) return;

  const record = node as Record<string, unknown>;

  if (record["type"] === "object") {
    record["additionalProperties"] = false;
  }

  for (const value of Object.values(record)) {
    normaliseObjectSchemas(value);
  }
}

/**
 * JSON Schema keywords the API rejects when strict mode is on.
 *
 * All of them constrain a VALUE rather than a shape. Strict mode
 * guarantees the arguments match the schema's structure; it deliberately
 * does not take on validating ranges and patterns, so these have to go.
 */
const UNSUPPORTED_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
] as const;

/**
 * Strips the unsupported keywords, everywhere in the schema.
 *
 * Recursive, because a constrained field can be nested inside an object,
 * an array's items, or a union — not only at the top level. Walking the
 * whole tree means a tool added later with a nested schema does not
 * reintroduce the 400 that this function exists to prevent.
 */
function stripUnsupportedKeywords(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripUnsupportedKeywords(item);
    return;
  }

  if (node === null || typeof node !== "object") return;

  const record = node as Record<string, unknown>;

  for (const keyword of UNSUPPORTED_KEYWORDS) {
    delete record[keyword];
  }

  for (const value of Object.values(record)) {
    stripUnsupportedKeywords(value);
  }
}

/**
 * Converts a list of tools.
 *
 * Returns undefined rather than an empty array when there is nothing to
 * send. The distinction matters: omitting `tools` means the model is
 * never told tools exist, which is what the Tools tab's "select none"
 * should produce. Sending `tools: []` is a different statement, and some
 * APIs treat an empty array as a validation error.
 */
export function toApiTools(tools: AnyLabTool[]): Anthropic.Tool[] | undefined {
  if (tools.length === 0) return undefined;
  return tools.map(toApiTool);
}
