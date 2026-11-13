/**
 * app.ts — everything that happens in the browser.
 *
 * This file is TypeScript, and browsers cannot run TypeScript. It compiles to
 * public/app.js, which is what index.html actually loads:
 *
 *     npm run build:client     once
 *     npm run watch:client     recompile on every save
 *
 * It has no access to your API key and never will. Its job is to collect what
 * you type, send it to our own server, and render whatever comes back. All
 * Claude calls happen server-side.
 */


// --- Element lookups --------------------------------------------------------
//
// Every id here is defined in index.html. Looking them up once at startup,
// rather than on each use, means a typo fails immediately and loudly instead
// of silently doing nothing on the hundredth click.
//
// The `as` casts tell TypeScript which element type to expect.
// getElementById returns the generic HTMLElement, which has no .value — so
// reading the textarea would not compile without this.

const form = document.getElementById("composer-form") as HTMLFormElement;
const input = document.getElementById("message-input") as HTMLTextAreaElement;
const sendButton = document.getElementById("send-button") as HTMLButtonElement;
const transcript = document.getElementById("transcript") as HTMLElement;
// The panel is the element that scrolls; the list inside it just grows.
const logClearButton = document.getElementById("log-clear") as HTMLButtonElement;
const sessionClearButton = document.getElementById(
  "session-clear",
) as HTMLButtonElement;
const presetsRow = document.getElementById("presets") as HTMLElement;
const resizer = document.getElementById("column-resizer") as HTMLElement;
const settingsSummary = document.getElementById("settings-summary") as HTMLButtonElement;

/**
 * Fails loudly at startup if the HTML and this file have drifted apart.
 *
 * Without it, a renamed id produces `null`, and the first symptom is a
 * confusing "cannot read properties of null" somewhere unrelated, much later.
 */
function assertElements(): void {
  const required = {
    "composer-form": form,
    "message-input": input,
    "send-button": sendButton,
    transcript,
    "log-clear": logClearButton,
    "column-resizer": resizer,
    "settings-summary": settingsSummary,
  };

  for (const [id, element] of Object.entries(required)) {
    if (!element) {
      throw new Error(
        `index.html is missing an element with id="${id}". ` +
          `app.ts expects it to exist.`,
      );
    }
  }
}

// --- Rendering --------------------------------------------------------------



/**
 * Replaces a turn's contents with rendered Markdown, and adds a control
 * for switching back to the raw source.
 *
 * Seeing both is worth more than seeing either. The rendered version is
 * what a user reads; the raw version is what the API actually returned,
 * and the gap between them is where a surprising amount of confusion
 * lives — why a list did not become a list, where those asterisks came
 * from, whether the model emitted a table you are not rendering.
 *
 * See markdown.ts for why the renderer is a hand-written subset rather
 * than a library: the input is model output, and nothing in it can turn
 * into markup.
 */
function renderInto(element: HTMLElement, source: string): void {
  // Stash the source on the element. Once rendered to DOM nodes the
  // original is not recoverable from textContent — the asterisks and
  // backticks are gone.
  element.dataset["raw"] = source;
  element.dataset["view"] = "rendered";

  // The toggle is NOT appended here: it lives in the message's footer
  // bar, built once by appendTurnFooter. Appending it to the bubble as
  // well would put two of them on every reply.
  element.replaceChildren(renderMarkdown(source));
}

/**
 * Builds the rendered/raw switch for one turn.
 *
 * A button rather than a checkbox: it is an action ("show me the other
 * thing"), not a setting, and its label says which view you will get.
 */
function buildViewToggle(turn: HTMLElement): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "view-toggle";
  button.textContent = "View raw";
  button.title = "Show the Markdown source exactly as the API returned it";

  button.addEventListener("click", (event) => {
    // The turn is inside the transcript, which has its own click
    // handling; stopping propagation keeps this local.
    event.stopPropagation();
    toggleTurnView(turn);
  });

  return button;
}

/** Switches one turn between rendered Markdown and raw source. */
function toggleTurnView(turn: HTMLElement): void {
  const source = turn.dataset["raw"] ?? "";
  const showingRaw = turn.dataset["view"] === "raw";

  if (showingRaw) {
    turn.dataset["view"] = "rendered";
    turn.classList.remove("is-raw");
    turn.replaceChildren(renderMarkdown(source));
  } else {
    turn.dataset["view"] = "raw";
    turn.classList.add("is-raw");

    // textContent, so every construct shows literally — the asterisks,
    // the backticks, the newlines. This is the point of the view.
    const pre = document.createElement("pre");
    pre.className = "raw-source";
    pre.textContent = source;
    turn.replaceChildren(pre);
  }

  // The toggle lives in the message's footer bar, not in the bubble,
  // so it is found and relabelled rather than appended here.
  const existing = turn.parentElement?.querySelector<HTMLButtonElement>(
    ".view-toggle",
  );
  if (existing) {
    existing.textContent = showingRaw ? "View raw" : "View rendered";
  }
}


/**
 * Scrolls the transcript to the newest content, unless the reader has
 * scrolled up to re-read something earlier.
 *
 * Same rule as the log panel. It matters more here: a streaming reply fires
 * this on every fragment, so without the check it would be impossible to
 * read back while Claude is still talking.
 */
function isTranscriptAtBottom(): boolean {
  const distanceFromBottom =
    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
  // Looser than the log's tolerance: a streaming reply grows by a few
  // pixels between frames, so an exact test would stop following mid-word.
  return distanceFromBottom < 60;
}

/** Scrolls the transcript to the newest content. */
function scrollTranscriptToBottom(): void {
  transcript.scrollTop = transcript.scrollHeight;
}

/**
 * Adds one turn to the transcript and scrolls it into view.
 *
 * `role` picks the styling: user turns sit right in the accent colour,
 * assistant turns sit left on a plain surface. The CSS for both is already
 * in styles.css.
 *
 * Note the use of `textContent` rather than `innerHTML`. Claude's replies are
 * text, and assigning text to innerHTML would let anything that looks like
 * markup become real markup. Even in a local teaching app that is the wrong
 * habit to build, because the same code shape in a real app is an XSS hole.
 */
function appendTurn(
  role: "user" | "assistant",
  text: string,
  options: { extractable?: boolean } = {},
): HTMLElement {
  // Each message is a block, not a loose bubble.
  //
  // A message owns things besides its text: what it cost, a link to
  // extract from it, the extraction that came back. When those were
  // siblings in the transcript they each aligned themselves, which is
  // how the cost line ended up outside the bubble while "View raw"
  // sat inside it. The wrapper owns the alignment now, and everything
  // belonging to one message sits in one place.
  const block = document.createElement("div");
  block.className = `message message-${role}`;

  const turn = document.createElement("div");
  turn.className = `turn turn-${role}`;
  turn.textContent = text;
  block.appendChild(turn);

  // A user message carries its own Extract action, because an
  // extraction describes ONE message rather than the chat as a whole.
  // Synthetic markers (the "[Re-run with…]" label) opt out: there is
  // no question there to describe.
  if (role === "user" && options.extractable !== false) {
    block.appendChild(buildExtractAction(text, block));
  }

  transcript.appendChild(block);

  // Keep the newest turn visible.
  transcript.scrollTop = transcript.scrollHeight;
  return turn;
}

/**
 * Shows a reasoning summary above the reply it belongs to.
 *
 * Collapsed by default. The summary is genuinely interesting the first
 * few times and then becomes something you skim past, so it opens on
 * request rather than pushing the answer down the screen every turn.
 */
