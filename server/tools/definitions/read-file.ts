/**
 * read-file.ts — reads a file, but only from one directory.
 *
 * The security lesson of this phase. The calculator made the point that a
 * tool should not accept a program; this one makes the harder point that
 * even an innocent-looking string parameter is attacker-controlled.
 *
 * ---------------------------------------------------------------------------
 * Why a path from the model is untrusted
 * ---------------------------------------------------------------------------
 *
 * It is tempting to think of tool arguments as coming from Claude, and of
 * Claude as being on your side. The real chain is longer:
 *
 *     user types something  ->  model decides what to call  ->  your code runs
 *
 * The user is at one end and your filesystem is at the other. A user who
 * asks the right question can influence what arguments the model produces.
 * That is prompt injection, and it does not require the model to be
 * malicious — only persuadable. Worse, the text the model reads might not
 * even come from the user: if a tool returns a web page or a document, and
 * that content contains instructions, the model may act on them.
 *
 * So: treat every tool argument exactly as you would treat a query string
 * parameter on a public endpoint. The question is never "would Claude do
 * this", it is "what happens if this value is hostile".
 *
 * ---------------------------------------------------------------------------
 * What a hostile path looks like
 * ---------------------------------------------------------------------------
 *
 *     ../../.env                    the API key, two levels up
 *     ../../../../etc/passwd        classic traversal
 *     /etc/passwd                   absolute path, ignoring the sandbox
 *     C:\Windows\System32\...       the Windows equivalent
 *     ....//....//.env              defeats a naive ".." string filter
 *     data/../../../.env            looks relative, escapes anyway
 *
 * ---------------------------------------------------------------------------
 * The fix: resolve first, then compare
 * ---------------------------------------------------------------------------
 *
 * The wrong approach is to inspect the string — reject anything containing
 * "..", strip leading slashes, and so on. People have been losing that
 * arms race for decades, because there are more encodings of "go up a
 * directory" than anyone thinks to block.
 *
 * The right approach does not look at the string at all. Join it to the
 * sandbox root, ask the operating system to RESOLVE it into a canonical
 * absolute path, and then check that the result is still inside the root.
 * Whatever tricks the input contained have already been collapsed by the
 * time the check happens, because resolution is exactly the operation that
 * interprets them.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineTool } from "../types.js";

/**
 * The only directory this tool may read from.
 *
 * Resolved to an absolute canonical path once, at import time, so the
 * comparison below is never affected by the process's working directory
 * changing. Derived from import.meta.url rather than a relative path,
 * because __dirname does not exist in an ES module.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SANDBOX_ROOT = resolve(join(here, "../../data"));

/** Refuses to read a file larger than this. */
const MAX_BYTES = 100_000;

const inputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Path to the file, relative to the data directory. For example " +
        '"kb.json" or "release-notes.txt". Paths outside the data ' +
        "directory are refused.",
    ),
});

/**
 * Turns a requested path into a safe absolute one, or explains the refusal.
 *
 * Separated from `run` so it can be tested directly, without touching the
 * filesystem. Security logic that can only be exercised through its caller
 * tends not to get tested at all.
 */
export function resolveInsideSandbox(
  requested: string,
): { ok: true; absolute: string } | { ok: false; reason: string } {
  // Reject an absolute path up front, before any path arithmetic.
  //
  // As it happens, join() already neutralises these: it treats the input
  // as a relative segment, so "/etc/passwd" becomes "<root>/etc/passwd"
  // rather than escaping. But relying on that is relying on a detail of
  // how join behaves, and it differs between platforms — a Windows drive
  // letter, a UNC path and a POSIX absolute path are three separate
  // cases. Rejecting them explicitly says what is intended instead of
  // depending on a happy accident, and produces a clear message rather
  // than a confusing "no such file".
  if (
    requested.startsWith("/") ||
    requested.startsWith("\\") ||
    /^[a-zA-Z]:/.test(requested)
  ) {
    return {
      ok: false,
      reason:
        `Refused: "${requested}" is an absolute path. ` +
        "This tool takes paths relative to the data directory.",
    };
  }

  // join() applies the ".." segments; resolve() produces a canonical
  // absolute path with no "." or ".." left in it.
  const absolute = resolve(join(SANDBOX_ROOT, requested));

  // The comparison. relative() answers "how do I get from the root to
  // this path" — and if the answer starts with "..", the path is outside.
  //
  // Comparing with startsWith on the raw strings would be subtly wrong:
  // "/app/data-backup" starts with "/app/data" but is a different
  // directory. Appending a separator first, or using relative() as here,
  // avoids that.
  const rel = relative(SANDBOX_ROOT, absolute);

  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) {
    return {
      ok: false,
      reason:
        `Refused: "${requested}" resolves outside the data directory. ` +
        "This tool can only read files inside it.",
    };
  }

  return { ok: true, absolute };
}

export const readFileTool = defineTool({
  name: "read_file",

  description:
    "Reads a text file from the application's data directory. Available " +
    "files include kb.json (the reference library), release-notes.txt and " +
    "example-config.json. Only files inside that directory can be read; " +
    "any path pointing elsewhere is refused.",

  // A prompt that reliably triggers this tool, with a note on
  // what to watch for. Shown in the Tools tab: a tool nobody
  // knows how to invoke teaches nothing.
  examplePrompt: "Read release-notes.txt and tell me what v0.8 added.",
  exampleWatch:
    "Then ask it to read ../../.env. The path is resolved and checked against the sandbox root before anything is opened, so the refusal happens in our code, not Claude's.",

  inputSchema,

  run: async ({ path: requested }) => {
    const resolved = resolveInsideSandbox(requested);

    if (!resolved.ok) {
      // Thrown, so tool-runner.ts returns it as an errored
      // tool_result. Claude
      // reads the refusal and generally stops rather than trying variants.
      throw new Error(resolved.reason);
    }

    let info;
    try {
      info = await stat(resolved.absolute);
    } catch {
      // Deliberately does not distinguish "missing" from "unreadable".
      // Telling a caller which paths exist outside what they may read is
      // itself a small information leak.
      throw new Error(
        `No file called "${requested}" in the data directory. ` +
          "Try kb.json, release-notes.txt or example-config.json.",
      );
    }

    if (info.isDirectory()) {
      throw new Error(`"${requested}" is a directory, not a file.`);
    }

    if (info.size > MAX_BYTES) {
      // A large file would flood the context window and cost real money to
      // send. Refusing is better than silently truncating, which would
      // leave the model reasoning about a fragment it believes is whole.
      throw new Error(
        `"${requested}" is ${info.size} bytes, over the ${MAX_BYTES} byte limit.`,
      );
    }

    const contents = await readFile(resolved.absolute, "utf-8");
    return `Contents of ${requested} (${info.size} bytes):\n\n${contents}`;
  },
});
