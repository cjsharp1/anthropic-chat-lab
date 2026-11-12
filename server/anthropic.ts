/**
 * anthropic.ts — the one place this project talks to Anthropic from.
 *
 * Everything that calls Claude imports `client` from here. Two reasons:
 *
 *   1. One client, not one per request. The SDK client holds a connection pool
 *      and retry settings. Constructing a new one on every request throws that
 *      away and opens a fresh TCP + TLS connection each time — slower, and it
 *      leaks sockets under load.
 *
 *   2. One place to change settings. Timeouts, retries, a different model, a
 *      proxy — all of it is edited here rather than hunted for across files.
 *
 * Note what this file does NOT contain: an API key. The key lives in
 * server/api-key.ts, where it can be changed at runtime from the app's
 * Settings dialog. This file only asks for it when building a client.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getKey } from "./api-key.js";

/**
 * The model every call in this project uses.
 *
 * Kept as a named constant so a class can change one line and watch the whole
 * app behave differently — cost, speed and answer quality all move together.
 *
 * Model IDs are complete as written: never append a date suffix.
 */
export const MODEL = "claude-opus-5-5";

/**
 * A cheaper, faster model for work that does not need the main one.
 *
 * Used by the routing pattern (step 51), where a small model classifies the
 * question and the main model answers it. Seeing both token bills side by side
 * in the log panel is the point of that exercise.
 */
export const SMALL_MODEL = "claude-haiku-5-5";

/**
 * Default output ceiling for a single response.
 *
 * This is a hard cap the model is not aware of: hitting it truncates the reply
 * mid-sentence rather than letting Claude finish. 16000 is a sensible default
 * for non-streaming calls. Streaming calls can afford far more, because the
 * long wait that would otherwise time out the HTTP request is broken up.
 */
export const MAX_TOKENS = 16000;

/**
 * Thrown when something tries to call Claude with no key set.
 *
 * Its own class so the routes can tell this apart from an SDK failure: this
 * one is answered by opening Settings, not by retrying or checking the
 * network. See the handler in server/index.ts.
 */
export class MissingKeyError extends Error {
  constructor() {
    super(
      "No API key is set. Open Settings and paste your Anthropic API key to start.",
    );
    this.name = "MissingKeyError";
  }
}

/**
 * The cached SDK client, and the key it was built with.
 *
 * Caching on the key rather than building once at import time is what makes a
 * runtime key change possible. The pool is still shared across every request
 * that uses the same key — a new client is constructed only when the key
 * actually changes, which happens when someone saves one in Settings.
 */
let cached: Anthropic | null = null;
let cachedKey: string | null = null;

/**
 * Returns an SDK client for the current key, building one if needed.
 *
 * Both settings below are passed explicitly rather than left to the SDK's
 * environment detection. Many corporate machines reach Claude through an LLM
 * gateway, configured in the shell environment as ANTHROPIC_BASE_URL and
 * ANTHROPIC_AUTH_TOKEN. The SDK picks those up automatically, so on such a
 * machine this app would silently route through the gateway — and a 401 from
 * a gateway that does not recognise your key looks exactly like a bad key.
 *
 * For a training app we want the plain, documented path instead, so that what
 * you see here matches the certification material and the official examples
 * line for line.
 *
 *   baseURL  pinned to the public API, ignoring any ANTHROPIC_BASE_URL
 *   apiKey   taken from api-key.ts only, ignoring any ANTHROPIC_AUTH_TOKEN
 */
function getClient(): Anthropic {
  const key = getKey();

  if (key === null) throw new MissingKeyError();

  // Reuse the existing client whenever the key has not changed. This is the
  // normal path: one client for the whole session.
  if (cached !== null && cachedKey === key) return cached;

  cached = new Anthropic({
    baseURL: "https://api.anthropic.com",
    apiKey: key,
  });
  cachedKey = key;

  return cached;
}

/**
 * The shared client, as every caller sees it.
 *
 * This is a Proxy rather than an Anthropic instance, because the real client
 * cannot be built at import time any more — at that point there may be no key,
 * and the key can change later. The Proxy defers the decision: each property
 * access (`client.messages`) resolves against whichever client the current key
 * calls for.
 *
 * The payoff is that nothing else in the codebase had to change. Every call
 * site still reads `client.messages.create(...)`, and the eight files that
 * import this do not need to know a key can arrive late.
 *
 * The cast is needed because a Proxy's type cannot be inferred from its
 * handler. The handler forwards every property to a real Anthropic instance,
 * so the surface genuinely is an Anthropic — TypeScript just cannot see that.
 */
export const client = new Proxy({} as Anthropic, {
  get(_target, property, receiver) {
    const real = getClient();
    const value = Reflect.get(real, property, receiver);

    // Methods must stay bound to the real client. Without this, pulling a
    // function off the proxy and calling it would run with the wrong `this`
    // and fail inside the SDK.
    return typeof value === "function" ? value.bind(real) : value;
  },
}) as Anthropic;
