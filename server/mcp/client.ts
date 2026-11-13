/**
 * client.ts — the connection to an MCP server, and the tools it lends us.
 *
 * Holds at most one connection at a time. Connect, and the remote
 * server's tools join the registry as though they had always been
 * there; disconnect, and they vanish. Nothing else in the app has to
 * know the difference.
 *
 * ---------------------------------------------------------------------------
 * The point of the exercise
 * ---------------------------------------------------------------------------
 *
 * This app already executes tools. Adding a second way to execute them
 * would teach nothing except that it is possible.
 *
 * What is worth seeing is that from the MODEL's point of view there is
 * no second way. One `tools` array goes out, one `tool_use` block comes
 * back, one `tool_result` goes in the next request. Whether the
 * function ran in this process, on Anthropic's servers, or on a machine
 * reached over MCP is invisible to it — and is entirely this server's
 * problem.
 *
 * So MCP tools are adapted into `LabTool` and dropped into the same
 * list as the local ones. The tool loop was not changed to accommodate
 * them. That it did not need to be is the lesson.
 *
 * ---------------------------------------------------------------------------
 * Connection state lives here, like the API key
 * ---------------------------------------------------------------------------
 *
 * In memory, for the life of the process, set through the app's own
 * Settings dialog. The same arrangement as `api-key.ts` and for a
 * related reason: a connection is a live object with a socket or a
 * child process behind it, and it cannot be reconstructed from a
 * config file at import time.
 *
 * It is also a single connection rather than a set. A lab that can
 * connect to several servers at once has to answer which one a tool
 * came from on every row, and the answer is noise while the lesson is
 * still "a tool can come from somewhere else at all".
 */

import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Transport } from "@modelcontextprotocol/client";
import type { AnyLabTool } from "../tools/types.js";
import { TOOLS } from "../tools/registry.js";
import { SERVER_TOOLS } from "../tools/server-tools.js";
import { schemaFromJson } from "./schema.js";

/** How this app identifies itself in the MCP handshake. */
const CLIENT_NAME = "anthropic-chat-lab";
const CLIENT_VERSION = "1.0.0";

/** Which transport to use, as chosen in Settings. */
export type McpTransportKind = "http" | "stdio";

/** What Settings sends when asked to connect. */
export interface McpConnectRequest {
  transport: McpTransportKind;
  /** For http: the endpoint URL. */
  url?: string;
  /** For stdio: the command to launch, and its arguments. */
  command?: string;
  args?: string[];
}

/** What the browser is told about the current connection. */
export interface McpStatus {
  connected: boolean;
  transport?: McpTransportKind;
  /** Where it is connected to, for display. Never a secret. */
  target?: string;
  serverName?: string;
  serverVersion?: string;
  /** Tools borrowed from the server, by name. */
  toolNames: string[];
  /**
   * Remote tools that could not be used because a local tool already
   * has that name. Surfaced rather than silently dropped — see
   * `adaptTools` for why.
   */
  shadowed: string[];
  /** Why the last connection attempt failed, if it did. */
  error?: string;
}

/** The live connection, or null. Module state, like the API key. */
let client: Client | null = null;
let transportKind: McpTransportKind | null = null;
let target: string | null = null;
let serverName: string | null = null;
let serverVersion: string | null = null;
let borrowed: AnyLabTool[] = [];
let shadowed: string[] = [];
let lastError: string | null = null;

/**
 * Every name already taken by a local tool.
 *
 * Computed on each call rather than cached, because it is cheap and
 * because a cached copy would be one more thing that can be stale.
 * Both registries are included: a remote tool named `web_search` would
 * collide with the server tool just as surely as one named
 * `calculator` collides with the client tool.
 */
function localNames(): Set<string> {
  return new Set([
    ...TOOLS.map((tool) => tool.name),
    ...SERVER_TOOLS.map((tool) => tool.name),
  ]);
}

/**
 * Turns the server's tool list into LabTools.
 *
 * ---------------------------------------------------------------------------
 * Name collisions, and why they are a warning rather than an error
 * ---------------------------------------------------------------------------
 *
 * `TOOLS_BY_NAME` is a Map, so two tools with one name means the
 * second silently wins and the first can never run. The registry's own
 * comment says exactly that, and `assertUniqueToolNames` exists to
 * crash on boot rather than let it happen.
 *
 * That check cannot be applied here. The remote tools are not ours:
 * they arrive at runtime, from a server the user chose, and we cannot
 * rename them. Crashing the app because someone connected to a server
 * with a `calculator` would be absurd, and silently shadowing the
 * local one would be worse — the user would see a familiar tool
 * behaving strangely with no indication why.
 *
 * So a collision drops the REMOTE tool, keeps the local one, and says
 * so: in the status the Settings dialog shows, and in a warning row in
 * the activity log. Local wins because it is the one the user can
 * reason about, and because the alternative silently changes what an
 * existing tool does.
 */
