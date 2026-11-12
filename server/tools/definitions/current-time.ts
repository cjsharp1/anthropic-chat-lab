/**
 * current-time.ts — tells Claude what time it is.
 *
 * The clearest possible example of why tools exist at all.
 *
 * A model's knowledge comes from training, which finished at some point in
 * the past. It cannot know today's date, and — more importantly — it cannot
 * know that it does not know. Asked the time without a tool, a model will
 * often produce a confident, plausible, wrong answer, because producing
 * plausible text is what it does.
 *
 * Tools fix a specific class of problem: facts that are true now, that were
 * not true during training, or that are specific to this user or this
 * machine. The time is the purest case. Others are the contents of a
 * database, the weather, a stock price, or what is in a file on disk.
 *
 * Worth trying in the app: turn this tool off in the Tools tab, ask what
 * time it is, and see what comes back. Then turn it on and ask again.
 */

import { z } from "zod";
import { defineTool } from "../types.js";

const inputSchema = z.object({
  /**
   * An IANA timezone name.
   *
   * Optional, defaulting to UTC. The `.describe()` text becomes part of the
   * JSON Schema the model sees, so giving an example here measurably
   * improves the chance of a well-formed call — the model copies the
   * format it is shown.
   */
  timezone: z
    .string()
    .optional()
    .describe(
      'IANA timezone name, for example "Europe/London", "America/New_York" ' +
        'or "Asia/Tokyo". Defaults to UTC if not given.',
    ),
});

export const currentTime = defineTool({
  name: "get_current_time",

  description:
    "Returns the current date and time. Use this whenever the answer " +
    "depends on what the time or date is now — you have no way to know " +
    "this otherwise, and guessing will be wrong. Accepts an optional IANA " +
    "timezone name; defaults to UTC.",

  // A prompt that reliably triggers this tool, with a note on
  // what to watch for. Shown in the Tools tab: a tool nobody
  // knows how to invoke teaches nothing.
  examplePrompt: "What time is it in Tokyo and in London?",
  exampleWatch:
    "Two timezones, so two tool calls dispatched at once. Untick this tool and ask again: Claude will say it cannot know, which is the honest answer and the reason the tool exists.",

  inputSchema,

  run: async ({ timezone }) => {
    const zone = timezone ?? "UTC";
    const now = new Date();

    try {
      // Intl does the real work, including daylight saving. Rolling your
      // own timezone arithmetic is a well-known way to be subtly wrong
      // twice a year.
      const formatted = new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(now);

      // The ISO timestamp is included alongside the readable form because
      // the two serve different purposes: one for the model to repeat to a
      // person, one for it to reason with if asked to compute a difference.
      return `${formatted}\n(ISO 8601, UTC: ${now.toISOString()})`;
    } catch (error: unknown) {
      // Intl throws a RangeError for an unrecognised timezone. Catching it
      // and naming the bad value lets Claude correct itself and call again,
      // which it generally does. An unhandled throw would just be an error.
      if (error instanceof RangeError) {
        throw new Error(
          `"${zone}" is not a recognised IANA timezone name. ` +
            'Use a name like "Europe/London" or "America/New_York".',
        );
      }
      throw error;
    }
  },
});
