/**
 * try-notes.ts — exercises the notes tool without involving Claude.
 *
 * Run it with:  npx tsx scripts/try-notes.ts
 *
 * The point it demonstrates is state. Each call below is independent — the
 * tool is not told what happened before — and yet the second call can see
 * what the first one stored. That is the difference between this tool and
 * the calculator, and it is why a tool can act as memory.
 *
 * Running tools directly like this is a habit worth keeping. A tool that
 * misbehaves inside a conversation is hard to diagnose, because the model's
 * choices and the tool's behaviour are tangled together. Here there is no
 * model: if it is wrong, it is the tool.
 */

import { notesTool, clearNotes } from "../server/tools/definitions/notes.js";

/** Calls the tool and prints the result, or the error it threw. */
async function call(input: Record<string, unknown>): Promise<void> {
  const label = JSON.stringify(input);
  try {
    const result = await notesTool.run(input as never);
    console.log(`  ${label}\n    -> ${result.replace(/\n/g, "\n       ")}`);
  } catch (error: unknown) {
    console.log(`  ${label}\n    -> THREW: ${(error as Error).message}`);
  }
}

console.log("=== empty to begin with ===");
await call({ action: "list" });

console.log("\n=== save, then read it back in a separate call ===");
await call({ action: "save", key: "user_name", value: "Chris" });
await call({ action: "get", key: "user_name" });

console.log("\n=== the state persists across further calls ===");
await call({ action: "save", key: "goal", value: "Pass the Anthropic certification" });
await call({ action: "list" });

console.log("\n=== replacing says so, rather than silently overwriting ===");
await call({ action: "save", key: "user_name", value: "Chris S" });
await call({ action: "get", key: "user_name" });

console.log("\n=== a missing note is an answer, not an error ===");
await call({ action: "get", key: "never_saved" });

console.log("\n=== delete ===");
await call({ action: "delete", key: "goal" });
await call({ action: "delete", key: "goal" });
await call({ action: "list" });

console.log("\n=== missing arguments give a usable message ===");
await call({ action: "save", key: "no_value" });
await call({ action: "get" });

console.log("\n=== clearNotes empties it (used by Clear in step 65) ===");
clearNotes();
await call({ action: "list" });
