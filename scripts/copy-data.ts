/**
 * copy-data.ts — copies server/data into dist, after a build.
 *
 * Run as part of:  npm run build
 *
 * tsc compiles .ts and ignores everything else, so a build produced a
 * dist/ that was missing the corpus the search tool reads and the
 * files the sandboxed reader serves. Running `node dist/server/index.js`
 * then crashed on startup:
 *
 *   Error: ENOENT ... dist\server\data\kb.json
 *
 * It went unnoticed because `npm run dev` uses tsx against server/
 * directly, where the path resolves. Nothing in package.json ran the
 * compiled output, so nothing exercised the broken path.
 *
 * A script rather than a shell command in package.json, because
 * `cp -r` and `xcopy` are not the same on both platforms and this
 * project is developed on Windows and read on everything else.
 */

import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const FROM = join(ROOT, "server", "data");
const TO = join(ROOT, "dist", "server", "data");

async function main(): Promise<void> {
  // recursive handles the directory itself; mkdir first so the copy
  // does not depend on tsc having created the parent.
  await mkdir(join(ROOT, "dist", "server"), { recursive: true });
  await cp(FROM, TO, { recursive: true });

  console.log(`Copied server/data → dist/server/data`);
}

await main();
