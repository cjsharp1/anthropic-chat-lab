/**
 * index.ts — the web server.
 *
 * Start it with:  npm run dev
 *
 * This is the entry point for the whole app. It does three jobs:
 *
 *   1. Serves the frontend  — the HTML, CSS and compiled JS in public/
 *   2. Answers API calls    — /api/health now, /api/chat from step 19
 *   3. Holds the API key    — see the note below
 *
 * The third job is the one worth pausing on. The browser never talks to
 * Anthropic directly, and it never sees your API key. It talks to this server,
 * and this server talks to Anthropic. If the browser held the key, anyone who
 * opened DevTools could read it and spend your money. Putting a server in the
 * middle is not an architectural nicety — it is the only way to keep a key
 * secret in a web app.
 *
 * That holds even though the key is now typed into the app's own Settings
 * dialog. The browser POSTs it here once and then forgets it: it is not kept
 * in localStorage, and no endpoint ever sends it back. What the frontend can
 * read is whether a key is set and a masked hint — see /api/key-status below,
 * and server/api-key.ts for where the value actually lives.
 */

import express from "express";
import "dotenv/config"; // load .env before anything reads process.env
import type Anthropic from "@anthropic-ai/sdk";
// The SDK's error classes are named exports from the package root, not
// properties of the default export.
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import {
  clearKey,
  getStatus as getKeyStatus,
  hasKey,
  setKey,
} from "./api-key.js";
import { MissingKeyError } from "./anthropic.js";
import { makeLogger } from "./logger.js";
import { DEFAULT_PROMPT_ID, getPrompt, PROMPT_OPTIONS } from "./prompts.js";
import {
  buildToolChoice,
  DEFAULT_TOOL_CHOICE_ID,
  getToolChoiceOption,
  TOOL_CHOICE_OPTIONS,
} from "./tool-choice.js";
import {
  DEFAULT_PATTERN_ID,
  getPattern,
  PATTERNS,
} from "./orchestration/registry.js";
import { getModelOption, MODEL_OPTIONS, parseAssignment, ROLE_INFO } from "./models.js";
import { parseThinkingDisplay, THINKING_OPTIONS } from "./thinking.js";
import { DEFAULT_EFFORT, EFFORT_OPTIONS, parseEffort } from "./effort.js";
import { SERVER_TOOLS, SERVER_TOOLS_BY_NAME } from "./tools/server-tools.js";
import { CACHE_MODES, DEFAULT_CACHE_MODE, parseCacheMode } from "./caching.js";
import { extractFields } from "./extract.js";
import { toApiTools } from "./tools/api-format.js";
import {
  assertUniqueToolNames,
  getActiveTools,
  TOOLS,
} from "./tools/registry.js";
import {
  connect as mcpConnect,
  disconnect as mcpDisconnect,
  getMcpTools,
  getStatus as getMcpStatus,
  type McpConnectRequest,
} from "./mcp/client.js";
import type { StreamEvent } from "./types.js";
import { formatCost } from "./usage.js";

const app = express();

// Which port to listen on. Falls back to 3000 if PORT is not set in .env.
// process.env values are strings, so Number() converts it.
const PORT = Number(process.env.PORT) || 3000;

// --- Middleware -------------------------------------------------------------
//
// Middleware runs on every request, in the order it is registered, before the
// route handlers below.

// Parses an incoming JSON request body and puts the result on req.body.
// Without this, req.body is undefined and the chat route cannot read the
// messages the browser sends. The limit is raised from the 100kb default
// because a long conversation history is resent on every turn.
app.use(express.json({ limit: "2mb" }));

// Serves everything in public/ as a static file. A request for "/" returns
// public/index.html automatically; "/app.js" returns public/app.js.
//
// The path is resolved relative to the folder the server was started from,
// which is the project root. Note that __dirname does not exist in an ES
// module — this project is "type": "module" — so a script-relative path would
// need import.meta.url instead.
app.use(express.static("public"));

// --- Helpers ----------------------------------------------------------------

/**
 * Validates the conversation history a browser sent.
 *
 * Returns only well-formed turns, and an empty array if the input is not
 * usable at all. Nothing here trusts the caller: the frontend normally
 * sends the right shape, but the route is reachable by anyone with curl.
 *
 * Checking this properly is not pedantry. Forwarding a malformed array to
 * Anthropic means paying for a request that returns a 400, and a confusing
 * one — the error names a field index, not the mistake.
 */