function appendThinkingBlock(text: string): void {
  const block = document.createElement("details");
  block.className = "message message-assistant thinking-block";

  const summary = document.createElement("summary");
  summary.textContent = "Reasoning summary";
  block.appendChild(summary);

  const body = document.createElement("div");
  body.className = "thinking-body";
  // textContent, not innerHTML: this is model output like any other.
  body.textContent = text;
  block.appendChild(body);

  const note = document.createElement("p");
  note.className = "thinking-note";
  note.textContent =
    "A summary, not the raw chain of thought — the API never returns " +
    "that. This reasoning happened whether or not you asked to see it, " +
    "and was billed either way.";
  block.appendChild(note);

  transcript.appendChild(block);
}

/**
 * Formats a cost in dollars.
 *
 * Four decimals below a dollar, matching formatCost on the server. Two
 * would collapse $0.0004 and $0.0049 into the same "$0.00", which is
 * exactly the comparison this app exists to support.
 */
function formatMoney(dollars: number): string {
  if (dollars === 0) return "$0.00";
  return dollars < 1 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;
}

/**
 * The one-line summary shown under a reply: what ran, what it cost,
 * how long it took.
 *
 * Several models are joined with a plus rather than reduced to one,
 * because a routing or evaluator pattern genuinely used more than one
 * and naming a single model would misattribute the cost.
 */
function describeRun(
  models: string[] | undefined,
  cost: number | undefined,
  elapsedMs: number | undefined,
  requests = 1,
): string {
  // Every field defaulted rather than assumed.
  //
  // This used to take them at face value, and a missing `models`
  // threw inside the footer builder — after the bar element had been
  // appended but before its text was set. The result was an empty
  // grey strip under every reply and no View raw control, because the
  // throw also skipped the rest of the handler. A summary line is not
  // worth breaking a message over: show what is known, omit what is
  // not.
  const parts: string[] = [];

  if (models && models.length > 0) parts.push(models.join(" + "));
  if (typeof cost === "number") parts.push(formatMoney(cost));
  if (typeof elapsedMs === "number") parts.push(`${elapsedMs} ms`);

  // Only worth saying when it is not the obvious one. A single call
  // announcing "1 request" is noise.
  if (requests > 1) parts.push(`${requests} requests`);

  return parts.join(" · ");
}

/**
 * Adds the summary line under a finished assistant reply.
 *
 * In the transcript rather than only in the activity log, because the
 * log is a place you go and this is a number you should not have to go
 * anywhere for. It is the same line the extraction card carries, so
 * the two are directly comparable.
 */
function appendTurnFooter(
  turn: HTMLElement,
  models: string[],
  cost: number,
  elapsedMs: number,
  requests: number,
): void {
  const block = turn.parentElement ?? turn;

  // One bar holding everything about this message: what produced it,
  // what it cost, and how to look at its source.
  //
  // These used to be three separate things in three places — a button
  // inside the bubble, a monospace line under it, and nothing joining
  // them. Collecting them into one strip is what makes a message read
  // as a single object rather than a bubble with debris beneath it.
  const summary = describeRun(models, cost, elapsedMs, requests);

  // Built only once there is something to put in it. Appending the
  // bar first and filling it afterwards is what left an empty grey
  // strip under every reply when the fill step failed.
  const bar = document.createElement("div");
  bar.className = "turn-meta";

  if (summary) {
    const stats = document.createElement("span");
    stats.className = "turn-stats";
    stats.textContent = summary;
    bar.appendChild(stats);
  }

  // The raw/rendered switch, if this turn has Markdown behind it.
  // Built here rather than inside the bubble so it sits with the rest
  // of the message's controls.
  if (turn.dataset["raw"]) {
    bar.appendChild(buildViewToggle(turn));
  }

  // Nothing to show: no empty strip.
  if (bar.children.length === 0) return;

  block.appendChild(bar);
}

/**
 * The little "Extract structured data" link under a user message.
 *
 * Returned rather than appended, so appendTurn keeps control of the
 * order things go into the transcript.
 */
function buildExtractAction(message: string, block: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "turn-actions";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "link-button turn-action";
  button.textContent = "Extract structured data";
  button.title =
    "Ask Claude to describe this message as typed fields instead of " +
    "prose, constrained to a schema. Watch the activity log for the " +
    "request.";

  // The card goes inside this message's block rather than after the
  // action row. Anchoring to the row put the card wherever the row
  // happened to be in the transcript — which, once a reply had
  // arrived, was above it.
  button.addEventListener("click", () => {
    void runExtraction(message, block, button);
  });

  row.append(button);
  return row;
}

// --- Reading the event stream -----------------------------------------------

/**
 * The contract between the two halves.
 *
 * Imported from shared/types.ts rather than copied. These used to be
 * hand-mirrored here, on the reasoning that the browser half should
 * compile without reaching into server/ — which was true, but the
 * copy drifted: adding a stream event meant remembering to edit two
 * files, and twice in one afternoon the second edit was forgotten.
 *
 * `import type` rather than a plain import, deliberately. Types
 * erase at compile time, so this produces NO import statement in
 * app.js and the browser never tries to fetch shared/types.js — which
 * matters because only public/ is served.
 */
import { state } from "./state.js";
import type { LogEvent, StreamEvent } from "../shared/types.js";
import type { ExtractedEvent, Preset, RunOutcome, RunSnapshot } from "./types.js";
import { renderMarkdown } from "./markdown.js";
import {
  appendLog,
  clearLog,
  labelPreviousTurn,
  loadHiddenLevels,
  refreshSessionCost,
  renderLogFilters,
  startLogTurn,
} from "./log.js";
import {
  cacheModeSelect,
  disabledTools,
  effortSelect,
  enabledToolNames,
  handleCacheModeChange,
  handleEffortChange,
  clearApiKey,
  handlePatternChange,
  handlePromptChange,
  handleThinkingChange,
  handleToolChoiceChange,
  initApiKey,
  watchApiKeyInput,
  initCacheModes,
  initEffort,
  initModels,
  initPatterns,
  initPrompts,
  initThinking,
  initToolChoices,
  initTools,
  modelAssignment,
  modelOptions,
  patternOptions,
  patternSelect,
  promptSelect,
  roleInfo,
  saveApiKey,
  setAllTools,
  thinkingSelect,
  toolChoiceSelect,
  toolInfos,
  toolsAllButton,
  toolsNoneButton,
  toolSummary,
} from "./settings.js";
import {
  connectMcp,
  disconnectMcp,
  handleMcpTransportChange,
  refreshMcpStatus,
} from "./mcp-panel.js";
import {
  appendError,
  appendToolCard,
  completeToolCard,
  openToolCards,
} from "./transcript.js";


// --- Structured outputs -----------------------------------------------------


/**
 * Describes a value by its JSON type.
 *
 * On screen "advanced", true and ["tool_use"] all render as text,
 * which hides what the schema actually guaranteed — that this field
 * came back as a string, a boolean, an array. Naming the type beside
 * the value is what makes the guarantee visible.
 */
function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/**
 * Renders one field's value into a table cell.
 *
 * textContent throughout, never innerHTML. These values came from a
 * language model, and model output is untrusted input even when a
 * schema constrained its shape: the schema promises a string is a
 * string, not that the string is safe to parse as HTML.
 */
function renderFieldValue(cell: HTMLTableCellElement, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      const chip = document.createElement("span");
      chip.className = "extract-keyword";
      chip.textContent = String(item);
      cell.append(chip);
    }
  } else {
    cell.append(document.createTextNode(String(value)));
  }

  const type = document.createElement("span");
  type.className = "extract-type";
  type.textContent = jsonTypeOf(value);
  cell.append(type);
}

/**
 * Adds the extraction result to the transcript, under its own message.
 *
 * Inserted after `anchor` rather than appended to the end, so an
 * extraction run on an older message appears there and not at the
 * bottom of the state.conversation.
 *
 * There is no copy of the source text in the card: the message is
 * directly above it, and repeating it would just be noise.
 */
