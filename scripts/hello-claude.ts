/**
 * hello-claude.ts — the first real call to Claude.
 *
 * Run it with:  npm run hello    (or: npx tsx scripts/hello-claude.ts)
 *
 * This is the smallest complete request the Messages API accepts: a model, a
 * token ceiling, and a list of messages. Everything else this project does —
 * streaming, tools, the seven orchestration patterns — is a variation on the
 * shape below.
 *
 * One setup note: this is a command-line script with no browser attached, so
 * it cannot use the key you typed into the app's Settings dialog — that one
 * lives in the running web server's memory. Scripts in this folder read
 * ANTHROPIC_API_KEY from .env instead. See the Setup section of README.md.
 *
 * The one piece of real TypeScript learning here is how to read the response.
 * `response.content` is not a string. It is an array of content blocks, and
 * each block has a `type`. A reply can mix text with thinking summaries and
 * tool-use requests in a single response, so you must check the type of a
 * block before reading its fields.
 */

// The SDK's error classes are NAMED exports from the package root — they are
// not properties of the default export. `import Anthropic from ...` then
// `Anthropic.AuthenticationError` does not work in v1.
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { client, MissingKeyError, MODEL } from "../server/anthropic.js";

/**
 * Sends one message and prints whatever text comes back.
 */
async function main(): Promise<void> {
  console.log(`Asking ${MODEL}...\n`);

  // The request. Three required fields:
  //   model      — which Claude to use
  //   max_tokens — a hard ceiling on the reply length. Hitting it truncates
  //                the response mid-sentence, so do not set it meanly.
  //   messages   — the conversation so far. One user turn, in this case.
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content:
          "In two sentences, explain what the Anthropic Messages API is to " +
          "someone who has used no AI API before.",
      },
    ],
  });

  // response.content is ContentBlock[] — a discriminated union. TypeScript
  // will not let you read block.text until you have proved the block is a
  // text block, because a thinking block or a tool_use block has no .text.
  // This narrowing is the habit the certification expects.
  for (const block of response.content) {
    if (block.type === "text") {
      console.log(block.text);
    }
  }

  // --- The response metadata -------------------------------------------------
  //
  // Everything below comes back on every call and is worth knowing by name.

  console.log("\n" + "-".repeat(70));

  // stop_reason says WHY the model stopped. The ones you will meet:
  //
  //   end_turn    Claude finished naturally. What you want to see.
  //   max_tokens  It ran into your ceiling and was cut off mid-sentence.
  //               The reply is incomplete — raise max_tokens and retry.
  //   tool_use    It wants a tool run before it can continue (phase 7).
  //   refusal     A safety classifier declined. Check before reading content.
  //
  // Checking this before trusting the reply is a habit worth forming early.
  console.log(`stop_reason    ${response.stop_reason}`);

  // Which model actually served the request. Worth logging in real systems:
  // it is your evidence of what produced a given answer.
  console.log(`model          ${response.model}`);

  // Token counts. Input is everything you sent — system prompt, full message
  // history, tool definitions — not just the latest question. In a long
  // conversation the input count grows every turn while the output stays
  // roughly constant, which is why long chats get expensive.
  const { input_tokens, output_tokens } = response.usage;
  console.log(`input_tokens   ${input_tokens}`);
  console.log(`output_tokens  ${output_tokens}`);

  // A rough cost, so the number means something. Claude Opus 5.5 is
  // $4 per million input tokens and $20 per million output tokens.
  // Published rates change: treat this as indicative, not as billing.
  const cost = (input_tokens / 1_000_000) * 4 + (output_tokens / 1_000_000) * 20;
  console.log(`approx cost    $${cost.toFixed(6)}`);
}

/**
 * Turns a thrown error into a readable message.
 *
 * The SDK exports a typed class for each kind of failure, and the order of
 * these checks matters: every one of them is also an `APIError`, so the
 * specific cases must come first or the general case swallows them. Catching
 * one broad class is the common mistake — it loses the distinction between a
 * failure worth retrying (429, 5xx, a dropped connection) and one that will
 * fail identically every time (401, 404).
 *
 * Note that none of these are string matches on the error message. Message
 * text changes between SDK versions; the classes do not.
 */
function explain(error: unknown): string {
  // No key at all. This script reads .env only — a key set in the app's
  // Settings dialog lives in the web server's memory, which this process
  // cannot see.
  if (error instanceof MissingKeyError) {
    return [
      "No API key found.",
      "",
      "This script reads ANTHROPIC_API_KEY from .env. A key you typed into",
      "the app's Settings dialog will not work here — that one is held in",
      "the running web server's memory, and this is a separate process.",
      "",
      "  1. Copy .env.example to .env",
      "  2. Put your key in it, then re-run",
      "  3. Check it with:  npm run check-env",
    ].join("\n");
  }

  // 401 — the key is missing, malformed, revoked, or being sent somewhere
  // that does not recognise it. Retrying will not help.
  if (error instanceof AuthenticationError) {
    return [
      "Authentication failed (HTTP 401).",
      "",
      "The API key was rejected. Things to check, in order:",
      "  1. Is ANTHROPIC_API_KEY set in .env?   npm run check-env",
      "  2. Is the key still valid?     https://console.anthropic.com/settings/keys",
      "  3. Is the request going where you think? An ANTHROPIC_BASE_URL in",
      "     your environment silently reroutes calls through a gateway, and",
      "     the gateway will reject a key it does not know.",
    ].join("\n");
  }

  // 404 — usually a typo in the model ID rather than a missing endpoint.
  if (error instanceof NotFoundError) {
    return "Not found (HTTP 404). Usually a misspelled model ID — check MODEL in server/anthropic.ts.";
  }

  // 429 — you are over your rate limit. Worth retrying after a wait.
  if (error instanceof RateLimitError) {
    return "Rate limited (HTTP 429). Wait and retry; back off if it keeps happening.";
  }

  // The request never got a response: no network, DNS failure, timeout.
  // This must be tested before APIError, because it is a subclass of it.
  if (error instanceof APIConnectionError) {
    return "Could not reach the API. Check your network connection.";
  }

  // Any other API failure. Last of the SDK checks, because every class above
  // also satisfies this one — put it first and it would swallow them all.
  if (error instanceof APIError) {
    return `API error (HTTP ${error.status ?? "unknown"}): ${error.message}`;
  }

  // Not an SDK error at all — a bug in this script, most likely.
  return `Unexpected error: ${String(error)}`;
}

// Top-level error handling. Without this, a rejected promise prints an
// unhandled-rejection trace, which buries the useful line in stack frames.
//
// Note `process.exitCode = 1` rather than `process.exit(1)`. Setting the code
// lets Node finish closing its sockets and then exit on its own; calling
// exit() kills the process while the failed HTTPS connection is still being
// torn down, which on Windows trips an assertion inside libuv and reports a
// confusing exit code 127 instead of the 1 you asked for.
main().catch((error: unknown) => {
  console.error("\n" + explain(error));
  process.exitCode = 1;
});