function parseMessages(input: unknown): Anthropic.MessageParam[] {
  if (!Array.isArray(input)) return [];

  const messages: Anthropic.MessageParam[] = [];

  for (const item of input) {
    if (typeof item !== "object" || item === null) continue;

    const turn = item as { role?: unknown; content?: unknown };

    // Only the two roles the API accepts in a messages array.
    if (turn.role !== "user" && turn.role !== "assistant") continue;

    // Content must be a non-empty string. The API rejects empty content,
    // and an empty turn carries no meaning anyway.
    if (typeof turn.content !== "string" || turn.content.trim() === "") continue;

    messages.push({ role: turn.role, content: turn.content });
  }

  // The API requires the conversation to start with a user turn. A history
  // beginning with an assistant message is malformed — drop the leading
  // assistant turns rather than let the API reject the whole request.
  while (messages.length > 0 && messages[0]!.role === "assistant") {
    messages.shift();
  }

  return messages;
}




/** A failure, translated for the person waiting and for the log panel. */
interface ExplainedError {
  /** Short identifier for the log: "auth", "rate_limit", and so on. */
  kind: string;
  /** One line for the log panel. */
  summary: string;
  /** What the user sees in the transcript. Plain, and actionable. */
  message: string;
  /** HTTP status, where there was one. */
  status?: number;
  /** Whether trying the same request again might work. */
  retryable: boolean;
}

/**
 * Classifies an error from the SDK.
 *
 * The order of these checks is the whole point. Every one of these classes
 * is also an APIError, so the specific cases must be tested first — put the
 * general case at the top and it swallows everything below it, and the app
 * loses the distinction between "wait and retry" and "this will never work".
 *
 * Note that nothing here matches on message text. Message wording changes
 * between SDK versions; the classes do not.
 */
function explainError(error: unknown): ExplainedError {
  // No key set at all. Checked before the SDK classes because this never
  // reached Anthropic — there is nothing to retry and no status to report,
  // only a setting to fill in.
  if (error instanceof MissingKeyError) {
    return {
      kind: "no_key",
      retryable: false,
      summary: "No API key set",
      message: error.message,
    };
  }

  // 401 — the key is missing, revoked, or being sent to something that does
  // not recognise it. Retrying is pointless.
  if (error instanceof AuthenticationError) {
    return {
      kind: "auth",
      status: 401,
      retryable: false,
      summary: "Authentication failed (401)",
      message:
        "The API key was rejected. Open Settings and check the key, or " +
        "paste a new one from console.anthropic.com. If the key is valid, " +
        "check whether an ANTHROPIC_BASE_URL in your environment is " +
        "routing the call somewhere unexpected.",
    };
  }

  // 429 — over the rate limit. The one case where retrying is the answer.
  if (error instanceof RateLimitError) {
    return {
      kind: "rate_limit",
      status: 429,
      retryable: true,
      summary: "Rate limited (429)",
      message:
        "Rate limit reached. Wait a few seconds and try again. If this " +
        "keeps happening, the account's requests-per-minute limit is the " +
        "thing to check.",
    };
  }

  // 404 — almost always a typo in the model ID rather than a missing route.
  if (error instanceof NotFoundError) {
    return {
      kind: "not_found",
      status: 404,
      retryable: false,
      summary: "Not found (404)",
      message:
        "The API returned 404. The usual cause is a misspelled model ID — " +
        "check MODEL in server/anthropic.ts. Model IDs take no date suffix.",
    };
  }

  // 400 — the request itself is malformed. Worth surfacing the API's own
  // message here, because it names the offending field.
  if (error instanceof BadRequestError) {
    return {
      kind: "bad_request",
      status: 400,
      retryable: false,
      summary: "Invalid request (400)",
      message: `The API rejected the request: ${error.message}`,
    };
  }

  // 529 / 500s — Anthropic's side. Retrying is reasonable.
  if (error instanceof InternalServerError) {
    return {
      kind: "server_error",
      status: error.status,
      retryable: true,
      summary: `Anthropic server error (${error.status})`,
      message:
        "Anthropic returned a server error. This is usually temporary — " +
        "try again in a moment.",
    };
  }

  // No response at all: DNS, no network, a timeout. Must be checked before
  // APIError, because it is a subclass of it.
  if (error instanceof APIConnectionError) {
    return {
      kind: "connection",
      retryable: true,
      summary: "Could not reach the API",
      message:
        "Could not reach Anthropic. Check your network connection and " +
        "try again.",
    };
  }

  // Any other API failure. Last, because everything above also matches this.
  if (error instanceof APIError) {
    return {
      kind: "api_error",
      status: error.status,
      retryable: (error.status ?? 0) >= 500,
      summary: `API error (${error.status ?? "unknown"})`,
      message: `The API returned an error: ${error.message}`,
    };
  }

  // Not an SDK error — a bug in this app, most likely.
  return {
    kind: "unknown",
    retryable: false,
    summary: "Unexpected error",
    message:
      error instanceof Error
        ? `Something went wrong: ${error.message}`
        : `Something went wrong: ${String(error)}`,
  };
}

