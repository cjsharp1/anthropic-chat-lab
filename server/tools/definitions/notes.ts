/**
 * notes.ts — a scratchpad Claude can write to and read back.
 *
 * The first tool here with *state*. The calculator and the clock answer
 * from nothing: give them the same input twice and you get the same output
 * twice. This one remembers, which introduces a set of questions the
 * earlier tools did not raise.
 *
 * ---------------------------------------------------------------------------
 * Why this is interesting
 * ---------------------------------------------------------------------------
 *
 * The conversation history (step 26) is one kind of memory: everything
 * said, resent in full on every turn, and paid for in input tokens each
 * time. This is a different kind. The note lives on the server, costs
 * nothing to keep, and only enters the conversation when Claude asks for
 * it. A long document stored here and retrieved on demand is far cheaper
 * than the same document pasted into the history and resent forever.
 *
 * That is the beginning of the idea behind retrieval, and behind
 * Anthropic's memory tool: keep things outside the context window, and
 * bring in only what the current turn needs.
 *
 * ---------------------------------------------------------------------------
 * Why a Map, and what is wrong with it
 * ---------------------------------------------------------------------------
 *
 * The store below is a module-level Map, which means:
 *
 *   - It is lost when the server restarts. Fine for teaching; useless for
 *     anything real.
 *   - It is SHARED BY EVERY USER of this server. There is no per-session
 *     isolation at all. On a machine running this locally that is nobody;
 *     deployed as-is, one person's notes would be readable by the next.
 *
 * Both are deliberate simplifications, and both are named here rather than
 * left for someone to discover. A real version would key the store by
 * session and persist it somewhere. The shape of the tool would not change.
 */

import { z } from "zod";
import { defineTool } from "../types.js";

/**
 * The notes themselves.
 *
 * Module-level, so it survives between tool calls within a server run —
 * which is exactly the property being demonstrated — but not between
 * restarts. See the header for why that is not good enough for real use.
 */
const notes = new Map<string, string>();

/** Stops a runaway loop filling memory with notes. */
const MAX_NOTES = 100;

const inputSchema = z.object({
  action: z
    .enum(["save", "get", "list", "delete"])
    .describe("What to do: save a note, get one back, list all keys, or delete one"),

  key: z
    .string()
    .optional()
    .describe(
      'A short name for the note, like "user_preference" or "draft_intro". ' +
        "Required for save, get and delete. Ignored for list.",
    ),

  value: z
    .string()
    .optional()
    .describe("The text to store. Required for save; ignored otherwise."),
});

export const notesTool = defineTool({
  name: "notes",

  description:
    "A scratchpad that persists across turns in this conversation. Use it " +
    "to remember something for later without keeping it in the " +
    "conversation: a user preference, an intermediate result, a draft. " +
    "Actions are save, get, list and delete. Notes survive between " +
    "messages but are lost when the server restarts.",

  // A prompt that reliably triggers this tool, with a note on
  // what to watch for. Shown in the Tools tab: a tool nobody
  // knows how to invoke teaches nothing.
  examplePrompt: "Save a note called deadline saying Friday, then list my notes.",
  exampleWatch:
    "Two calls in sequence, the second seeing what the first stored. That persistence between calls is what distinguishes this from the stateless tools.",

  inputSchema,

  run: async ({ action, key, value }) => {
    switch (action) {
      case "save": {
        // The schema cannot express "key is required when action is save"
        // without becoming a discriminated union, which would make the
        // JSON Schema harder for the model to read. Checking here and
        // returning a clear message is the better trade: Claude reads the
        // error and retries correctly.
        if (!key) throw new Error('A "key" is required to save a note.');
        if (value === undefined) {
          throw new Error('A "value" is required to save a note.');
        }

        if (!notes.has(key) && notes.size >= MAX_NOTES) {
          throw new Error(
            `The scratchpad is full (${MAX_NOTES} notes). Delete one first.`,
          );
        }

        const replacing = notes.has(key);
        notes.set(key, value);

        // Say which happened. "Saved" when it silently replaced something
        // would hide a mistake the model could otherwise correct.
        return replacing
          ? `Replaced the existing note "${key}" (${value.length} characters).`
          : `Saved note "${key}" (${value.length} characters).`;
      }

      case "get": {
        if (!key) throw new Error('A "key" is required to get a note.');

        const stored = notes.get(key);
        if (stored === undefined) {
          // Not an error — a missing note is a normal answer to a lookup.
          // Listing what does exist saves the model a second call.
          const available = [...notes.keys()];
          return available.length === 0
            ? `No note called "${key}". The scratchpad is empty.`
            : `No note called "${key}". Available keys: ${available.join(", ")}.`;
        }

        return `Note "${key}": ${stored}`;
      }

      case "list": {
        if (notes.size === 0) return "The scratchpad is empty.";

        // Keys with sizes rather than full contents: a list of twenty long
        // notes would flood the context for no benefit. The model can
        // fetch the one it wants.
        const summary = [...notes.entries()]
          .map(([k, v]) => `  ${k} (${v.length} characters)`)
          .join("\n");

        return `${notes.size} note(s):\n${summary}`;
      }

      case "delete": {
        if (!key) throw new Error('A "key" is required to delete a note.');

        return notes.delete(key)
          ? `Deleted note "${key}".`
          : `There was no note called "${key}" to delete.`;
      }
    }
  },
});

/**
 * Empties the scratchpad.
 *
 * Exported for the Clear button in step 65 — clearing the conversation
 * should clear what was remembered during it, or the next conversation
 * starts with notes it never took.
 */
export function clearNotes(): void {
  notes.clear();
}