function adaptTools(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
): { adapted: AnyLabTool[]; clashes: string[] } {
  const taken = localNames();
  const adapted: AnyLabTool[] = [];
  const clashes: string[] = [];

  for (const tool of tools) {
    if (taken.has(tool.name)) {
      clashes.push(tool.name);
      continue;
    }

    // Guards against the remote server itself offering two tools with
    // one name, which the protocol does not forbid and which would
    // produce the same silent shadowing one level down.
    taken.add(tool.name);

    adapted.push({
      name: tool.name,

      description:
        tool.description ??
        `A tool provided by the connected MCP server. The server gave ` +
          `no description, which means Claude has very little to go on ` +
          `when deciding whether to use it.`,

      // The server's JSON Schema, carried verbatim. No conversion —
      // see schema.ts for why that matters more than it looks.
      inputSchema: schemaFromJson(tool.inputSchema),

      executedBy: "mcp",

      async run(input: unknown): Promise<string> {
        // Checked at call time rather than captured at adaptation
        // time. A tool whose connection has been closed should say so
        // clearly; a captured `client` would throw something less
        // helpful from inside the SDK.
        if (!client) {
          throw new Error(
            "The MCP server is no longer connected. Reconnect it in " +
              "Settings, or untick this tool.",
          );
        }

        const result = await client.callTool({
          name: tool.name,
          arguments: (input ?? {}) as Record<string, unknown>,
        });

        // A tool result is an array of content blocks that may be
        // text, images or embedded resources. Only text can go back
        // in a tool_result here, so the rest is named rather than
        // dropped silently — a model told "[image]" can say it
        // received an image, where one handed an empty string cannot.
        const text = (Array.isArray(result.content) ? result.content : [])
          .map((block: unknown) => {
            if (
              typeof block === "object" &&
              block !== null &&
              (block as { type?: unknown }).type === "text"
            ) {
              return String((block as { text: unknown }).text);
            }
            const kind =
              typeof block === "object" && block !== null
                ? String((block as { type?: unknown }).type ?? "unknown")
                : "unknown";
            return `[${kind} content, not shown]`;
          })
          .join("\n");

        // The remote server reports failure in-band, with isError on
        // a normal result rather than a protocol error. Rethrown here
        // so the tool loop treats it exactly like a local tool
        // throwing — which is what puts is_error on the tool_result
        // and lets Claude recover.
        if (result.isError) {
          throw new Error(text || "The MCP tool reported an error.");
        }

        return text;
      },

      examplePrompt: `Use the ${tool.name} tool.`,

      exampleWatch:
        "The tool row is tagged mcp. Claude cannot tell the " +
        "difference — the request it saw lists this tool beside the " +
        "local ones.",
    } as AnyLabTool);
  }

  return { adapted, clashes };
}

/** Builds the transport Settings asked for. */
function buildTransport(request: McpConnectRequest): {
  transport: Transport;
  target: string;
} {
  if (request.transport === "stdio") {
    const command = request.command?.trim();
    if (!command) {
      throw new Error("A command is required to connect over stdio.");
    }

    const args = request.args ?? [];

    return {
      // This spawns a child process. Worth being plain about: the
      // command comes from the Settings dialog, so anyone who can
      // reach this app's UI can run a program on this machine. The
      // app binds to localhost and has no authentication, which is
      // what keeps that acceptable — and is the same reason the
      // README says not to expose it.
      transport: new StdioClientTransport({ command, args }),
      target: [command, ...args].join(" "),
    };
  }

  const url = request.url?.trim();
  if (!url) {
    throw new Error("A URL is required to connect over HTTP.");
  }

  // Parsed here so a malformed URL fails with a clear message rather
  // than an obscure error from inside fetch later.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }

  return {
    transport: new StreamableHTTPClientTransport(parsed),
    target: parsed.href,
  };
}

/**
 * Connects, replacing any existing connection.
 *
 * Returns the new status rather than throwing on a failed connection:
 * a server that is not running is an ordinary thing to happen in a
 * lab, and the dialog needs the reason to show it.
 */
export async function connect(request: McpConnectRequest): Promise<McpStatus> {
  // Closed first, so a failed reconnection does not leave the previous
  // one half-attached. Disconnecting is also the honest state to be in
  // while the new attempt is in flight.
  await disconnect();

  lastError = null;

  try {
    const built = buildTransport(request);

    const next = new Client(
      { name: CLIENT_NAME, version: CLIENT_VERSION },
      { versionNegotiation: { mode: "auto" } },
    );

    await next.connect(built.transport);

    const listed = await next.listTools();
    const { adapted, clashes } = adaptTools(listed.tools);

    client = next;
    transportKind = request.transport;
    target = built.target;
    borrowed = adapted;
    shadowed = clashes;

    const info = next.getServerVersion();
    serverName = info?.name ?? "unknown";
    serverVersion = info?.version ?? "unknown";
  } catch (error: unknown) {
    lastError = error instanceof Error ? error.message : String(error);
    await disconnect();
  }

  return getStatus();
}

/** Closes the connection, if there is one. Safe to call when there is not. */
export async function disconnect(): Promise<void> {
  const open = client;

  // Cleared before awaiting the close, so a tool call racing the
  // disconnect sees "not connected" rather than reaching a client
  // that is halfway shut.
  client = null;
  transportKind = null;
  target = null;
  serverName = null;
  serverVersion = null;
  borrowed = [];
  shadowed = [];

  if (!open) return;

  try {
    await open.close();
  } catch {
    // A close that fails has still achieved what matters: nothing
    // above points at this client any more. Reporting it would
    // produce an error row for an operation the user asked for and
    // which, from their point of view, succeeded.
  }
}

/** The tools currently borrowed from the connected server. */
export function getMcpTools(): AnyLabTool[] {
  return borrowed;
}

/** What to tell the browser. */
export function getStatus(): McpStatus {
  return {
    connected: client !== null,
    ...(transportKind ? { transport: transportKind } : {}),
    ...(target ? { target } : {}),
    ...(serverName ? { serverName } : {}),
    ...(serverVersion ? { serverVersion } : {}),
    toolNames: borrowed.map((tool) => tool.name),
    shadowed,
    ...(lastError ? { error: lastError } : {}),
  };
}