function appendExtractionCard(
  result: ExtractedEvent,
  block: HTMLElement,
): void {
  const wasAtBottom = isTranscriptAtBottom();

  // Replace an earlier result for this message rather than stacking a
  // second card — re-running after switching the deciding model is a
  // thing people will do, and two cards would leave it ambiguous
  // which one is current.
  block.querySelector(".extract-card")?.remove();

  const card = document.createElement("div");
  card.className = "extract-card";

  const heading = document.createElement("div");
  heading.className = "extract-heading";
  heading.textContent = "Structured extraction";
  card.append(heading);

  if (!result.data) {
    const failed = document.createElement("p");
    failed.className = "extract-error";
    failed.textContent =
      "The response carried no parsed output. The raw text below is " +
      "what came back.";
    card.append(failed);
  } else {
    const table = document.createElement("table");
    table.className = "extract-fields";

    for (const [field, value] of Object.entries(result.data)) {
      const row = document.createElement("tr");

      const key = document.createElement("th");
      key.textContent = field;
      row.append(key);

      const cell = document.createElement("td");
      renderFieldValue(cell, value);
      row.append(cell);

      table.append(row);
    }

    card.append(table);
  }

  // The raw text, collapsed. Expanding it is where the point lands:
  // it is bare JSON, which is why nothing had to be stripped before
  // parsing it.
  const rawWrap = document.createElement("details");
  rawWrap.className = "extract-raw-wrap";

  const rawSummary = document.createElement("summary");
  rawSummary.textContent = "The raw text Claude returned";
  rawWrap.append(rawSummary);

  const rawPre = document.createElement("pre");
  rawPre.className = "extract-raw";
  rawPre.textContent = result.raw || "(empty)";
  rawWrap.append(rawPre);

  const note = document.createElement("p");
  note.className = "extract-note";
  note.textContent =
    "No code fence, no preamble, no trailing offer to explain it. " +
    "Generation was constrained to the schema, so the failure modes " +
    "that come from asking for JSON in the prompt cannot occur.";
  rawWrap.append(note);

  card.append(rawWrap);

  const footer = document.createElement("div");
  footer.className = "extract-footer";
  footer.textContent = describeRun(
    [result.model],
    result.cost,
    result.elapsedMs,
  );
  card.append(footer);

  block.appendChild(card);
  if (wasAtBottom) scrollTranscriptToBottom();
}

/**
 * Runs an extraction for one message and streams its log rows.
 *
 * @param message The text to describe.
 * @param block   The message block this extraction belongs to; the card
 *                is appended inside it, so it stays with its own
 *                message however much arrives afterwards.
 * @param button  The clicked button, disabled while the call is in
 *                flight so a double click cannot bill twice.
 */
async function runExtraction(
  message: string,
  block: HTMLElement,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  showWaiting("Extracting structured fields");

  try {
    const response = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, models: modelAssignment }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    // The same reader the chat uses. The server logs its request before
    // the API call and its response after, so those rows arrive while
    // the call is still in flight rather than all at the end.
    await readEventStream(response, (event) => {
      if (event.type === "extracted") {
        appendExtractionCard(event, block);
      } else {
        handleStreamEvent(event);
      }
    });
  } catch (error: unknown) {
    appendLog({
      at: Date.now(),
      level: "error",
      label:
        error instanceof Error ? error.message : "The extraction failed.",
      actor: "app",
    });
  } finally {
    hideWaiting();
    button.disabled = false;
  }
}

// --- Conversation history ---------------------------------------------------


/**
 * Reads an SSE response and calls `onEvent` for each complete message.
 *
 * The important detail: a chunk from the network is NOT a message. TCP
 * delivers whatever bytes happen to have arrived, so one chunk might hold
 * three messages, or half of one. Treating each chunk as a message works
 * perfectly in testing — where messages are small and arrive slowly — and
 * then corrupts data in production under load.
 *
 * So we keep a buffer, append each chunk, and only take complete messages
 * off the front. A message is complete when we see the blank line that
 * terminates it.
 */
async function readEventStream(
  response: Response,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  if (!response.body) {
    throw new Error("Response has no body to stream");
  }

  // getReader() gives raw bytes; TextDecoderStream turns them into text,
  // correctly handling a multi-byte character split across two chunks.
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += value;

    // Messages are separated by a blank line. Split on it, and keep the
    // final piece in the buffer — it is either empty (the last message ended
    // cleanly) or a partial message still arriving.
    const messages = buffer.split("\n\n");
    buffer = messages.pop() ?? "";

    for (const message of messages) {
      // An SSE message can carry several "data:" lines, and may also carry
      // other fields (event:, id:, retry:) that we do not use. Collect the
      // data lines and ignore the rest.
      const data = message
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");

      if (!data) continue;

      try {
        onEvent(JSON.parse(data) as StreamEvent);
      } catch {
        // A malformed message should not kill the stream: the next one may
        // be fine, and losing the rest of a state.conversation over one bad line
        // would be worse than skipping it.
        console.warn("Could not parse stream message:", data);
      }
    }
  }
}

// --- Side panel tabs --------------------------------------------------------

/**
 * Wires the tab strip.
 *
 * ARIA tabs are a small spec with a specific keyboard contract: arrow keys
 * move between tabs, Home and End jump to the ends, and only the selected
 * tab is in the tab order — so Tab moves past the whole strip rather than
 * through every tab in it. Implementing that contract is what makes this a
 * tab control rather than buttons that look like one.
 */
function initTabs(): void {
  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '#settings-dialog-tabs [role="tab"]',
    ),
  );

  function select(tab: HTMLButtonElement): void {
    for (const other of tabs) {
      const isSelected = other === tab;
      other.setAttribute("aria-selected", String(isSelected));
      // Roving tabindex: only the selected tab is reachable with Tab.
      other.tabIndex = isSelected ? 0 : -1;

      const panelId = other.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      if (panel) panel.hidden = !isSelected;
    }
    tab.focus();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab));

    tab.addEventListener("keydown", (event: KeyboardEvent) => {
      let target: HTMLButtonElement | undefined;

      switch (event.key) {
        case "ArrowRight":
          target = tabs[(index + 1) % tabs.length];
          break;
        case "ArrowLeft":
          target = tabs[(index - 1 + tabs.length) % tabs.length];
          break;
        case "Home":
          target = tabs[0];
          break;
        case "End":
          target = tabs[tabs.length - 1];
          break;
        default:
          return;
      }

      if (target) {
        select(target);
        event.preventDefault();
      }
    });
  });
}

/** Brings a tab to the front from elsewhere in the app. */
function showTab(id: "tab-tools" | "tab-settings"): void {
  document.getElementById(id)?.click();
}

// --- The settings dialog ----------------------------------------------------

/**
 * Tools and settings, in a dialog rather than a tab.
 *
 * They used to be two tabs in the side panel, sharing furniture with
 * the activity log — which put the controls that shape a request in
 * the same box as the record of what the request did. A dialog
 * separates the two: the panes show what happened, the dialog changes
 * what will happen next.
 *
 * <dialog> rather than a div with an overlay, because showModal()
 * supplies the backdrop, the focus trap, Escape-to-close, and makes
 * the rest of the page inert — four things that are easy to get
 * wrong by hand and invisible when you do.
 */
const apiKeyField = document.getElementById(
  "api-key-input",
) as HTMLInputElement;
const apiKeySaveButton = document.getElementById(
  "api-key-save",
) as HTMLButtonElement;
const apiKeyClearButton = document.getElementById(
  "api-key-clear",
) as HTMLButtonElement;
const apiKeyBannerOpen = document.getElementById(
  "api-key-banner-open",
) as HTMLButtonElement;

const settingsDialog = document.getElementById(
  "settings-dialog",
) as HTMLDialogElement;
const settingsDialogClose = document.getElementById(
  "settings-dialog-close",
) as HTMLButtonElement;

