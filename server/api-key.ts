/**
 * api-key.ts — the one place the provider API key lives.
 *
 * The key is held in a module-level variable rather than read from the
 * environment at every call site. That is what lets it be set from the app's
 * Settings dialog while the server is running: `setKey()` replaces the value,
 * and the next request uses the selected provider.
 *
 * Two rules this module exists to enforce:
 *
 *   1. The key is never sent to the browser. The frontend can ask whether a
 *      key is set and see a masked hint, and that is all. `getKey()` is for
 *      server code building an SDK client; nothing routes its result into a
 *      response body.
 *
 *   2. The key is never written to disk. It lives in memory for the lifetime
 *      of the process, so closing the server forgets it. An optional .env
 *      value seeds it at startup for anyone who would rather not retype it —
 *      see below — but this module never creates or edits that file.
 *
 * The in-memory choice is a deliberate trade. A key typed into Settings is
 * gone after a restart. The alternative — writing it somewhere — turns every
 * crash, backup and sync tool into something that might carry a secret off
 * the machine. For a teaching app run on a laptop, retyping is cheaper than
 * that risk.
 */

import "dotenv/config"; // so a .env key is visible to the seed below

/**
 * Where the active key came from.
 *
 * Shown in the UI so it is clear why a key is already present on a fresh
 * page load — otherwise a key seeded from .env looks like the app
 * remembered something it should not have.
 */
export type KeySource = "env" | "settings";
export type ApiProvider = "anthropic" | "portkey";

/** What the frontend is allowed to know about the key. */
export interface KeyStatus {
  /** Whether a usable key is currently set. */
  set: boolean;
  /** A masked fragment — enough to tell two keys apart, not enough to use. */
  hint: string | null;
  /** Where the active key came from, or null when none is set. */
  source: KeySource | null;
  /** Which gateway receives model requests. */
  provider: ApiProvider;
}

/**
 * The live key. `null` means no provider credential is set.
 *
 * Not exported: everything outside this module goes through the functions
 * below, so there is exactly one way to read it and one way to change it.
 */
let currentKey: string | null = null;

/** Where `currentKey` came from. Meaningless when `currentKey` is null. */
let currentSource: KeySource | null = null;

const envProvider = readEnvProvider();
const envKey = readEnvKey(envProvider);
let currentProvider = envProvider;

function readEnvProvider(): ApiProvider {
  const raw = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (raw === undefined || raw === "") return "anthropic";
  if (raw === "anthropic" || raw === "portkey") return raw;

  throw new Error('AI_PROVIDER must be either "anthropic" or "portkey".');
}

function readEnvKey(provider: ApiProvider): string | null {
  const raw =
    provider === "anthropic"
      ? process.env.ANTHROPIC_API_KEY
      : process.env.PORTKEY_API_KEY;
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

// Seed from the selected provider's .env key. Leaving AI_PROVIDER unset keeps
// existing installations on Anthropic.
if (envKey !== null) {
  currentKey = envKey;
  currentSource = "env";
}

/**
 * Checks that a string looks like a usable key before accepting it.
 *
 * This is shape-checking, not verification — only the API can say whether a
 * key is real and funded. The point is to catch the common pastes that are
 * obviously wrong (an empty box, a key with a trailing newline, somebody's
 * OpenAI key) at the moment of entry, where the error can say what is wrong,
 * rather than letting them surface later as a 401 from the SDK.
 *
 * @returns an error message to show the user, or null when the shape is fine
 */
export function validateKeyFormat(
  key: string,
  provider: ApiProvider,
): string | null {
  const trimmed = key.trim();

  if (trimmed === "") {
    return "No key was provided.";
  }

  if (provider === "anthropic" && !trimmed.startsWith("sk-ant-")) {
    return 'An Anthropic API key starts with "sk-ant-". Check you copied the whole key, and that it is not a key for a different service.';
  }

  // Real keys are around 100 characters. The exact length is not documented
  // and could change, so this only rejects something far too short to be a
  // key at all — a truncated paste, usually. Portkey keys do not have a
  // provider-independent prefix, so only Anthropic receives a prefix check.
  if (trimmed.length < 20) {
    return "That key looks too short. Check the whole value was copied.";
  }

  // Whitespace inside the key means the paste picked up a line break, which
  // is common when copying from a wrapped terminal or an email.
  if (/\s/.test(trimmed)) {
    return "That key contains a space or line break. Copy it again as a single line.";
  }

  return null;
}

/**
 * Masks a key for display.
 *
 * Shows a provider label and the last four characters, enough to distinguish
 * credentials without displaying a usable prefix or the full key.
 */
function maskKey(key: string, provider: ApiProvider): string {
  const tail = key.slice(-4);
  return `${provider === "portkey" ? "Portkey" : "Anthropic"} …${tail}`;
}

/** Whether a key is currently set. */
export function hasKey(): boolean {
  return currentKey !== null;
}

/**
 * The live key, for building an SDK client.
 *
 * Server-side callers only. The result must never reach a response body.
 */
export function getKey(): string | null {
  return currentKey;
}

/** The provider used for the current key. */
export function getProvider(): ApiProvider {
  return currentProvider;
}

/** The masked hint, or null when no key is set. */
export function keyHint(): string | null {
  return currentKey === null ? null : maskKey(currentKey, currentProvider);
}

/** Everything the frontend may know, in the shape the endpoint returns. */
export function getStatus(): KeyStatus {
  return {
    set: currentKey !== null,
    hint: keyHint(),
    source: currentSource,
    provider: currentProvider,
  };
}

/**
 * Replaces the active key.
 *
 * Validates the shape first and reports a problem rather than storing a
 * value that cannot work. Trims, because a trailing newline on a pasted key
 * is the single most common way this goes wrong.
 *
 * @returns an error message when rejected, or null on success
 */
export function setKey(key: string, provider: ApiProvider): string | null {
  if (provider !== "anthropic" && provider !== "portkey") {
    return "Choose Anthropic or Portkey.";
  }

  const problem = validateKeyFormat(key, provider);
  if (problem !== null) return problem;

  currentKey = key.trim();
  currentSource = "settings";
  currentProvider = provider;
  return null;
}

/**
 * Forgets a key that was set through Settings.
 *
 * Falls back to the .env key when there is one, so this undoes the Settings
 * entry rather than disabling the app. On a machine with no .env it leaves
 * the app with no key, which is the intended "log out" behaviour.
 */
export function clearKey(): void {
  currentProvider = envProvider;
  if (envKey !== null) {
    currentKey = envKey;
    currentSource = "env";
  } else {
    currentKey = null;
    currentSource = null;
  }
}
