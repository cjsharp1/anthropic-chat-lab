/**
 * anthropic.ts — the one place this project creates a Claude SDK client.
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
import { getKey, getProvider, type ApiProvider } from "./api-key.js";

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
      "No API key is set. Open Settings and paste the selected provider's key to start.",
    );
    this.name = "MissingKeyError";
  }
}

/**
 * The cached SDK client and the provider/key pair it was built with.
 *
 * Caching on the provider/key pair rather than building once at import time
 * makes runtime key and provider changes possible. The pool is still shared
 * for each configuration; a new client is built only when that pair changes.
 */
let cached: Anthropic | null = null;
let cachedKey: string | null = null;
let cachedProvider: ApiProvider | null = null;
let cachedBaseURL: string | null = null;

/**
 * Returns an SDK client for the current key, building one if needed.
 *
 * Call this at the point of use — `getClient().messages.create(...)` —
 * and never store the result. The key can arrive after startup, from
 * the Settings dialog, and can change while the process runs. A
 * module-level `const client = getClient()` would capture whatever
 * key existed at import time, which on a fresh clone is none at all.
 *
 * The caching below means that costs nothing: the same client comes
 * back every time until the selected provider or key changes.
 *
 * Provider settings are passed explicitly rather than left to the SDK's
 * environment detection. Portkey is selected deliberately in Settings or
 * with AI_PROVIDER. The configured ANTHROPIC_BASE_URL is used only in
 * Portkey mode; direct Anthropic calls ignore it. Portkey mode also sends
 * the `x-portkey-provider` header, built from PORTKEY_PROVIDER.
 *
 * For a training app we want the plain, documented path instead, so that what
 * you see here matches the certification material and the official examples
 * line for line.
 *
 *   baseURL  chosen from the selected provider
 *   apiKey   taken from api-key.ts only, never from SDK environment detection
 */
export function getClient(): Anthropic {
  const key = getKey();
  const provider = getProvider();

  if (key === null) throw new MissingKeyError();

  const baseURL =
    provider === "portkey" ? getPortkeyBaseURL() : "https://api.anthropic.com";

  if (
    cached !== null &&
    cachedKey === key &&
    cachedProvider === provider &&
    cachedBaseURL === baseURL
  ) {
    return cached;
  }

  // Portkey picks the upstream provider from this header. Setting it here,
  // rather than through ANTHROPIC_CUSTOM_HEADERS (which the SDK also reads),
  // keeps the routing visible in this file.
  const defaultHeaders: Record<string, string> =
    provider === "portkey"
      ? { "x-portkey-provider": `@${getPortkeyProviderSlug()}` }
      : {};

  cached = new Anthropic({
    baseURL,
    apiKey: key,
    defaultHeaders,
  });
  cachedKey = key;
  cachedProvider = provider;
  cachedBaseURL = baseURL;

  return cached;
}

/** Uses the configured Portkey gateway, falling back to Portkey's public URL. */
function getPortkeyBaseURL(): string {
  const configured = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!configured) return "https://api.portkey.ai";

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(
      "ANTHROPIC_BASE_URL must be an absolute HTTPS URL when using Portkey.",
    );
  }

  if (url.protocol !== "https:") {
    throw new Error(
      "ANTHROPIC_BASE_URL must use HTTPS when using Portkey.",
    );
  }

  return configured.replace(/\/+$/, "");
}

/**
 * Portkey names a Vertex-hosted Claude model `anthropic.<model-id>`, and
 * routes it to the provider named in the `x-portkey-provider` header set in
 * getClient(). Keep the app's model ids provider-neutral for pricing and the
 * UI, and add the prefix only at the API boundary.
 *
 * The other Portkey form, `@<provider>/<model-id>`, is deliberately not used:
 * a Vertex-backed gateway rejects it with "messages is not supported by
 * vertex-ai", even when the header is present.
 */
export function apiModelId(model: string): string {
  if (getProvider() !== "portkey" || model.startsWith("anthropic.")) {
    return model;
  }

  return `anthropic.${model}`;
}

/** Returns the provider slug configured in Portkey's Model Catalog, without the "@". */
function getPortkeyProviderSlug(): string {
  const configured = process.env.PORTKEY_PROVIDER?.trim() || "anthropic";
  const slug = configured.startsWith("@") ? configured.slice(1) : configured;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(slug)) {
    throw new Error(
      "PORTKEY_PROVIDER must be a Model Catalog provider slug, optionally prefixed with '@'.",
    );
  }
  return slug;
}