/** Opens the dialog, optionally on a particular tab. */
function openSettings(tab?: "tab-tools" | "tab-settings"): void {
  if (!settingsDialog.open) settingsDialog.showModal();
  if (tab) showTab(tab);
}

/**
 * Opens settings with the API key field in view and focused.
 *
 * The banner's whole job is to lead to this one control, and the
 * control is now the last thing in the panel rather than the first.
 * Opening the dialog at the top and leaving the reader to scroll
 * would make the banner's button a hint rather than an action.
 *
 * Focus is what actually matters here; the scroll is what makes the
 * focus visible. focus() alone scrolls the field into view in every
 * current browser, but it aligns it to the nearest edge, which puts
 * it hard against the bottom of the dialog. scrollIntoView first,
 * centred, then focus with preventScroll so it does not immediately
 * undo that.
 */
function openApiKeySetting(): void {
  openSettings("tab-settings");

  // After the dialog has laid out: a field inside a dialog that was
  // display:none a moment ago has no position to scroll to yet.
  requestAnimationFrame(() => {
    apiKeyField.scrollIntoView({ block: "center", behavior: "smooth" });
    apiKeyField.focus({ preventScroll: true });
  });
}

// --- A/B comparison ---------------------------------------------------------








/**
 * Runs the previous turn again with one role's model changed.
 *
 * The point is measurement rather than convenience. Switching a model
 * and asking a different question tells you nothing; switching one
 * variable and holding everything else — the question, the prompt, the
 * tools, the pattern, the other two roles — is what makes the
 * comparison mean anything.
 */
async function rerunWith(role: string, modelId: string): Promise<void> {
  if (!state.lastRun || !state.lastOutcome) return;

  // Held in a local, because handleStreamEvent's "done" branch
  // overwrites state.lastOutcome partway through the re-run.
  const original = state.lastOutcome;

  const roleName = roleInfo[role]?.name ?? role;
  const modelName = modelOptions.find((m) => m.id === modelId)?.name ?? modelId;

  const models = { ...state.lastRun.models, [role]: modelId };

  appendTurn("user", `[Re-run with ${roleName} = ${modelName}]`, {
    extractable: false,
  });

  // The original turn's groups are relabelled A, and this one is B, so
  // the panel says which run each group belongs to.
  labelPreviousTurn("A");
  startLogTurn("B");

  state.isRerunning = true;
  setBusy(true);
  showWaiting(`Re-running with ${roleName} = ${modelName}`);

  const started = Date.now();
  let text = "";
  let cost = 0;
  let requests = 0;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Everything from the original run except the one model being
      // varied. Holding the rest constant is what makes the comparison
      // mean anything.
      body: JSON.stringify({ ...state.lastRun, models }),
    });

    if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);

    await readEventStream(response, (event) => {
      // The log and tool cards behave exactly as in a normal turn, so
      // the re-run is as inspectable as the original.
      handleStreamEvent(event);

      if (event.type === "done") text = event.text;

      if (event.type === "log") {
        const detail = event.event.detail as
          | { total_cost?: number; requests?: number }
          | undefined;
        if (typeof detail?.total_cost === "number") cost = detail.total_cost;
        if (typeof detail?.requests === "number") requests = detail.requests;
      }
    });

    const outcome: RunOutcome = {
      models,
      roles: original.roles,
      variedRole: role,
      cost,
      requests,
      elapsedMs: Date.now() - started,
      text,
    };

    appendComparison(original, outcome);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    appendError(`Re-run failed: ${message}`);
  } finally {
    state.isRerunning = false;
    hideWaiting();
    setBusy(false);
  }
}

/**
 * Shows the two runs side by side.
 *
 * Cost, latency and request count, plus whether the answers actually
 * differ. That last column is the one that matters: a cheaper model
 * that produces the same answer is a saving, and a cheaper model that
 * produces a worse one is not — and only reading both tells you which.
 */
function appendComparison(before: RunOutcome, after: RunOutcome): void {
  const card = document.createElement("div");
  card.className = "comparison";

  const variedName = after.variedRole
    ? (roleInfo[after.variedRole]?.name ?? after.variedRole)
    : "model";

  const heading = document.createElement("div");
  heading.className = "comparison-heading";
  heading.textContent = `Same question, ${variedName} model changed`;
  card.appendChild(heading);

  // --- Which models each run used ----------------------------------------
  //
  // One row per role the pattern actually used, with both runs side by
  // side. Listing them as a comma-separated string made the two rows
  // hard to line up, and listing roles the pattern never touched made
  // the comparison describe work that did not happen.
  const models = document.createElement("table");
  models.className = "comparison-models";

  const modelHead = document.createElement("tr");
  for (const text of ["Role", "A", "B"]) {
    const th = document.createElement("th");
    th.textContent = text;
    modelHead.appendChild(th);
  }
  models.appendChild(modelHead);

  for (const role of before.roles) {
    const row = document.createElement("tr");
    const changed = before.models[role] !== after.models[role];
    if (changed) row.className = "is-varied";

    const name = document.createElement("td");
    name.textContent = roleInfo[role]?.name ?? role;

    const a = document.createElement("td");
    a.textContent = modelName(before.models[role]);

    const b = document.createElement("td");
    b.textContent = modelName(after.models[role]);

    row.append(name, a, b);
    models.appendChild(row);
  }

  card.appendChild(models);

  // --- What each run cost -------------------------------------------------
  const table = document.createElement("table");
  table.className = "comparison-table";

  const head = document.createElement("tr");
  for (const label of ["", "Cost", "Requests", "Time", "Reply"]) {
    const th = document.createElement("th");
    th.textContent = label;
    head.appendChild(th);
  }
  table.appendChild(head);

  for (const [tag, run] of [
    ["A", before],
    ["B", after],
  ] as Array<[string, RunOutcome]>) {
    const row = document.createElement("tr");

    const name = document.createElement("td");
    name.className = "comparison-tag";
    name.textContent = tag;

    const cost = document.createElement("td");
    cost.textContent =
      run.cost < 0.01 ? `$${run.cost.toFixed(4)}` : `$${run.cost.toFixed(2)}`;

    const requests = document.createElement("td");
    requests.textContent = String(run.requests);

    const time = document.createElement("td");
    time.textContent = `${(run.elapsedMs / 1000).toFixed(1)}s`;

    const length = document.createElement("td");
    length.textContent = `${run.text.length} chars`;

    row.append(name, cost, requests, time, length);
    table.appendChild(row);
  }

  card.appendChild(table);

  // --- What to make of it -------------------------------------------------
  const verdict = document.createElement("p");
  verdict.className = "comparison-verdict";

  const ratio =
    before.cost > 0 && after.cost > 0
      ? Math.max(before.cost, after.cost) / Math.min(before.cost, after.cost)
      : 0;

  const parts: string[] = [];

  if (ratio >= 1.1) {
    parts.push(
      `B is ${after.cost < before.cost ? "cheaper" : "more expensive"} ` +
        `than A by ${ratio.toFixed(1)}×.`,
    );
  } else {
    parts.push("Costs are within 10% of each other.");
  }

  parts.push(
    after.elapsedMs < before.elapsedMs
      ? `B was ${((before.elapsedMs - after.elapsedMs) / 1000).toFixed(1)}s faster.`
      : `B was ${((after.elapsedMs - before.elapsedMs) / 1000).toFixed(1)}s slower.`,
  );

  // A large difference in reply length usually means the cheaper run
  // answered less, not more efficiently — worth saying, because the
  // cost column alone reads as a straightforward win.
  const lengthRatio =
    before.text.length > 0 && after.text.length > 0
      ? after.text.length / before.text.length
      : 1;

  if (lengthRatio < 0.6) {
    parts.push(
      `B's answer is ${Math.round((1 - lengthRatio) * 100)}% shorter — ` +
        "check whether it actually answered the question.",
    );
  } else if (lengthRatio > 1.6) {
    parts.push(
      `B's answer is ${Math.round((lengthRatio - 1) * 100)}% longer, ` +
        "which is where the extra cost went.",
    );
  }

  parts.push(
    "Both answers are above. A cheaper run that answers worse is not a " +
      "saving.",
  );

  verdict.textContent = parts.join(" ");
  card.appendChild(verdict);

  transcript.appendChild(card);
  transcript.scrollTop = transcript.scrollHeight;
}

