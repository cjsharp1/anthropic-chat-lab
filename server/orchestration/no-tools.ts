/**
 * no-tools.ts — what a pattern can and cannot do with the enabled tools.
 *
 * Five of the seven patterns here make single calls and never handle a
 * tool_use response. That is a deliberate scope decision — handling
 * one means owning a loop, and a chaining pattern that also loops is
 * the tool loop with extra steps, which teaches two things badly
 * instead of one thing well.
 *
 * But that applies only to CLIENT tools. A server tool needs no loop:
 * Anthropic runs it inside the response and carries on generating,
 * which is precisely what makes it a server tool. Treating the two
 * alike meant every pattern except Tool loop silently discarded
 * web_search, and Claude answered "I can't search the web here" from
 * a request that could have carried the tool.
 *
 * Silence about the client tools would be misleading too. The Tools
 * tab says "3/6 enabled", and a pattern that quietly drops them makes
 * that number a lie.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../logger.js";

/**
 * Splits the enabled tools into the two kinds.
 *
 * Server tools are identified by their type prefix rather than by a
 * list of known names, so a new one added later is classified
 * correctly without this file changing.
 */
export function splitToolKinds(tools: Anthropic.ToolUnion[] | undefined): {
  server: Anthropic.ToolUnion[];
  client: Anthropic.ToolUnion[];
} {
  const all = tools ?? [];

  // Anthropic's hosted tools carry a dated type like
  // "web_search_20260209". A custom tool has no type at all.
  const isServer = (tool: Anthropic.ToolUnion): boolean => {
    const type = String((tool as { type?: unknown }).type ?? "");
    return /^(web_search|web_fetch|code_execution)_/.test(type);
  };

  return {
    server: all.filter(isServer),
    client: all.filter((tool) => !isServer(tool)),
  };
}

/**
 * Warns about client tools a pattern cannot run, and returns the
 * server tools it can.
 *
 * @param tools       the enabled tool definitions, or undefined
 * @param patternName the pattern's display name, for the message
 * @param reason      why this pattern cannot run client tools
 * @param log         where to report it
 * @returns the server tools, to be included in the request
 */
export function warnToolsIgnored(
  tools: Anthropic.ToolUnion[] | undefined,
  patternName: string,
  reason: string,
  log: Logger,
): Anthropic.ToolUnion[] | undefined {
  const { server, client } = splitToolKinds(tools);

  if (client.length > 0) {
    log.warn(
      `${client.length} client tool(s) enabled, but ${patternName} does not run them`,
      {
        enabled: client.map((tool) =>
          "name" in tool ? tool.name : tool.type,
        ),
        why: reason,
        note:
          "Their definitions are not sent, so Claude is not told they " +
          "exist and will answer from its own knowledge. If the question " +
          "needs one, use the Tool loop pattern.",
      },
      {
        actor: "app",
        because: "this pattern cannot handle a tool_use response",
      },
    );
  }

  if (server.length > 0) {
    log.info(
      `${server.length} server tool(s) sent: ` +
        server.map((tool) => ("name" in tool ? tool.name : tool.type)).join(", "),
      {
        tools: server,
        note:
          "Server tools work in any pattern, because there is no second " +
          "request to make — Anthropic runs them while generating the " +
          "response. That is the whole difference between the two kinds.",
      },
      {
        actor: "app",
        because: "server tools need no loop, so this pattern can use them",
      },
    );
  }

  return server.length > 0 ? server : undefined;
}
