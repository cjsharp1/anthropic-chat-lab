/**
 * transcript.ts — the tool cards that appear between messages.
 *
 * A tool call is not a message and should not look like one: the card
 * is narrower and plainer than a turn, and says what ran, with what
 * input, and what came back.
 *
 * Deliberately small. The A/B comparison and the structured-output
 * card also draw into the transcript, but both send their own
 * requests and belong with the sending code in app.ts — moving them
 * here would mean importing the whole request machinery and handing
 * app.ts an import cycle in return.
 */

import { state } from "./state.js";

const transcript = document.getElementById(
  "transcript",
) as HTMLElement;

// --- Tool cards in the transcript -------------------------------------------

/**
 * Tool cards currently on screen, keyed by tool_use_id.
 *
 * Needed because a card is created when the tool starts and updated when
 * it finishes, and with parallel calls several are open at once. The id
 * is what pairs the two events — the same id the API uses to pair a
 * tool_use with its tool_result.
 */
export const openToolCards = new Map<string, HTMLElement>();

/**
 * Adds a card showing that a tool is running.
 *
 * The point of putting this in the transcript rather than only the log
 * is that the transcript is what someone reads. An answer that silently
 * depended on a tool looks like the model simply knew — which is exactly
 * the misconception this app exists to correct.
 */
export function appendToolCard(
  id: string,
  name: string,
  input: unknown,
  iteration: number,
): void {
  // A reply turn may be open above this; close it so the card appears
  // after the text rather than the text continuing underneath it.
  state.openTurn = null;
  state.openTurnRaw = "";

  const card = document.createElement("div");
  card.className = "tool-card is-running";

  const header = document.createElement("div");
  header.className = "tool-card-header";

  const status = document.createElement("span");
  status.className = "tool-card-status";
  status.textContent = "running";

  const toolName = document.createElement("span");
  toolName.className = "tool-card-name";
  toolName.textContent = name;

  const round = document.createElement("span");
  round.className = "tool-card-meta";
  round.textContent = iteration > 1 ? `round ${iteration}` : "";

  header.append(status, toolName, round);

  // The arguments, as the model produced them. Worth showing: watching
  // Claude pick {a: 847293, b: 61847, op: "multiply"} out of a sentence
  // is the clearest demonstration of what a tool schema is for.
  const args = document.createElement("pre");
  args.className = "tool-card-args";
  args.textContent = formatToolInput(input);

  card.append(header, args);
  transcript.appendChild(card);
  openToolCards.set(id, card);

  transcript.scrollTop = transcript.scrollHeight;
}

/** Updates a card once its tool has finished. */
export function completeToolCard(
  id: string,
  result: string,
  isError: boolean,
  elapsedMs: number,
): void {
  const card = openToolCards.get(id);
  if (!card) return; // never started, or already cleared

  openToolCards.delete(id);

  card.classList.remove("is-running");
  card.classList.add(isError ? "is-error" : "is-done");

  const status = card.querySelector(".tool-card-status");
  if (status) status.textContent = isError ? "failed" : "done";

  const meta = card.querySelector(".tool-card-meta");
  if (meta) meta.textContent = `${elapsedMs}ms`;

  // The result, collapsed. A search result can be three thousand
  // characters, and the transcript is meant to stay readable — the
  // headline is that the tool ran and what it returned in summary.
  const details = document.createElement("details");
  details.className = "tool-card-result";

  const summary = document.createElement("summary");
  summary.textContent = truncateForCard(result, 72);

  const body = document.createElement("pre");
  body.textContent = result;

  details.append(summary, body);
  card.appendChild(details);

  transcript.scrollTop = transcript.scrollHeight;
}

/** Formats tool arguments compactly, one per line when there are several. */
function formatToolInput(input: unknown): string {
  if (input === null || typeof input !== "object") return String(input);

  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return "(no arguments)";

  return entries
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
}

/** One-line preview of a result, for the collapsed summary. */
function truncateForCard(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/**
 * Shows a failure in the transcript, styled as an error rather than a reply.
 *
 * Deliberately not an assistant turn. A failure rendered in the same style
 * as Claude's answers invites someone to read it as something Claude said,
 * which in a teaching app is actively misleading.
 */
export function appendError(message: string): HTMLElement {
  const turn = document.createElement("div");
  turn.className = "turn turn-error";
  turn.setAttribute("role", "alert"); // announced immediately by screen readers

  const heading = document.createElement("strong");
  heading.textContent = "Request failed";

  const body = document.createElement("span");
  body.textContent = message;

  turn.append(heading, body);
  transcript.appendChild(turn);
  transcript.scrollTop = transcript.scrollHeight;
  return turn;
}
