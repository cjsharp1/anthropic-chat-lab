/**
 * extract.ts — getting structured data back instead of prose.
 *
 * Everything else in this app asks Claude for text. This asks for an
 * object, and gets one that is guaranteed to match a schema.
 *
 * ---------------------------------------------------------------------------
 * Why not just ask for JSON
 * ---------------------------------------------------------------------------
 *
 * You can. "Reply with JSON matching this shape" works most of the
 * time, and the rest of the time you get:
 *
 *   ```json
 *   { "topic": "caching" }
 *   ```
 *
 * ...wrapped in a code fence, or prefaced with "Here's the JSON you
 * asked for:", or with a trailing sentence offering to explain it.
 * Every one of those is a crash in code that calls JSON.parse on the
 * reply, and they arrive unpredictably — the same prompt behaves
 * differently on a different model, or on a longer question.
 *
 * `output_config.format` removes the failure mode rather than
 * handling it. The API constrains generation so the output cannot be
 * anything but valid JSON matching the schema. There is no fence to
 * strip and no preamble to detect.
 *
 * ---------------------------------------------------------------------------
 * What it is actually for
 * ---------------------------------------------------------------------------
 *
 * Any time a model's output feeds code rather than a person:
 * classification, extraction, routing decisions, scoring, pulling
 * fields out of a document. The orchestrator uses it for its plan and
 * the evaluator for its verdict — both cases where prose would have
 * to be parsed, and parsing prose is where these things break.
 */

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { apiModelId, getClient } from "./anthropic.js";
import { summariseUsage } from "./usage.js";
import type { Logger } from "./logger.js";

/**
 * What to extract from a message.
 *
 * Each field carries a `.describe()`, and those descriptions are the
 * only instructions the model gets about what the field means — they
 * become part of the JSON Schema sent with the request. A field named
 * `difficulty` with no description is a guess; one that says what the
 * levels mean is an instruction.
 */
const ExtractionSchema = z.object({
  topic: z
    .string()
    .describe(
      "The main subject, in two to five words. A noun phrase, not a " +
        "sentence.",
    ),

  difficulty: z
    .enum(["beginner", "intermediate", "advanced"])
    .describe(
      "How much prior knowledge the question assumes. 'beginner' needs " +
        "no API experience; 'advanced' assumes familiarity with the " +
        "Messages API and its failure modes.",
    ),

  keywords: z
    .array(z.string())
    .describe(
      "Three to six specific terms from the question — API field names, " +
        "concepts, error classes. Lowercase. Not generic words like " +
        "'question' or 'help'.",
    ),

  isAboutThisApi: z
    .boolean()
    .describe(
      "True if the question concerns the Anthropic Claude API " +
        "specifically, rather than LLMs or programming in general.",
    ),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

/** What the extraction cost and produced. */
export interface ExtractionResult {
  data: Extraction | null;
  model: string;
  cost: number;
  elapsedMs: number;
  /** The raw text, so the constrained output can be seen for what it is. */
  raw: string;
}

/**
 * Extracts structured fields from a message.
 *
 * Runs on whichever model is assigned the "deciding" role, because
 * this is exactly that kind of job: short structured output, no
 * reasoning, nobody reads it directly.
 */
export async function extractFields(
  message: string,
  model: string,
  log: Logger,
): Promise<ExtractionResult> {
  const started = Date.now();

  // Built once, then both logged and sent.
  //
  // The alternative — writing a description of the request into the log
  // and constructing the real one separately — produces a log that
  // drifts from what actually went over the wire. This app had that bug
  // once already; the fix is to have exactly one object.
  const request = {
    model: apiModelId(model),
    max_tokens: 500,
    system:
      "Extract the requested fields from the user's message. Do not " +
      "answer the question — only describe it.",
    messages: [{ role: "user" as const, content: message }],
    output_config: { format: zodOutputFormat(ExtractionSchema) },
  };

  log.api("Request → Anthropic: extract structured fields", request, {
    direction: "out",
    actor: "user",
    because:
      "You asked for structured output. This is its own request, " +
      "separate from the chat: it describes your message rather than " +
      "answering it. Note output_config.format below — that field is " +
      "what constrains generation to the schema, so the reply cannot " +
      "come back as prose or wrapped in a code fence.",
  });

  const response = await getClient().messages.parse(request);

  const usage = summariseUsage(response.usage, response.model);

  // The text blocks hold the JSON. Worth keeping alongside the parsed
  // object: seeing that the raw output IS the JSON, with no fence and
  // no preamble, is the point of the exercise.
  const raw = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const parsed = (response.parsed_output as Extraction | undefined) ?? null;

  log.api("Response ← Anthropic: structured fields", {
    stop_reason: response.stop_reason,
    tokens: {
      input: usage.input,
      output: usage.output,
      total_input: usage.totalInput,
    },
    cost: usage.cost,
    // Both halves, deliberately. Seeing that the raw text and the
    // parsed object carry the same characters — no fence to strip, no
    // preamble to skip past — is the whole lesson of this feature.
    raw_text: raw,
    parsed_output: parsed,
  }, {
    direction: "in",
    actor: "claude",
    because:
      "Generation was constrained to the schema, so this parsed " +
      "without a try/catch around JSON.parse. Compare raw_text with " +
      "parsed_output: they are the same characters.",
  });

  return {
    data: parsed,
    model: response.model,
    cost: usage.cost,
    elapsedMs: Date.now() - started,
    raw,
  };
}