// --- Routes -----------------------------------------------------------------

/**
 * GET /api/health — a liveness check.
 *
 * Exists so you can confirm the server is up and reachable without involving
 * Claude, the API key, or the frontend. When something breaks later, this is
 * the first thing to try: if health responds, the problem is further in.
 */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * The API key endpoints.
 *
 * Three routes, and the shape of them is the security design:
 *
 *   GET    /api/key-status   is a key set, and a masked hint
 *   POST   /api/key          set one
 *   DELETE /api/key          forget it
 *
 * Note the asymmetry. A key goes in, and a yes/no plus four characters comes
 * out — there is no route that returns the key. That is deliberate: once the
 * browser has sent it, the value exists only in this process's memory. A GET
 * that returned it would put the secret back into a response body, into the
 * network tab, and into anything caching responses, which is exactly what
 * keeping the key server-side is meant to prevent.
 *
 * These routes are unauthenticated, like every other route here, because the
 * app binds to localhost and is meant for one person on one machine. That
 * assumption is doing real work now that a key can be set over HTTP: anyone
 * who can reach the port can set or replace it. Do not expose this to a
 * network. See the security notes in README.md.
 */

/**
 * GET /api/key-status — whether Claude can be called yet.
 *
 * The frontend calls this on load to decide between the setup prompt and the
 * normal UI, and again after every change.
 */
app.get("/api/key-status", (_req, res) => {
  res.json(getKeyStatus());
});

/**
 * POST /api/key — set the key for this server process.
 *
 * Validates the shape before storing, so an obviously-wrong paste is answered
 * here with a specific message rather than later with a 401 from Anthropic.
 * A 400 carries the reason; the frontend shows it beside the input.
 */
app.post("/api/key", (req, res) => {
  const body = req.body as { key?: unknown };

  if (typeof body.key !== "string") {
    res.status(400).json({ error: "Expected a key as a string." });
    return;
  }

  const problem = setKey(body.key);

  if (problem !== null) {
    res.status(400).json({ error: problem });
    return;
  }

  // The new status, so the frontend updates from the server's answer rather
  // than assuming the write worked.
  res.json(getKeyStatus());
});

/**
 * DELETE /api/key — forget the key set through Settings.
 *
 * Falls back to an ANTHROPIC_API_KEY from .env when one exists, so this
 * undoes the Settings entry rather than disabling the app on a machine that
 * was already configured. The returned status says which case happened.
 */
app.delete("/api/key", (_req, res) => {
  clearKey();
  res.json(getKeyStatus());
});

/**
 * GET /api/prompts — the system prompts the UI can offer.
 *
 * The full text is included, not just the names, so the frontend can show
 * a learner exactly what is shaping the replies. There is nothing secret
 * in a system prompt: it is instructions to the model, not a credential.
 */
app.get("/api/prompts", (_req, res) => {
  res.json({
    prompts: PROMPT_OPTIONS.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      effect: p.effect,
      text: p.text,
      // Character count rather than tokens: counting tokens properly needs
      // an API call, and this is only meant to convey relative size.
      characters: p.text?.length ?? 0,
    })),
    default: DEFAULT_PROMPT_ID,
  });
});

/**
 * GET /api/models — the models on offer, and what each role is for.
 *
 * Roles rather than patterns: see server/models.ts for why "the
 * orchestrator uses Haiku" is a less useful thing to know than "a
 * call producing a structured decision rarely needs the expensive
 * model".
 */
app.get("/api/models", (_req, res) => {
  res.json({
    models: MODEL_OPTIONS,
    roles: ROLE_INFO,
  });
});

/**
 * GET /api/cache-modes — how much of the request can be cached.
 */
app.get("/api/cache-modes", (_req, res) => {
  res.json({ modes: CACHE_MODES, default: DEFAULT_CACHE_MODE });
});

/**
 * GET /api/thinking-options — whether reasoning comes back readable.
 *
 * Not whether Claude thinks: on these models it always does, and you
 * are always billed for it. See server/thinking.ts.
 */
app.get("/api/thinking-options", (_req, res) => {
  res.json({ options: THINKING_OPTIONS, default: "omitted" });
});

/**
 * GET /api/effort-levels — how hard the model works before answering.
 *
 * This is what replaced budget_tokens, which is a 400 on every model
 * this app offers. See server/effort.ts.
 */