/** A model's display name, or its id if it is not one we offer. */
function modelName(id: string | undefined): string {
  if (!id) return "—";
  return modelOptions.find((m) => m.id === id)?.name ?? id;
}

/**
 * Offers a re-run with a different model for each role that is worth
 * varying on this turn.
 *
 * Only roles the pattern actually used are offered. Suggesting a
 * different judging model after a single-call run would produce a
 * comparison of two identical things.
 */
function appendRerunOffer(): void {
  if (!state.lastRun || !state.lastOutcome) return;

  // Held in a local so the narrowing survives into the handlers below.
  const run = state.lastRun;

  // Only roles the pattern used. Offering to vary the Judging model
  // after a single-call run would compare two identical things and
  // produce a confident table showing no difference.
  const pattern = patternOptions.find((p) => p.id === run.pattern);
  const inUse = pattern?.usesRoles ?? Object.keys(roleInfo);

  const card = document.createElement("div");
  card.className = "rerun-offer";

  const label = document.createElement("span");
  label.className = "rerun-label";
  label.textContent = "Re-run with";
  card.appendChild(label);

  // A role picker and a model picker, rather than a button per
  // combination. Three roles times three models is nine buttons, most
  // of them uninteresting — and picking for the user removes the one
  // decision the comparison is supposed to be teaching.
  const roleSelect = document.createElement("select");
  roleSelect.className = "rerun-select";
  for (const role of inUse) {
    const option = document.createElement("option");
    option.value = role;
    option.textContent = roleInfo[role]?.name ?? role;
    roleSelect.appendChild(option);
  }

  const equals = document.createElement("span");
  equals.className = "rerun-equals";
  equals.textContent = "=";

  const modelSelect = document.createElement("select");
  modelSelect.className = "rerun-select";

  /**
   * Fills the model picker, excluding whatever that role already uses.
   *
   * Comparing a model against itself produces a table of noise: two
   * runs differing only by the model's own variability, presented as
   * though the difference meant something.
   */
  const refreshModels = (): void => {
    const current = run.models[roleSelect.value];
    modelSelect.replaceChildren();

    for (const model of modelOptions) {
      if (model.id === current) continue;
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name;
      modelSelect.appendChild(option);
    }
  };

  refreshModels();
  roleSelect.addEventListener("change", refreshModels);

  const go = document.createElement("button");
  go.type = "button";
  go.className = "rerun-button";
  go.textContent = "Compare";
  go.addEventListener("click", () => {
    const role = roleSelect.value;
    const model = modelSelect.value;
    if (!role || !model) return;
    card.remove();
    void rerunWith(role, model);
  });

  // What is currently set, so the choice is made against something
  // rather than in the abstract.
  const currently = document.createElement("span");
  currently.className = "rerun-current";
  const describeCurrent = (): void => {
    currently.textContent = `(currently ${modelName(run.models[roleSelect.value])})`;
  };
  describeCurrent();
  roleSelect.addEventListener("change", describeCurrent);

  card.append(roleSelect, equals, modelSelect, go, currently);

  transcript.appendChild(card);
  transcript.scrollTop = transcript.scrollHeight;
}

// --- Resizing the log panel -------------------------------------------------

/**
 * How wide the log panel may get, as a percentage of the window.
 *
 * Both ends matter: too narrow and the JSON is unreadable, too wide and the
 * state.conversation it is explaining disappears.
 */
const LOG_MIN_PERCENT = 18;
const LOG_MAX_PERCENT = 70;

/** Where the chosen width is remembered between visits. */
const WIDTH_STORAGE_KEY = "chat-lab-log-width";

/**
 * Sets the log panel width, as a percentage of the window.
 *
 * Writing one custom property on <body> is enough: the grid template reads
 * var(--log-width), so the layout follows. A percentage rather than pixels
 * means the split survives the window being resized.
 */
function setLogWidth(percent: number): void {
  const clamped = Math.min(LOG_MAX_PERCENT, Math.max(LOG_MIN_PERCENT, percent));
  document.body.style.setProperty("--log-width", `${clamped}%`);
  resizer.setAttribute("aria-valuenow", String(Math.round(clamped)));

  // Remember it. localStorage can throw in a private window or with site
  // data blocked, and a failure here must not break the resize itself.
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, String(clamped));
  } catch {
    /* not important enough to surface */
  }
}

/** Restores the remembered width, if there is one and it is sane. */
function restoreLogWidth(): void {
  try {
    const saved = localStorage.getItem(WIDTH_STORAGE_KEY);
    if (saved === null) return;
    const percent = Number(saved);
    // Number("") is 0 and Number("abc") is NaN, so check before using it.
    if (Number.isFinite(percent) && percent > 0) setLogWidth(percent);
  } catch {
    /* storage unavailable — the CSS default applies */
  }
}

/**
 * Converts a pointer position into a log width and applies it.
 *
 * The log is on the right, so its width is the distance from the pointer to
 * the right edge of the window.
 */
function resizeToPointer(clientX: number): void {
  const fromRight = window.innerWidth - clientX;
  setLogWidth((fromRight / window.innerWidth) * 100);
}

/** Wires up dragging and keyboard resizing. */
function initResizer(): void {
  restoreLogWidth();

  resizer.addEventListener("pointerdown", (event: PointerEvent) => {
    event.preventDefault(); // do not start a text selection

    // Capturing the pointer means we keep receiving moves even when the
    // cursor leaves the handle — which it immediately does, because the
    // handle is nine pixels wide and the hand is not that steady.
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add("dragging");
    document.body.classList.add("resizing");
  });

  resizer.addEventListener("pointermove", (event: PointerEvent) => {
    // Only act while the pointer is captured, i.e. while dragging.
    if (!resizer.hasPointerCapture(event.pointerId)) return;
    resizeToPointer(event.clientX);
  });

  function endDrag(event: PointerEvent): void {
    if (resizer.hasPointerCapture(event.pointerId)) {
      resizer.releasePointerCapture(event.pointerId);
    }
    resizer.classList.remove("dragging");
    document.body.classList.remove("resizing");
  }

  resizer.addEventListener("pointerup", endDrag);
  resizer.addEventListener("pointercancel", endDrag);

  // Double-click resets to the default.
  resizer.addEventListener("dblclick", () => setLogWidth(28));

  // Keyboard: a separator should be operable without a mouse.
  resizer.addEventListener("keydown", (event: KeyboardEvent) => {
    const current = Number(resizer.getAttribute("aria-valuenow")) || 28;
    const step = event.shiftKey ? 10 : 2;

    switch (event.key) {
      case "ArrowLeft":
        setLogWidth(current + step); // left grows the log
        break;
      case "ArrowRight":
        setLogWidth(current - step);
        break;
      case "Home":
        setLogWidth(LOG_MIN_PERCENT);
        break;
      case "End":
        setLogWidth(LOG_MAX_PERCENT);
        break;
      default:
        return; // not ours: let the key do whatever it normally does
    }

    event.preventDefault();
  });
}

// --- Preset questions (step 64) ---------------------------------------------


