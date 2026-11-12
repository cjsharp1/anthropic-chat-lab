/**
 * server-tool-log.ts — making Anthropic's own tool use visible.
 *
 * A client tool produces three log rows in this app: Claude asking,
 * our server calling, the tool returning. A server tool produced none
 * at all, because none of it happens in our code — which made the
 * activity panel quietly misleading. A search would run, cost real
 * money, and leave no trace except a larger input token count.
 *
 * The record is in the response, though. Anthropic returns blocks
 * describing what it did:
 *
 *   server_tool_use           what it ran, with the arguments
 *   web_search_tool_result    what came back
 *   code_execution_tool_result  the dynamic filtering's own output
 *
 * This module turns those into the same shape of row a client tool
 * produces, so the two can be compared directly. The direction markers
 * differ, and that difference is the lesson: a client tool's call goes
 * out from this machine, while a server tool's arrived already done.
 *
 * ---------------------------------------------------------------------------
 * The code_execution blocks
 * ---------------------------------------------------------------------------
 *
 * Worth not hiding. The `web_search_20260209` variant runs dynamic
 * filtering, which means Anthropic executes Python to sift the results
 * before Claude reads them. Seeing that in the log answers a question
 * people reasonably have — "did it really read ten pages?" — and
 * explains why a search costs what it does.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../logger.js";

/** One thing Anthropic did while producing the response. */
interface ServerToolEvent {
  kind: "use" | "result";
  name: string;
  detail: unknown;
}

/**
 * Pulls the server-tool activity out of a response's content blocks.
 *
 * Returns them in the order they appear, which is the order they
 * happened — the blocks are interleaved with the text exactly as the
 * model produced them.
 */
function extractEvents(content: Anthropic.ContentBlock[]): ServerToolEvent[] {
  const events: ServerToolEvent[] = [];

  for (const block of content) {
    const raw = block as unknown as Record<string, unknown>;
    const type = String(raw["type"]);

    if (type === "server_tool_use") {
      events.push({
        kind: "use",
        name: String(raw["name"] ?? "unknown"),
        detail: raw["input"],
      });
      continue;
    }

    if (type.endsWith("_tool_result")) {
      events.push({
        kind: "result",
        // "web_search_tool_result" -> "web_search"
        name: type.replace(/_tool_result$/, ""),
        detail: raw["content"],
      });
    }
  }

  return events;
}

/** A readable one-line summary of what a server tool was asked to do. */
function describeInput(input: unknown): string {
  if (input === null || typeof input !== "object") return String(input ?? "");

  const record = input as Record<string, unknown>;

  // A search's query is the interesting part.
  if (typeof record["query"] === "string") {
    return `"${record["query"]}"`;
  }

  // Code execution: the first line, which is usually enough to see
  // what it is doing.
  if (typeof record["code"] === "string") {
    const firstLine = record["code"].split("\n")[0] ?? "";
    return firstLine.length > 54 ? `${firstLine.slice(0, 54)}…` : firstLine;
  }

  const summary = JSON.stringify(record);
  return summary.length > 54 ? `${summary.slice(0, 54)}…` : summary;
}

/** A readable one-line summary of what came back. */
function describeResult(detail: unknown): string {
  if (Array.isArray(detail)) {
    const first = detail[0] as Record<string, unknown> | undefined;
    const title = typeof first?.["title"] === "string" ? first["title"] : null;
    return title
      ? `${detail.length} result(s), first: "${title.slice(0, 40)}"`
      : `${detail.length} result(s)`;
  }

  if (detail !== null && typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    if (typeof record["stdout"] === "string") {
      const out = record["stdout"].trim().split("\n")[0] ?? "";
      return out ? `stdout: ${out.slice(0, 44)}` : "(no output)";
    }
    return Object.keys(record).join(", ");
  }

  return String(detail ?? "");
}

/**
 * Logs what Anthropic did on its own during this response.
 *
 * Called after a response arrives, whether or not any server tools
 * were used — it does nothing when there is nothing to report.
 */
export function logServerToolActivity(
  content: Anthropic.ContentBlock[],
  iteration: number,
  log: Logger,
): void {
  const events = extractEvents(content);
  if (events.length === 0) return;

  log.info(
    `Anthropic ran ${events.filter((e) => e.kind === "use").length} server-side ` +
      "operation(s) inside this response",
    {
      note:
        "None of this happened in our code. There was no tool_use stop " +
        "reason, no second request, and no tool_result sent back — the " +
        "work ran between the request leaving and the response " +
        "arriving. Compare with a client tool, where each of those is a " +
        "separate step you can see.",
      operations: events.map((e) => ({ kind: e.kind, name: e.name })),
    },
    {
      iteration,
      actor: "claude",
      because: "the response contained server-side tool blocks",
    },
  );

  for (const event of events) {
    if (event.kind === "use") {
      log.tool(
        `[server] ${event.name}(${describeInput(event.detail)})`,
        { tool: event.name, input: event.detail, executed_by: "anthropic" },
        {
          // Direction "none", not "call". A client tool's call leaves
          // this machine and the row marks that crossing. This one is
          // a record of something that already happened elsewhere —
          // nothing is in flight as it is logged.
          iteration,
          actor: "claude",
          because: "Anthropic ran this while generating the response",
        },
      );
    } else {
      log.tool(
        `[server] ${event.name} → ${describeResult(event.detail)}`,
        {
          tool: event.name,
          executed_by: "anthropic",
          // The full results, so "did it really read ten pages" has an
          // answer rather than an assumption.
          result: event.detail,
        },
        {
          iteration,
          actor: "claude",
          because: `${event.name} returned to Anthropic, not to us`,
        },
      );
    }
  }
}
