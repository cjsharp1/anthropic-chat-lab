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
 * the app is not picking it up: a typo in the variable name, quotes around the
 * value, or a stray space all show up here immediately.
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
  const key: string | undefined = process.env.ANTHROPIC_API_KEY;
  const port: string | undefined = process.env.PORT;

  console.log("Checking environment...\n");

  if (!key) {
    // Missing entirely, or present but empty. Not a failure: the app asks for
    // a key in Settings when there is none here, so this is a normal setup.
    console.log("none  ANTHROPIC_API_KEY is not set in .env.");
    console.log("      That is fine. Start the app with `npm run dev` and");
    console.log("      paste your key into Settings instead — it is held in");
    console.log("      the server's memory until the server stops.");
    console.log("");
    console.log("      To avoid retyping it after a restart, put it in .env");
    console.log("      as:  ANTHROPIC_API_KEY=sk-ant-...");
    console.log("      Get a key from https://console.anthropic.com/settings/keys");
    console.log("");
    console.log(`PORT = ${port ?? "not set, server will default to 3000"}`);
    return 0;
  }

  // Past this point TypeScript knows `key` is a string, not undefined.

  if (!key.startsWith("sk-ant-")) {
    // Catches a pasted placeholder, a quoted value, or another provider's key.
    console.error("FAIL  ANTHROPIC_API_KEY does not look like an Anthropic key.");
    console.error('      It should start with "sk-ant-" and have no quotes.');
    console.error(`      Found a value starting: ${key.slice(0, 8)}...`);
    console.error("      The app will reject it and ask for a key in Settings.");
    return 1;
  }

  // Safe to show: the first 8 characters identify the key type, not the secret.
  console.log(`PASS  ANTHROPIC_API_KEY loaded from .env  ${key.slice(0, 8)}...`);
  console.log(`      (${key.length} characters total)`);
  console.log(`PASS  PORT = ${port ?? "not set, server will default to 3000"}`);
  console.log("\n.env looks good. The app starts with this key loaded, and");
  console.log("Settings shows it as coming from .env.");
  return 0;
}

// A non-zero exit code is how a shell script or CI job notices a failure.
process.exit(checkEnvironment());