app.get("/api/effort-levels", (_req, res) => {
  res.json({ levels: EFFORT_OPTIONS, default: DEFAULT_EFFORT });
});

/**
 * GET /api/patterns — the orchestration patterns the UI can offer.
 *
 * The teaching description lives on the pattern itself, beside its
 * implementation, so the two cannot drift apart. A pattern that changes
 * what it does and forgets to update its description is a worse problem
 * than it sounds: the description is the only thing telling a learner
 * what they are about to watch.
 */
app.get("/api/patterns", (_req, res) => {
  res.json({
    patterns: PATTERNS.map((pattern) => ({
      id: pattern.id,
      name: pattern.name,
      description: pattern.description,
      typicalRequests: pattern.typicalRequests,
      usesRoles: pattern.usesRoles,
      whenToUse: pattern.whenToUse,
      measuredCost: pattern.measuredCost,
      examples: pattern.examples,
    })),
    default: DEFAULT_PATTERN_ID,
  });
});

/**
 * GET /api/tool-choices — the tool_choice settings the UI can offer.
 */
app.get("/api/tool-choices", (_req, res) => {
  res.json({ choices: TOOL_CHOICE_OPTIONS, default: DEFAULT_TOOL_CHOICE_ID });
});

/**
 * GET /api/tools — the tools the UI can offer.
 *
 * Only the metadata: the Zod schema and the run function stay on the
 * server. The browser needs enough to draw a checkbox and explain what it
 * does, nothing more.
 */
app.get("/api/tools", (_req, res) => {
  res.json({
    tools: [
      ...TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        executedBy: "client" as const,
        examplePrompt: tool.examplePrompt,
        exampleWatch: tool.exampleWatch,
        note:
          "This server runs it. Claude asks, the loop executes the " +
          "function, and a tool_result goes back in a second request.",
      })),
      // Server tools are listed with the rest, because from the Tools
      // tab's point of view they are the same decision: may Claude use
      // this or not. The badge and the note are where they differ.
      ...SERVER_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        executedBy: "server" as const,
        examplePrompt: tool.examplePrompt,
        exampleWatch: tool.exampleWatch,
        note: tool.note,
      })),
      // Tools borrowed from a connected MCP server. The list is empty
      // when nothing is connected, and changes when Settings connects
      // or disconnects — which is why this route reads it on every
      // request rather than capturing it at startup.
      ...getMcpTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        executedBy: "mcp" as const,
        examplePrompt: tool.examplePrompt,
        exampleWatch: tool.exampleWatch,
        note:
          "This tool lives on a connected MCP server. Claude asks for " +
          "it exactly as it asks for any other; this server forwards " +
          "the call over the Model Context Protocol and sends the " +
          "answer back in a tool_result.",
      })),
    ],
  });
});

/**
 * GET /api/mcp — the current MCP connection, if any.
 *
 * Shaped like /api/key-status, and for the same reason: the browser
 * needs to draw a dialog that reflects server state it cannot hold
 * itself. Nothing secret is returned — the target is a URL or a
 * command the user typed, and both are already in their browser.
 */
app.get("/api/mcp", (_req, res) => {
  res.json(getMcpStatus());
});

/**
 * POST /api/mcp — connect to an MCP server.
 *
 * Returns the resulting status rather than throwing on failure. A
 * server that is not running is an ordinary thing to happen in a lab,
 * and the dialog needs the reason in order to show it.
 */
app.post("/api/mcp", async (req, res) => {
  const body = req.body as Partial<McpConnectRequest>;

  // Narrowed before use. This is a route that spawns a child process
  // on one of its paths, so what arrives over the network decides
  // rather more than usual.
  const transport = body.transport === "stdio" ? "stdio" : "http";

  const status = await mcpConnect({
    transport,
    ...(typeof body.url === "string" ? { url: body.url } : {}),
    ...(typeof body.command === "string" ? { command: body.command } : {}),
    ...(Array.isArray(body.args)
      ? { args: body.args.map((arg) => String(arg)) }
      : {}),
  });

  if (status.connected) {
    console.log(
      `  MCP connected: ${status.serverName} ${status.serverVersion} ` +
        `(${status.toolNames.length} tools)`,
    );
  }

  res.json(status);
});

/**
 * DELETE /api/mcp — disconnect.
 *
 * Idempotent: disconnecting when nothing is connected succeeds and
 * reports the same state it would have reported anyway.
 */
app.delete("/api/mcp", async (_req, res) => {
  await mcpDisconnect();
  res.json(getMcpStatus());
});

