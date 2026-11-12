/**
 * flaky-service.ts — a tool that fails on purpose.
 *
 * Every other tool here works. That makes them poor teaching material for
 * the half of tool use that matters most in production: what happens when
 * a tool does not work.
 *
 * Real tools fail constantly. A network call times out, a database is
 * briefly unavailable, an upstream API returns 503, a record is missing,
 * a rate limit is hit. The interesting question is not whether failures
 * happen, it is what the model does when one does — and you cannot study
 * that with tools that always succeed.
 *
 * ---------------------------------------------------------------------------
 * Why the failure rate is a parameter
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation fails randomly half the time. That is useless
 * in a classroom: the demonstration works or does not depending on luck,
 * and you cannot show the same behaviour twice.
 *
 * So failRate is an input the model can set. At 1 it always fails, at 0 it
 * never does, and in between it is genuinely random. A lesson can ask for
 * a guaranteed failure, watch Claude handle it, then ask for a guaranteed
 * success — reproducibly, in front of people.
 *
 * ---------------------------------------------------------------------------
 * What to watch for in the log panel
 * ---------------------------------------------------------------------------
 *
 * Ask Claude to call this with failRate 1 and watch what it does. Good
 * behaviour is: call it, see the error, maybe retry once or twice, then
 * tell the user it is unavailable. Bad behaviour — which you may also see,
 * and which is worth discussing — is retrying indefinitely, or inventing a
 * plausible result rather than reporting the failure.
 *
 * The iteration cap in step 41 exists precisely because the first failure
 * mode is real.
 */

import { z } from "zod";
import { defineTool } from "../types.js";

/** The kinds of failure this can simulate. */
const failureModes = {
  timeout: "The request to the inventory service timed out after 5000ms.",
  unavailable: "The inventory service returned 503 Service Unavailable.",
  rate_limited:
    "The inventory service returned 429 Too Many Requests. Retry after 30s.",
  bad_response:
    "The inventory service returned malformed JSON and could not be parsed.",
  not_found: "No record exists for that item ID in the inventory service.",
} as const;

type FailureMode = keyof typeof failureModes;

const inputSchema = z.object({
  itemId: z
    .string()
    .min(1)
    .describe('The item to look up, for example "widget-42".'),

  failRate: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Probability that this call fails, from 0 to 1. Use 1 to guarantee " +
        "a failure and 0 to guarantee success. Defaults to 0.5. This " +
        "exists so failures can be demonstrated on demand.",
    ),

  failureMode: z
    .enum(["timeout", "unavailable", "rate_limited", "bad_response", "not_found"])
    .optional()
    .describe(
      "Which kind of failure to simulate when the call fails. Defaults to " +
        "a random one.",
    ),
});

/** Counts calls and failures, so the log can report the real rate. */
let callCount = 0;
let failureCount = 0;

export const flakyService = defineTool({
  name: "flaky_service",

  description:
    "Looks up an item in a simulated inventory service that is " +
    "deliberately unreliable. It exists to demonstrate how tool failures " +
    "behave: set failRate to 1 to guarantee an error, or 0 to guarantee " +
    "success. The data it returns is fabricated and means nothing — only " +
    "the success or failure is real.",

  // A prompt that reliably triggers this tool, with a note on
  // what to watch for. Shown in the Tools tab: a tool nobody
  // knows how to invoke teaches nothing.
  examplePrompt: "Look up widget-42 in the inventory with failRate 1, and retry twice.",
  exampleWatch:
    "Guaranteed failure. Watch Claude read the error, retry, and then report honestly rather than inventing a result — the failure message is written for the model to act on.",

  inputSchema,

  run: async ({ itemId, failRate, failureMode }) => {
    callCount += 1;

    const rate = failRate ?? 0.5;

    // A short delay, so the timing in the log panel looks like a real
    // network call rather than an instant local function. It also makes
    // the parallel execution in step 42 visibly concurrent: three calls
    // taking 300ms each finish in 300ms together, not 900ms in sequence.
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 200));

    if (Math.random() < rate) {
      failureCount += 1;

      const mode: FailureMode =
        failureMode ??
        (Object.keys(failureModes) as FailureMode[])[
          Math.floor(Math.random() * Object.keys(failureModes).length)
        ]!;

      // Thrown rather than returned. Step 43 catches this and sends it
      // back as a tool_result with is_error set, which is what lets Claude
      // respond to the failure instead of the whole request collapsing.
      //
      // The message is written for the model to read, not for a log file.
      // "503 Service Unavailable" tells it something it can act on;
      // "Error" does not.
      throw new Error(
        `${failureModes[mode]} (call ${callCount}, ${failureCount} failed so far)`,
      );
    }

    // Fabricated data. Deliberately obvious nonsense, so nobody mistakes
    // this for a tool that returns real information.
    const quantity = Math.floor(Math.random() * 500);
    const locations = ["Warehouse A", "Warehouse B", "Depot 3", "In transit"];
    const location = locations[Math.floor(Math.random() * locations.length)]!;

    return (
      `Item ${itemId}: ${quantity} units in stock at ${location}. ` +
      `(Simulated data — call ${callCount}, ${failureCount} failed so far.)`
    );
  },
});

/** Resets the counters. Used by the Clear button in step 65. */
export function resetFlakyCounters(): void {
  callCount = 0;
  failureCount = 0;
}