const PRESETS: Preset[] = [
  {
    label: "Tool call",
    question: "What is 847293 multiplied by 61847?",
    watchFor:
      "One tool call, start to finish. Watch the log: Claude's reply " +
      "comes back with stop_reason tool_use rather than an answer, " +
      "our code runs the calculator, and the result goes back as a " +
      "second request. Two API calls for one question.",
    requires: { pattern: "tool-loop", tools: true },
  },
  {
    label: "Tool loop",
    question:
      "Save a note called deadline saying Friday, then list my notes " +
      "and tell me what is in them.",
    watchFor:
      "Two tools in sequence, where the second depends on the first. " +
      "The loop runs until stop_reason stops being tool_use — count " +
      "the iterations in the log.",
    requires: { pattern: "tool-loop", tools: true },
  },
  {
    label: "Caching",
    question:
      "Using the documentation available to you, explain what " +
      "cache_read_input_tokens means and when it is zero.",
    watchFor:
      "Ask it twice. The first send writes the tool definitions to " +
      "the cache, the second reads them back — compare cache_write " +
      "and cache_read in the two response rows (about 2,150 tokens " +
      "read on the second, on Haiku). Note the pattern: Single call " +
      "strips client tools from the request because it cannot run " +
      "them, so there is no prefix long enough to cache. Caching " +
      "needs the tools to actually be sent.",
    requires: { pattern: "tool-loop", tools: true, cacheMode: "full" },
  },
  {
    label: "Extract",
    question:
      "My tool_result gets a 400 saying tool_use_id does not match " +
      "any tool_use block. What ordering rule am I breaking?",
    watchFor:
      "Ask it, then click \"Extract structured data\" under your own " +
      "message. The extraction is a separate request whose reply is " +
      "constrained to a schema — look at output_config.format in the " +
      "request row, and at how the raw text is bare JSON.",
  },
  {
    label: "Effort",
    question:
      "I run a tool loop. Claude returns two tool_use blocks in one " +
      "turn, I execute both and send the results back, and " +
      "intermittently get a 400. Separately my cache hit rate fell to " +
      "zero when I added a sixth tool. Explain both and say whether " +
      "they share a cause.",
    watchFor:
      "Hard enough to be worth thinking about. Send it at effort low, " +
      "then again at xhigh, and compare the output token counts — " +
      "about 2.5x on Haiku, for an answer of roughly the same length.",
    requires: { effort: "low" },
  },
];

/** Builds the preset row. */
function initPresets(): void {
  for (const preset of PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preset-button";
    button.textContent = preset.label;
    button.title = preset.watchFor;

    button.addEventListener("click", () => usePreset(preset));
    presetsRow.appendChild(button);
  }
}

/**
 * Fills the composer with a preset, and sets what it needs.
 *
 * Deliberately does NOT send. Filling the box lets you read the
 * question, change the settings it suggested, and watch the log from
 * the start — all of which is the exercise.
 */
function usePreset(preset: Preset): void {
  input.value = preset.question;
  input.focus();

  const changed: string[] = [];

  if (preset.requires?.pattern && patternSelect.value !== preset.requires.pattern) {
    patternSelect.value = preset.requires.pattern;
    handlePatternChange();
    changed.push(`pattern → ${preset.requires.pattern}`);
  }

  if (preset.requires?.effort && effortSelect.value !== preset.requires.effort) {
    effortSelect.value = preset.requires.effort;
    handleEffortChange();
    changed.push(`effort → ${preset.requires.effort}`);
  }

  if (
    preset.requires?.cacheMode &&
    cacheModeSelect.value !== preset.requires.cacheMode
  ) {
    cacheModeSelect.value = preset.requires.cacheMode;
    handleCacheModeChange();
    changed.push(`caching → ${preset.requires.cacheMode}`);
  }

  if (preset.requires?.tools) {
    const off = toolInfos.filter((tool) => disabledTools.has(tool.name));
    if (off.length > 0) {
      setAllTools(true);
      changed.push(`enabled ${off.length} tool(s)`);
    }
  }

  appendLog({
    at: Date.now(),
    level: "info",
    label: `Example loaded: ${preset.label}`,
    because: preset.watchFor,
    actor: "user",
    detail:
      changed.length > 0
        ? { question: preset.question, settings_changed: changed }
        : { question: preset.question },
  });
}

// --- Session cost (step 66) -------------------------------------------------


// --- Clear and export (step 65) ---------------------------------------------

/**
 * Clears the transcript, the state.conversation, the log and the cost.
 *
 * All four together, because they describe one session. Clearing the
 * log but keeping the history would leave the panel disagreeing with
 * what the next request actually sends — which is the specific
 * confusion this app exists to prevent.
 */
function clearChat(): void {
  transcript.replaceChildren();
  state.conversation.length = 0;

  state.lastRun = null;
  state.lastOutcome = null;
  state.openTurn = null;
  state.openTurnRaw = "";

  // Nothing outside this pane is touched — not the activity log, not
  // the running cost, not even a log row saying this happened.
  //
  // An earlier version wrote "Conversation cleared" into the log,
  // which meant a button in the left pane modified the right one.
  // Each Clear now empties its own pane and stops there, which is
  // the only rule that makes two buttons with the same label
  // predictable.
}

// --- Sending ------------------------------------------------------------------

/**
 * Handles a submitted message.
 *
 * It POSTs to /api/chat and reads the event stream that comes back. The
 * server does not call Claude yet — it sends one hard-coded log event and
 * closes — so what this proves is the plumbing: the browser can open a
 * stream, parse structured events out of it, and act on them.
 *
 * Step 21 renders those events into the log panel. Step 23 makes the server
 * end real.
 */
async function handleSubmit(event: SubmitEvent): Promise<void> {
  // Without this the browser navigates away and reloads the page — the
  // default behaviour of a form, and rarely what a web app wants.
  event.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  // Show the user's own turn immediately, then clear the box. Waiting for the
  // server first would make the UI feel unresponsive.
  appendTurn("user", text);
  input.value = "";

  // Add it to the history before sending, so the request carries it.
  state.conversation.push({ role: "user", content: text });

  // Disable the controls while a request is in flight, so a second click
  // cannot start an overlapping request.
  setBusy(true);
  showWaiting("Sending to Claude");

  // Captured before sending, because `state.conversation` is mutated as the
  // reply arrives — by the time anyone clicks "re-run" it already holds
  // the answer, and replaying it would ask Claude to respond to itself.
  const snapshot: RunSnapshot = {
    // A copy, for the same reason.
    messages: state.conversation.map((m) => ({ ...m })),
    promptId: promptSelect.value,
    // Only the ticked tools. An unticked tool is not sent at all, so
    // the model is never told it exists.
    tools: enabledToolNames(),
    toolChoice: toolChoiceSelect.value,
    pattern: patternSelect.value,
    models: { ...modelAssignment },
    cacheMode: cacheModeSelect.value,
    thinkingDisplay: thinkingSelect.value,
    effort: effortSelect.value,
  };

  // A fresh turn, so its groups do not merge with the previous one's.
  startLogTurn();

  state.lastRun = snapshot;
  state.lastOutcome = null;
  state.runStartedAt = Date.now();
  state.turnCost = 0;
  state.turnRequests = 0;


  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The whole state.conversation, every time. Not just the new message —
      // see the note on `history` above for why.
      body: JSON.stringify(snapshot),
    });

    // fetch() only rejects on a network failure. A 404 or a 500 arrives as a
    // perfectly resolved promise with ok === false, so an HTTP error has to
    // be checked for explicitly — forgetting this is a very common bug.
    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }

    await readEventStream(response, handleStreamEvent);
  } catch (error: unknown) {
    // Anything that went wrong belongs on screen, not only in the console.
    // This catch is for failures reaching the server at all — the server's
    // own errors arrive as "error" stream events and are handled there.
    const message = error instanceof Error ? error.message : String(error);
    appendError(`Could not reach the server: ${message}`);

    // Take the user turn back out of the history.
    //
    // It was pushed before the request, and the request failed, so Claude
    // never answered it. Leaving it in would send two user messages in a
    // row on the next turn — which the API rejects, so one failure would
    // poison every request after it.
    if (state.conversation[state.conversation.length - 1]?.role === "user") {
      state.conversation.pop();
    }
  } finally {
    // `finally` matters: without it, an error would leave the UI disabled
    // for good and the only fix would be a page reload.
    //
    // Clearing state.openTurn belongs here too. If the stream died partway, the
    // turn it was filling must not stay open, or the next reply would be
    // appended onto the end of the broken one.
    state.openTurn = null;
    state.openTurnRaw = "";
    hideWaiting();

    // Any card still open never got its tool_end — the stream died
    // first. Leaving them saying "running" forever would misreport
    // what happened.
    for (const [id, card] of openToolCards) {
      card.classList.remove("is-running");
      card.classList.add("is-error");
      const status = card.querySelector(".tool-card-status");
      if (status) status.textContent = "interrupted";
      openToolCards.delete(id);
    }

    setBusy(false);
  }
}