/**
 * POST /api/extract — structured output, on demand.
 *
 * Its own endpoint, because it answers a different question: the chat
 * asks Claude to respond, this asks it to describe what was asked.
 * Running it on every message would mean paying for an extraction
 * nobody looked at.
 *
 * But it streams over SSE exactly like the chat does, because the
 * activity log is fed by SSE and an API call this app does not log is
 * an API call the learner cannot see. The request matters more here
 * than almost anywhere else in the app — `output_config.format` is the
 * field doing the work, and it is only visible in the request body.
 */
app.post("/api/extract", async (req, res) => {
  // Same SSE headers as the chat route. See that route for why each of
  // these matters, particularly flushHeaders.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  function send(event: StreamEvent): void {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const log = makeLogger((event) => send({ type: "log", event }));

  try {
    // Nothing below can work without a key, and the failure is worth catching
    // here rather than letting the SDK raise a 401 further in. This is not an
    // error in the usual sense — it is a setting that has not been filled in —
    // so it is reported as a plain message naming the fix.
    if (!hasKey()) {
      send({
        type: "error",
        message:
          "No API key is set. Open Settings and paste your Anthropic API " +
          "key to start. You can get one from console.anthropic.com.",
      });
      res.end();
      return;
    }

    const body = req.body as { message?: unknown; models?: unknown };
    const message = typeof body.message === "string" ? body.message.trim() : "";

    if (!message) {
      send({ type: "error", message: "No message was provided." });
      res.end();
      return;
    }

    const models = parseAssignment(body.models);

    // The deciding model: short structured output that feeds code
    // rather than a person. See server/models.ts.
    log.info(`Extracting with the deciding model (${models.deciding})`, null, {
      actor: "app",
      because:
        "Extraction is a deciding-role job: short structured output " +
        "that feeds code, with nobody reading it directly. Change the " +
        "deciding model in Settings to see a different model judge " +
        "the same message.",
    });

    const result = await extractFields(message, models.deciding, log);

    send({
      type: "extracted",
      data: (result.data ?? null) as Record<string, unknown> | null,
      raw: result.raw,
      model: result.model,
      cost: result.cost,
      elapsedMs: result.elapsedMs,
    });
  } catch (error: unknown) {
    const explained = explainError(error);
    log.error(explained.message, null, { actor: "app" });
    send({ type: "error", message: explained.message });
  } finally {
    // Always close, success or not: a stream left open is a browser
    // left waiting with no way to tell that nothing more is coming.
    res.end();
  }
});

/**
 * POST /api/chat — the chat stream.
 *
 * This route does not return a single JSON response. It holds the connection
 * open and pushes events as they happen, using Server-Sent Events (SSE).
 *
 * Why SSE rather than the alternatives:
 *
 *   plain JSON   The browser waits with a blank screen until everything is
 *                finished. An orchestration pattern making five API calls
 *                could take 30 seconds, and the learner sees nothing until
 *                the end — which defeats the entire point of this app.
 *
 *   WebSockets   Two-way, and more machinery than we need. The browser sends
 *                one request and then only listens; nothing travels back up
 *                the pipe mid-conversation.
 *
 *   SSE          One-way, server to browser, over an ordinary HTTP response.
 *                No extra library, no protocol upgrade.
 *
 * The wire format is deliberately simple. Each message is the literal text
 * "data: ", then a line of JSON, then a BLANK LINE. The blank line is what
 * marks the end of a message — forget it and the browser buffers forever,
 * waiting for a message that never finishes.
 *
 * Right now this sends one hard-coded event and closes. Step 23 replaces the
 * body with a real call to Claude.
 */
