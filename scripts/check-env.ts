/**
 * check-env.ts — reports what is in your .env file.
 *
 * Run it with:  npx tsx scripts/check-env.ts
 *
 * Note the limit of what this can tell you. A .env key is OPTIONAL: the app
 * also takes a key typed into its Settings dialog, and that one lives in the
 * running server's memory where this script cannot see it. So "no key in
 * .env" is a fact about .env, not a diagnosis — the app may be working fine.
 *
 * What this is still good for is the case where you DID put a key in .env and
 * the app is not picking it up: a wrong provider, variable name, quotes around
 * the value, or a stray space all show up here immediately.
 *
 * It prints only the first 8 characters of the key. Never print a secret in
 * full — not to a terminal, not to a log file, and especially not on a
 * projector in front of a class.
 */

import "dotenv/config"; // reads .env and puts its values on process.env

/**
 * Runs the checks and returns an exit code: 0 for success, 1 for failure.
 *
 * The work lives in a function so that each failure can `return` immediately.
 * TypeScript follows those returns and understands that any code after them
 * has a defined `key`. (It does not know that `process.exit()` ends the
 * program, so a version written with bare exit calls still complains that
 * `key` might be undefined.)
 */
function checkEnvironment(): number {
  // process.env values are always string | undefined — there is no guarantee a
  // variable was set. Strict mode makes us handle the undefined case, which is
  // exactly the case we are testing for.
  const provider = process.env.AI_PROVIDER?.trim().toLowerCase() || "anthropic";
  const keyName =
    provider === "portkey" ? "PORTKEY_API_KEY" : "ANTHROPIC_API_KEY";
  const key: string | undefined = process.env[keyName];
  const configuredBaseURL = process.env.ANTHROPIC_BASE_URL?.trim();
  const configuredPortkeyProvider =
    process.env.PORTKEY_PROVIDER?.trim() || "anthropic";
  const portkeyProvider = configuredPortkeyProvider.startsWith("@")
    ? configuredPortkeyProvider.slice(1)
    : configuredPortkeyProvider;
  const port: string | undefined = process.env.PORT;

  console.log("Checking environment...\n");

  if (provider !== "anthropic" && provider !== "portkey") {
    console.error('FAIL  AI_PROVIDER must be "anthropic" or "portkey".');
    return 1;
  }

  if (
    provider === "portkey" &&
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(portkeyProvider)
  ) {
    console.error(
      "FAIL  PORTKEY_PROVIDER must be a Model Catalog slug, optionally prefixed with '@'.",
    );
    return 1;
  }

  let gatewayHost: string | null = null;
  if (provider === "portkey" && configuredBaseURL) {
    try {
      const baseURL = new URL(configuredBaseURL);
      if (baseURL.protocol !== "https:") {
        console.error("FAIL  ANTHROPIC_BASE_URL must use HTTPS for Portkey.");
        return 1;
      }
      gatewayHost = baseURL.host;
    } catch {
      console.error(
        "FAIL  ANTHROPIC_BASE_URL must be an absolute HTTPS URL for Portkey.",
      );
      return 1;
    }
  }

  if (!key) {
    // Missing entirely, or present but empty. Not a failure: the app asks for
    // a key in Settings when there is none here, so this is a normal setup.
    console.log(`none  ${keyName} is not set in .env.`);
    console.log("      That is fine. Start the app with `npm run dev` and");
    console.log("      paste the selected provider's key into Settings — it is held in");
    console.log("      the server's memory until the server stops.");
    console.log("");
    console.log("      To avoid retyping after a restart, set AI_PROVIDER and");
    console.log(`      ${keyName} in .env.`);
    console.log("");
    console.log(`PORT = ${port ?? "not set, server will default to 3000"}`);
    if (gatewayHost !== null) {
      console.log(`PASS  Custom Portkey gateway configured (${gatewayHost})`);
    }
    return 0;
  }

  // Past this point TypeScript knows `key` is a string, not undefined.

  if (
    (provider === "anthropic" && !key.startsWith("sk-ant-")) ||
    key.length < 20 ||
    /\s/.test(key)
  ) {
    console.error(`FAIL  ${keyName} does not look like a valid key.`);
    console.error(
      provider === "anthropic"
        ? '      Anthropic keys start with "sk-ant-"; check for quotes or spaces.'
        : "      Check the Portkey key is complete and has no quotes or spaces.",
    );
    console.error(`      Found a value starting: ${key.slice(0, 8)}...`);
    return 1;
  }

  // Show only a short prefix so the full credential never reaches the terminal.
  console.log(`PASS  ${keyName} loaded from .env  ${key.slice(0, 8)}...`);
  console.log(`      (${key.length} characters total)`);
  console.log(`PASS  AI_PROVIDER = ${provider}`);
  if (provider === "portkey") {
    console.log(`PASS  PORTKEY_PROVIDER = @${portkeyProvider}`);
    console.log(
      `      sent as header x-portkey-provider: @${portkeyProvider}, models as anthropic.<model-id>`,
    );
  }
  if (gatewayHost !== null) {
    console.log(`PASS  Custom Portkey gateway configured (${gatewayHost})`);
  }
  console.log(`PASS  PORT = ${port ?? "not set, server will default to 3000"}`);
  console.log("\n.env looks good. The app starts with this key loaded, and");
  console.log("Settings shows it as coming from .env.");
  return 0;
}

// A non-zero exit code is how a shell script or CI job notices a failure.
process.exit(checkEnvironment());