/**
 * Decides what to do with each event arriving from the server.
 *
 * The switch is exhaustive over StreamEvent. Because that type is a
 * discriminated union, adding a variant to it and forgetting to handle it
 * here is a compile error rather than a silent no-op at runtime.
 *
 * For now every branch goes to the console. Step 21 sends log events to the
 * panel, and step 24 renders deltas into the transcript as they arrive.
 */
function handleStreamEvent(event: StreamEvent): void {
  switch (event.type) {
    case "log":
      appendLog(event.event);

      // The pattern's closing summary carries what the turn cost and
      // how many requests it took. Captured here so a re-run has
      // something to compare against.
      {
        const detail = event.event.detail as
          | { total_cost?: number; requests?: number }
          | undefined;
        if (typeof detail?.total_cost === "number") state.turnCost = detail.total_cost;
        if (typeof detail?.requests === "number") state.turnRequests = detail.requests;
      }

      // Some rows say something more useful about what is being awaited.
      updateWaitingFromLog(event.event);
      break;

    case "thinking":
      // The reasoning summary, above the answer.
      //
      // Its own block rather than part of the reply: this is not what
      // Claude said, it is a summary of how it got there, and running
      // the two together would misrepresent both.
      {
        hideWaiting();
        const wasAtBottom = isTranscriptAtBottom();
        appendThinkingBlock(event.text);
        if (wasAtBottom) scrollTranscriptToBottom();
      }
      break;

    case "delta":
      // A fragment of the reply. The first one creates the assistant turn;
      // the rest append to it, so the text grows in place.
      //
      // While streaming, the text is shown raw rather than rendered as
      // Markdown. Two reasons: re-parsing the whole reply on every
      // fragment would get slower as it grew, and half-arrived syntax
      // flickers — "**bold" is not bold until its closing stars land, so
      // the text would visibly re-style itself as it typed. The rendered
      // version replaces it once "done" arrives.
      {
        // The answer has started, so the wait is over.
        hideWaiting();

        // Checked before the text grows the element, for the same reason
        // as in appendLog.
        const wasAtBottom = isTranscriptAtBottom();

        if (!state.openTurn) {
          state.openTurn = appendTurn("assistant", "");
          state.openTurnRaw = "";
        }
        state.openTurnRaw += event.text;
        state.openTurn.textContent = state.openTurnRaw;

        if (wasAtBottom) scrollTranscriptToBottom();
      }
      break;

    case "extracted":
      // Handled by runExtraction, which owns the message the extraction
      // describes. Reaching here means an extraction event arrived on
      // the chat stream, which nothing sends — ignored rather than
      // rendered without its source message.
      break;

    case "tool_start":
      // The tool card is itself a progress indicator, and a waiting row
      // beside it would say the same thing twice.
      hideWaiting();
      appendToolCard(event.id, event.name, event.input, event.iteration);
      break;

    case "tool_end":
      completeToolCard(event.id, event.result, event.isError, event.elapsedMs);
      // Back to waiting: the result now goes to Claude, and there is
      // another silent gap before the next response arrives.
      showWaiting("Sending the tool result back to Claude");
      break;

    case "done":
      // The reply is complete.
      //
      // If deltas arrived, the turn already holds the full text and there is
      // nothing to add — closing it is all that is needed. If none arrived
      // (an empty reply, or a pattern that does not stream), render the text
      // here so the turn is not left blank.
      // Now the text is complete, render it as Markdown. This is the only
      // point at which the syntax is known to be whole.
      {
        // Held in a local: state.openTurn is cleared below, and the footer
        // needs to know which element it belongs under.
        let finished: HTMLElement | null = null;

        if (state.openTurn) {
          renderInto(state.openTurn, event.text || state.openTurnRaw);
          finished = state.openTurn;
        } else if (event.text) {
          finished = appendTurn("assistant", "");
          renderInto(finished, event.text);
        }

        // Only under a real reply. A failed turn has no answer to
        // price, and a footer under nothing would read as though the
        // empty space had cost money.
        if (finished) {
          // Guarded, because the footer is decoration and the reply
          // is not. A throw in here used to abort the rest of this
          // handler — which is where the reply gets recorded into the
          // state.conversation and the re-run offer gets built.
          try {
            appendTurnFooter(
              finished,
              event.models,
              event.cost,
              event.elapsedMs,
              event.requests,
            );
          } catch (error: unknown) {
            console.warn("Could not add the message footer:", error);
          }
        }
      }

      state.openTurn = null;
      state.openTurnRaw = "";

      // Record what Claude said, so the next turn can refer back to it.
      //
      // The server sends the complete text on this event rather than us
      // reassembling it from the deltas we happened to receive. If the
      // stream dropped a fragment, rebuilding from deltas would put a
      // subtly wrong version of the reply into the history — and every
      // later turn would be arguing with a transcript Claude never wrote.
      //
      // An empty reply is not recorded: the API rejects a message with
      // empty content, so storing one would break the next request.
      if (event.text) {
        state.conversation.push({ role: "assistant", content: event.text });
      }

      // Record what this run cost, then offer to run it again with one
      // model changed. Only after a successful turn: comparing against
      // a failure measures nothing.
      if (state.lastRun && event.text) {
        // Held in a local so the narrowing survives the closure below.
        const run = state.lastRun;

        // Only the roles this pattern used. Listing all three would
        // show a Judging model for a single call that has no
        // evaluator — which is how the comparison came to describe a
        // role that played no part in the run.
        const pattern = patternOptions.find((p) => p.id === run.pattern);
        const roles = pattern?.usesRoles ?? Object.keys(roleInfo);

        state.lastOutcome = {
          models: run.models,
          roles,
          variedRole: null,
          cost: state.turnCost,
          requests: state.turnRequests,
          elapsedMs: Date.now() - state.runStartedAt,
          text: event.text,
        };

        if (!state.isRerunning) appendRerunOffer();
      }
      break;

    case "error":
      // The server reporting a failure in a way it considers safe to show.
      // It goes in both places on purpose: the transcript, because the
      // person is waiting on an answer and needs to know none is coming;
      // and the log, because the panel is meant to be a complete record of
      // what happened.
      //
      // The server has already logged the technical detail, so this is only
      // the human-facing half.
      appendError(event.message);

      // A half-streamed reply must not be left open — see the note in the
      // submit handler's finally block.
      state.openTurn = null;
      state.openTurnRaw = "";
      break;
  }
}

/**
 * Enables or disables the composer while a request is running.
 */
function setBusy(busy: boolean): void {
  sendButton.disabled = busy;
  input.disabled = busy;

  // The button holds two spans — the label and the "Enter" hint — so
  // setting textContent would destroy the hint. Replace only the label.
  const label = sendButton.firstElementChild;
  if (label) label.textContent = busy ? "Sending…" : "Send";

  if (!busy) input.focus();
}

// --- Waiting indicator ------------------------------------------------------