app.post("/api/chat", async (req, res) => {
  // Started before anything else, so the figure the reply shows covers
  // the whole turn — parsing, every API call a multi-call pattern
  // makes, and any tool that ran in between. Timing only the final API
  // call would report a tool loop as though it were a single request.
  const startedAt = Date.now();

  // These three headers are what make the response a stream rather than a
  // document. Without them the browser buffers the whole body and hands it
  // over at the end, which would make the streaming pointless.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache"); // never serve a stream from cache
  res.setHeader("Connection", "keep-alive"); // hold the socket open

  // Node and some proxies buffer small writes for efficiency. That is exactly
  // wrong here: a buffered token arrives late, and the typing effect in step
  // 24 turns into one sudden block of text. flushHeaders() sends the headers
  // immediately so the browser starts listening right away.
  res.flushHeaders();

  /**
   * Writes one StreamEvent to the open connection in SSE format.
   *
   * Everything the browser receives goes through here, so the format is
   * defined in exactly one place.
   */
  function send(event: StreamEvent): void {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    //                                      ^^^^
    //            Two newlines: one ends the data line, one ends the message.
  }

  // A logger whose events go straight down the wire. This is the indirection
  // from step 18 paying off: the logger does not know it is talking to a
  // browser, and the patterns that use it from step 46 will not either.
  const log = makeLogger((event) => send({ type: "log", event }));

  try {
    // Nothing below can work without a key, and the failure is worth catching
    // here rather than letting the SDK raise a 401 further in. This is not an
    // error in the usual sense — it is a setting that has not been filled in —
    // so it is reported as a plain message naming the fix.
    if (!hasKey()) {
      send({
        type: "error",
        message:
          "No API key is set. Open Settings and paste your Anthropic API " +
          "key to start. You can get one from console.anthropic.com.",
      });
      res.end();
      return;
    }

    // --- Read what the browser sent -----------------------------------------
    //
    // req.body is whatever arrived over the network. It is not to be trusted
    // just because our own frontend usually sends it: anyone can POST here
    // with curl. Check the shape before using it.
    const body = req.body as {
      messages?: unknown;
      promptId?: unknown;
      tools?: unknown;
      toolChoice?: unknown;
      pattern?: unknown;
      models?: unknown;
      cacheMode?: unknown;
      thinkingDisplay?: unknown;
      effort?: unknown;
    };
    const messages = parseMessages(body.messages);

    // getPrompt falls back to the default for an unknown id, so a stale or
    // hand-crafted request cannot end up sending `undefined` as a system
    // prompt or crashing the route.
    const prompt = getPrompt(body.promptId);

    // Which tools the browser is willing to let Claude use. Filtering here
    // rather than trusting the list means an unknown name sent by hand
    // cannot conjure a tool that does not exist.
    const requested = Array.isArray(body.tools) ? body.tools.map(String) : [];

    // getActiveTools(), not TOOLS: the local registry cannot see a tool
    // that arrived over an MCP connection.
    //
    // This was the bug behind "the chat lab never calls my MCP server".
    // GET /api/tools already listed the borrowed tools, so the Tools tab
    // showed all of them and the header said "Tools: all 11" — but this
    // line filtered the request against the LOCAL registry alone, so the
    // borrowed ones were dropped before the array was built and only the
    // local tools were ever sent. Claude was never told roll_dice
    // existed, so of course it never asked for it; it reached for
    // whatever else could produce a number instead.
    //
    // Nothing downstream needed changing: findTool() already falls back
    // to the borrowed list, so the loop could always EXECUTE an MCP tool.
    // It simply never got the chance, because the tool was not offered.
    const activeTools = getActiveTools().filter((t) =>
      requested.includes(t.name),
    );

    // Which of those came over MCP, so the log can say who runs what.
    // Read from the client rather than inferred from the tool's shape:
    // a borrowed tool is deliberately indistinguishable from a local
    // one everywhere else, which is the point of the adapter.
    const mcpToolNames = new Set(getMcpTools().map((t) => t.name));

    // Convert to the API's format once, before the call. Logging the
    // result means the panel shows exactly what the model was told about
    // each tool — which is the only information it has when deciding
    // whether to use one.
    // The client tools, converted to API definitions.
    const clientDefinitions = toApiTools(activeTools) ?? [];

    // Plus any server tools that are ticked. They go in the SAME array
    // — from the API's point of view there is one tools list, and
    // whether Anthropic or this server executes a given entry is
    // decided by its type, not by where it sits.
    const activeServerTools = requested
      .map((name) => SERVER_TOOLS_BY_NAME.get(name))
      .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool));

    const allDefinitions = [
      ...clientDefinitions,
      ...activeServerTools.map((tool) => tool.definition),
    ];

    const apiTools = allDefinitions.length > 0 ? allDefinitions : undefined;

    if (activeServerTools.length > 0) {
      log.info(
        `${activeServerTools.length} server tool(s): ` +
          activeServerTools.map((t) => t.name).join(", "),
        {
          tools: activeServerTools.map((t) => t.name),
          definitions: activeServerTools.map((t) => t.definition),
          note:
            "Anthropic runs these. There is no function for them here " +
            "and no tool_result is sent back — watch for stop_reason " +
            "'end_turn' rather than 'tool_use' on the response.",
        },
        {
          actor: "user",
          because: "these server tools are ticked in the Tools tab",
        },
      );
    }

    // How free Claude is to decide about tools. Undefined when no tools
    // are being sent — a tool_choice with no tools is a validation error.
    const toolChoiceOption = getToolChoiceOption(body.toolChoice);

    // Which model does which job. Unknown ids fall back per role rather
    // than failing the request — a stale browser tab is not an attack.
    const models = parseAssignment(body.models);

    // How much of the request to mark cacheable.
    const cacheMode = parseCacheMode(body.cacheMode);
    const thinkingDisplay = parseThinkingDisplay(body.thinkingDisplay);
    const effort = parseEffort(body.effort);
    const toolChoice = buildToolChoice(body.toolChoice, Boolean(apiTools));

    // Every tool that could be offered, which is what the denominator
    // has to count: local, borrowed over MCP, and the server tools
    // Anthropic runs. TOOLS alone was only the first of the three.
    const offerable = getActiveTools().length + SERVER_TOOLS.length;

    if (offerable > 0) {
      // How much of the request the tool definitions account for. This is
      // the honest answer to "how does Claude know what tools it has":
      // it is told, in full, every time, and that telling costs tokens.
      const definitionBytes = apiTools ? JSON.stringify(apiTools).length : 0;

      // What is actually in the array, not what one of its three sources
      // contributed.
      //
      // Both halves of this used to be wrong, and they disagreed with
      // the API row two lines below in opposite directions. The
      // numerator counted activeTools, which excluded the ticked server
      // tools even though their definitions were in the same array; the
      // denominator was TOOLS.length, which counted neither the server
      // tools nor anything borrowed over MCP. The panel said "6 of 6"
      // on a request that carried 7 definitions — and the one number a
      // reader checks against the request body was the wrong one.
      const sentCount = allDefinitions.length;

      log.info(
        sentCount === 0
          ? "No tools sent — Claude will not know any exist"
          : `${sentCount} of ${offerable} tool(s) sent ` +
            `(${definitionBytes} chars of definitions)`,
        {
          note:
            "There is no tool registration step. The full definitions below " +
            "are included in every request, because the API keeps no state " +
            "between calls. This is what the model reads when deciding " +
            "whether a tool applies.",
          // Broken out by who runs each one. A flat list of names could
          // not show that roll_dice is executed over MCP while
          // web_search is executed by Anthropic — which is the whole
          // distinction this panel exists to teach.
          enabled: activeTools.map((t) => t.name),
          enabled_by_runner: {
            this_server: activeTools
              .filter((t) => !mcpToolNames.has(t.name))
              .map((t) => t.name),
            mcp_server: activeTools
              .filter((t) => mcpToolNames.has(t.name))
              .map((t) => t.name),
            anthropic: activeServerTools.map((t) => t.name),
          },
          definition_characters: definitionBytes,
          definitions: apiTools,
        },
        { actor: "user", because: "these tools are ticked in the Tools tab" },
      );
    }

    if (messages.length === 0) {
      send({ type: "error", message: "No messages were provided." });
      res.end();
      return;
    }

    // --- Call Claude ---------------------------------------------------------

    // A choice this model will reject. Say so before the 400 arrives, so
    // the error reads as expected behaviour rather than a broken app.
    if (toolChoiceOption.rejected && toolChoice) {
      log.info(
        `tool_choice "${toolChoiceOption.id}" is not supported on this model`,
        {
          note:
            "Forced tool use was removed on Claude Opus 5.5, Sonnet 5.5 and " +
            "Fable 5.1. The request below will return a 400. Use auto and " +
            "name the tool in the prompt instead.",
          sending: toolChoice,
        },
      );
    }

    // A choice this model will reject. Say so before the 400 arrives, so
    // the error reads as expected behaviour rather than a broken app.
    if (toolChoiceOption.rejected && toolChoice) {
      log.info(
        `tool_choice "${toolChoiceOption.id}" is not supported on this model`,
        {
          note:
            "Forced tool use was removed on Claude Opus 5.5, Sonnet 5.5 and " +
            "Fable 5.1. The request below will return a 400. Use auto and " +
            "name the tool in the prompt instead.",
          sending: toolChoice,
        },
      );
    }

    log.info(
      prompt.text
        ? `System prompt: ${prompt.name} (${prompt.text.length} chars)`
        : "No system prompt",
      {
        // The full text, so a learner can read exactly what is shaping the
        // replies rather than inferring it from the tone.
        prompt_id: prompt.id,
        system: prompt.text,
      },
      { actor: "user", because: "this prompt is selected in the header" },
    );

    // --- Hand off to the selected pattern -----------------------------------
    //
    // The route's job ends here. It has validated the input, assembled
    // the tools and the prompt, and opened the stream; what to DO with
    // all that is the pattern's decision.
    //
    // Note what the route does not know: whether this will make one
    // request or eight, whether tools will run, whether a second model
    // is involved. Adding a pattern touches the pattern file and the
    // registry, and nothing here.
    const { pattern, fellBack } = getPattern(body.pattern);

    if (fellBack && body.pattern !== undefined) {
      log.error(
        `Unknown pattern "${String(body.pattern)}" — using ${pattern.name}`,
        { requested: body.pattern, available: PATTERNS.map((p) => p.id) },
        { actor: "app", because: "the requested pattern id is not registered" },
      );
    }

    log.info(
      `Pattern: ${pattern.name}`,
      {
        pattern_id: pattern.id,
        typical_requests: pattern.typicalRequests,
        description: pattern.description,
      },
      { actor: "user", because: "this pattern is selected in Settings" },
    );

    log.info(
      `Models · deciding: ${getModelOption(models.deciding).name} · ` +
        `producing: ${getModelOption(models.producing).name} · ` +
        `judging: ${getModelOption(models.judging).name}`,
      {
        assignment: models,
        note:
          "Every call this pattern makes falls into one of these three " +
          "roles. Change them in Settings and re-run the same question " +
          "to see what each is worth.",
      },
      { actor: "user", because: "these models are selected in Settings" },
    );

    const result = await pattern.run({
      messages,
      system: prompt.text,
      tools: apiTools,
      toolChoice,
      models,
      cacheMode,
      thinkingDisplay,
      effort,
      log,
      emitText: (fragment) => send({ type: "delta", text: fragment }),
      emitThinking: (text) => send({ type: "thinking", text }),
      onToolStart: (id, name, input, iteration) =>
        send({ type: "tool_start", id, name, input, iteration }),
      onToolEnd: (id, name, toolResult, isError, elapsedMs) =>
        send({ type: "tool_end", id, name, result: toolResult, isError, elapsedMs }),
    });

    const elapsedMs = Date.now() - startedAt;

    // The models this pattern actually used, in role order.
    //
    // Derived from the pattern's own usesRoles rather than from the
    // result, because a pattern may call two or three different models
    // and PatternResult carries one answer, not one model. Listing
    // every assigned model instead would name a judging model for a
    // single call that has no evaluator.
    const modelsUsed = [
      ...new Set(pattern.usesRoles.map((role) => models[role])),
    ];

    log.info(
      `${pattern.name} finished · ${result.requests} request(s) · ` +
        `${formatCost(result.cost)} · ${elapsedMs} ms · effort ${effort}`,
      {
        pattern: pattern.id,
        requests: result.requests,
        total_cost: result.cost,
        elapsed_ms: elapsedMs,
        models: modelsUsed,
        // The level and what it produced, side by side. The whole
        // point of the control is the trade-off between them, and a
        // level logged without its token count does not show one.
        effort,
        effort_note:
          "Ask the same question at another level and compare the " +
          "output tokens on the response row above. On an easy " +
          "question a higher level often spends more and returns " +
          "the same answer — which is the result worth seeing.",
      },
      { actor: "app", because: "the pattern returned its answer" },
    );

    send({
      type: "done",
      text: result.text,
      cost: result.cost,
      elapsedMs,
      requests: result.requests,
      models: modelsUsed,
    });
  } catch (error: unknown) {
    // Turn the failure into something the person waiting can act on, and
    // log the technical detail separately for the panel.
    const explained = explainError(error);

    log.error(explained.summary, {
      kind: explained.kind,
      status: explained.status,
      retryable: explained.retryable,
      // The raw message, which may be long and is not shown in the UI.
      original: error instanceof Error ? error.message : String(error),
    });

    send({ type: "error", message: explained.message });
  } finally {
    // Ending the response closes the stream. In a finally block because an
    // unclosed stream leaves the browser waiting forever on a request that
    // will never complete.
    res.end();
  }
});

// --- Start ------------------------------------------------------------------

// Fail fast on a misconfigured tool registry.
//
// A duplicate tool name is not an error that shows up in the logs — the
// lookup Map silently keeps only the last registration, so one tool just
// never runs. Checking at boot turns a confusing runtime mystery into a
// crash with a clear message, which is the right trade for something that
// can only be wrong at development time.
assertUniqueToolNames();

app.listen(PORT, () => {
  console.log(`\n  Anthropic Chat Lab`);
  console.log(`  Listening on http://localhost:${PORT}`);
  console.log(`  Health check  http://localhost:${PORT}/api/health`);

  // Listing the tools at startup makes a registration mistake obvious
  // immediately, rather than when someone notices a tool is missing from
  // the UI an hour later.
  console.log(`\n  ${TOOLS.length} tools registered:`);
  for (const tool of TOOLS) {
    const where = tool.executedBy === "server" ? "server-side" : "";
    console.log(`    ${tool.name.padEnd(18)} ${where}`);
  }
  console.log("");
});