/**
 * The "waiting" row currently in the transcript, if any.
 *
 * There is a real gap between pressing Send and the first token
 * arriving — about two seconds for a single call, and eight or more
 * for the orchestrator, which plans before it says anything. Without
 * something on screen, that gap is indistinguishable from a broken
 * app, and the button's label is not where anyone is looking.
 */
let waitingRow: HTMLElement | null = null;

/** When the current wait started, for the elapsed counter. */
let waitingSince = 0;

/** The interval updating that counter. */
let waitingTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Shows a waiting indicator in the transcript.
 *
 * The text says what is being waited on rather than just "thinking",
 * because in this app that is the interesting part: a pattern making
 * four requests should say which one it is on. The server updates it
 * through the log stream as the work progresses.
 */
function showWaiting(message: string): void {
  if (!waitingRow) {
    waitingRow = document.createElement("div");
    waitingRow.className = "waiting";

    const dots = document.createElement("span");
    dots.className = "waiting-dots";
    // Three spans rather than an animated ellipsis character, so each
    // can be staggered independently.
    for (let i = 0; i < 3; i += 1) {
      dots.appendChild(document.createElement("span"));
    }

    const text = document.createElement("span");
    text.className = "waiting-text";

    const elapsed = document.createElement("span");
    elapsed.className = "waiting-elapsed";

    waitingRow.append(dots, text, elapsed);
    transcript.appendChild(waitingRow);

    waitingSince = Date.now();

    // Only after two seconds. A fast reply should not flash a timer on
    // screen and remove it again — that reads as a glitch rather than
    // as information.
    waitingTimer = setInterval(() => {
      if (!waitingRow) return;
      const seconds = Math.floor((Date.now() - waitingSince) / 1000);
      const field = waitingRow.querySelector(".waiting-elapsed");
      if (field) field.textContent = seconds >= 2 ? `${seconds}s` : "";
    }, 250);
  }

  const text = waitingRow.querySelector(".waiting-text");
  if (text) text.textContent = message;

  transcript.scrollTop = transcript.scrollHeight;
}

/**
 * Updates the waiting message from a log row, where one says something
 * more useful than "sending".
 *
 * The patterns already log what they are doing; this reuses that
 * rather than adding a parallel set of progress messages that could
 * drift from it. Only outbound rows qualify — those are the moments
 * where a wait begins.
 */
function updateWaitingFromLog(event: LogEvent): void {
  if (!waitingRow) return;
  if (event.direction !== "out") return;

  // Log labels carry measurements the waiting line does not want.
  const label = event.label.split("\u00b7")[0]?.trim() ?? event.label;

  showWaiting(
    event.iteration && event.iteration > 1
      ? `${label} (request ${event.iteration})`
      : label,
  );
}



/** Removes the waiting indicator. */
function hideWaiting(): void {
  if (waitingTimer !== null) {
    clearInterval(waitingTimer);
    waitingTimer = null;
  }
  waitingRow?.remove();
  waitingRow = null;
}

// --- Startup ----------------------------------------------------------------

assertElements();

// Listening for the form's submit event, rather than the button's click,
// catches both ways of sending: clicking Send, and pressing Enter in the
// textarea. One handler, both paths.
form.addEventListener("submit", handleSubmit);

/**
 * Enter sends; Shift+Enter inserts a newline.
 *
 * A <textarea> does not submit its form on Enter the way a single-line
 * input does — it inserts a newline, which is the right default for a
 * text box and the wrong one for a chat composer. So the key is handled
 * explicitly.
 *
 * Shift+Enter is left alone deliberately. Multi-line input matters here:
 * pasting a code sample or a JSON payload into the box is a normal thing
 * to do in this app, and a composer that cannot hold more than one line
 * would be worse than one that needs a modifier.
 *
 * Two guards worth noting. `isComposing` is true while an input method
 * editor is mid-composition — typing Japanese or Chinese, Enter confirms
 * a candidate rather than meaning "send", and intercepting it would make
 * the app unusable in those languages. And a repeat event means the key
 * is being held down, which should not fire a second request.
 */
input.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key !== "Enter") return;
  if (event.shiftKey || event.isComposing || event.repeat) return;

  event.preventDefault();

  // requestSubmit rather than calling the handler directly: it runs the
  // browser's own validation first, so the `required` attribute still
  // does its job on an empty box.
  form.requestSubmit();
});

initResizer();
initTabs();

state.hiddenLevels = loadHiddenLevels();
renderLogFilters();

patternSelect.addEventListener("change", handlePatternChange);
promptSelect.addEventListener("change", handlePromptChange);
toolChoiceSelect.addEventListener("change", handleToolChoiceChange);
cacheModeSelect.addEventListener("change", handleCacheModeChange);
thinkingSelect.addEventListener("change", handleThinkingChange);
effortSelect.addEventListener("change", handleEffortChange);

toolSummary.addEventListener("click", () => openSettings("tab-tools"));
settingsSummary.addEventListener("click", () => openSettings("tab-settings"));
settingsDialogClose.addEventListener("click", () => settingsDialog.close());

// Clicking the backdrop closes it.
//
// The test is event.target, NOT the pointer position. A modal
// dialog's backdrop is painted by the dialog element itself, so a
// click on the backdrop has the dialog as its target while a click
// on anything inside has that child as its target.
//
// Comparing coordinates against getBoundingClientRect() looks
// equivalent and is not: the click that OPENS the dialog keeps
// propagating, reaches this handler in the same gesture, and lands
// outside a box that has only just been laid out — so the dialog
// opened and closed itself in one click, which is exactly the bug
// this comment now exists to prevent returning.
settingsDialog.addEventListener("click", (event) => {
  if (event.target === settingsDialog) settingsDialog.close();
});
// --- API key controls -------------------------------------------------------
//
// Save on click, and on Enter in the field: a single-line credential input
// that ignores Enter feels broken. The input is not inside a <form>, so the
// keydown has to be handled explicitly.
apiKeySaveButton.addEventListener("click", () => void saveApiKey());
apiKeyField.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void saveApiKey();
  }
});
apiKeyClearButton.addEventListener("click", () => void clearApiKey());

// Says "not saved yet" while the field holds a key the server has not
// been sent. Without it the status line below the input goes on
// describing the server's key while a different one sits in the box.
watchApiKeyInput();

// The banner's only job is to lead to the setting that dismisses it.
apiKeyBannerOpen.addEventListener("click", openApiKeySetting);

logClearButton.addEventListener("click", clearLog);
sessionClearButton.addEventListener("click", clearChat);
toolsAllButton.addEventListener("click", () => setAllTools(true));
toolsNoneButton.addEventListener("click", () => setAllTools(false));

// First, because its answer decides whether the setup banner is shown —
// and on a machine with no key, that banner is the only thing on screen
// that leads anywhere useful.
void initApiKey();

// Fire and forget: the selector fills in when the response arrives, and
// chat works meanwhile because the server defaults the prompt itself.
void initModels();
void initPatterns();
void initPrompts();
void initTools();

// --- The MCP panel -------------------------------------------------------
//
// Wired here rather than inside mcp-panel.ts, so that every listener
// in the app is attached in one place. The panel exports behaviour;
// this file decides what triggers it — the same split every other
// control in the dialog follows.
document
  .getElementById("mcp-transport")
  ?.addEventListener("change", handleMcpTransportChange);

document
  .getElementById("mcp-connect")
  ?.addEventListener("click", () => void connectMcp());

document
  .getElementById("mcp-disconnect")
  ?.addEventListener("click", () => void disconnectMcp());

// Asks the server what it is connected to, if anything. Without this
// a page reload shows "Not connected" over a live connection, because
// the connection lives in the server and the browser has just
// forgotten everything it knew.
void refreshMcpStatus();
void initToolChoices();
void initCacheModes();
void initThinking();
void initEffort();
initPresets();
refreshSessionCost();


console.log("frontend loaded");
