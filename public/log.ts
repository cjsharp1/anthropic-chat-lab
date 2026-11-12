/**
 * log.ts — the activity panel: rows, groups, filters and totals.
 *
 * The panel is the point of this app. Every request that leaves the
 * machine and every response that comes back is a row here, with the
 * real payload behind an expander and a sentence saying why it
 * happened.
 *
 * This module owns everything inside that pane: building a row,
 * grouping rows under the request that caused them, the level
 * filters, and the running cost. Other modules call appendLog and
 * nothing else — which is why this file imports from none of them.
 */

import type { LogEvent, LogLevel, LogDirection } from "../shared/types.js";
import { state } from "./state.js";
import { buildJsonTree } from "./json-tree.js";

const logPanelTab = document.getElementById(
  "panel-log",
) as HTMLElement;
const logList = document.getElementById(
  "log-list",
) as HTMLOListElement;
const logCount = document.getElementById(
  "log-count",
) as HTMLElement;
const logCostLabel = document.getElementById(
  "log-cost",
) as HTMLElement;
const logFilters = document.getElementById(
  "log-filters",
) as HTMLElement;
const sessionCostValue = document.getElementById(
  "session-cost-value",
) as HTMLElement;

// --- The log panel ----------------------------------------------------------

/**
 * The glyph shown for each direction.
 *
 * Chosen so the two outbound kinds point the same way and the two
 * inbound kinds point back: a scan down the column shows the shape of
 * the exchange without reading anything.
 */
const DIRECTION_MARKS: Record<LogDirection, string> = {
  out: "→",
  in: "←",
  call: "⤷",
  back: "⤶",
  none: "·",
};

/** What each glyph means, as a tooltip. */
const DIRECTION_TITLES: Record<LogDirection, string> = {
  out: "Request sent to Anthropic",
  in: "Response received from Anthropic",
  call: "Function call — this server running a tool",
  back: "Tool returned a value to this server",
  none: "Internal — nothing crossed a boundary",
};

/**
 * The <ol> that rows for a given iteration go into.
 *
 * Rows with no iteration — setup, and the closing summary — go straight
 * into the list, outside any group. They belong to the turn as a whole
 * rather than to one request.
 */
function containerFor(iteration: number | undefined): HTMLElement {
  if (iteration === undefined) return logList;

  // Keyed on the turn as well as the iteration. Without the turn, a
  // comparison run's "iteration 1" matches the original run's group
  // and its rows are appended there — producing a single group whose
  // timestamps run backwards.
  const key = `${state.logTurn}:${iteration}`;

  const existing = logList.querySelector<HTMLElement>(
    `[data-group="${key}"] .log-group-rows`,
  );
  if (existing) return existing;

  const group = document.createElement("li");
  group.className = "log-group";
  group.dataset["group"] = key;
  if (state.logTurnLabel) group.dataset["run"] = state.logTurnLabel;

  const header = document.createElement("div");
  header.className = "log-group-header";

  // The turn is what distinguishes one group from another. The
  // iteration restarts at 1 every turn, so a header saying only
  // "Request 1" repeated down the panel and told a reader nothing
  // about where they were.
  //
  // The iteration is still shown, but only when a turn makes more
  // than one call — which is the case where it carries information.
  // A single-call turn gets "Message 3" rather than the more
  // precise and less useful "Message 3, request 1 of 1".
  const turnPart = state.logTurnLabel
    ? `Run ${state.logTurnLabel}`
    : `Message ${state.logTurn}`;

  header.textContent = turnPart;
  header.dataset["iteration"] = String(iteration);

  // Filled in by the time the group has more than one request — see
  // refreshGroupHeaders below.
  const iterationPart = document.createElement("span");
  iterationPart.className = "log-group-iteration";
  iterationPart.textContent = iteration > 1 ? `request ${iteration}` : "";
  header.appendChild(iterationPart);

  const rows = document.createElement("ol");
  rows.className = "log-group-rows";

  group.append(header, rows);
  logList.appendChild(group);

  // A turn's first group says only "Message 3" until a second request
  // arrives — at which point "request 1" becomes meaningful and is
  // added retrospectively.
  if (iteration > 1) labelEarlierRequests();

  return rows;
}



/**
 * Starts a new turn's grouping.
 *
 * Called when a request is sent, not when the first row arrives:
 * rows that precede the first API call — the tool list, the system
 * prompt — belong to the turn that is starting.
 */
export function startLogTurn(label = ""): void {
  state.logTurn += 1;
  state.logTurnLabel = label;
}


/**
 * Formats a timestamp as HH:MM:SS.
 *
 * Wall-clock time rather than elapsed, because a learner comparing two
 * patterns wants to see that one took four seconds and the other took
 * twenty. Milliseconds are dropped: they add noise without adding insight
 * at the granularity of an API call.
 */
function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * Adds one event to the activity log.
 *
 * A row is three parts: the time, a level tag, and the label. The tag is
 * both coloured and spelled out in text — colour alone would exclude anyone
 * who is colourblind, and would vanish entirely on a washed-out projector.
 *
 * Everything is built with createElement and textContent rather than an
 * HTML string. Log labels can contain anything a tool returned or an error
 * message said, and pushing that through innerHTML would turn whatever
 * looks like markup into real markup.
 */
export function appendLog(event: LogEvent): void {
  // Measured before anything is added. Afterwards the new row has already
  // changed scrollHeight, so the answer would be about the panel as it
  // now is rather than as the reader left it.
  const wasAtBottom = isLogAtBottom();

  // Clear the "nothing yet" placeholder the first time a real event lands.
  const placeholder = logList.querySelector(".log-empty");
  if (placeholder) placeholder.remove();

  const row = document.createElement("li");
  row.className = `log-row log-${event.level}`;

  // The row that closes a turn gets a rule above it, breaking a long log
  // into visible turns.
  if (event.label.startsWith("Finished after") || event.label.startsWith("Stopped after")) {
    row.classList.add("is-summary");
  }

  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = formatTime(event.at);

  // The direction marker. This is the primary signal in the panel: it
  // answers "is this going out, coming back, or neither" before any
  // word is read, which is what makes a state.conversation legible.
  const direction = event.direction ?? "none";
  row.classList.add(`dir-${direction}`);

  const arrow = document.createElement("span");
  arrow.className = "log-arrow";
  arrow.textContent = DIRECTION_MARKS[direction];
  arrow.title = DIRECTION_TITLES[direction];

  const label = document.createElement("span");
  label.className = "log-label";
  label.textContent = event.label;

  // The headline: what happened, with the time pushed to the right
  // margin. The time used to lead every row, which gave the most
  // prominent position in the panel to the least-read value.
  const headline = document.createElement("div");
  headline.className = "log-headline";
  headline.append(label, time);

  // The meta line: what kind of event, who caused it, and why.
  //
  // These three belong together — "an API call, made by our code,
  // because the user sent a message" is one sentence. Previously the
  // level sat in its own column at the far left, separated from the
  // actor and the reason by the whole width of the label.
  const meta = document.createElement("div");
  meta.className = "log-because";

  const level = document.createElement("span");
  level.className = "log-level";
  level.textContent = event.level;
  meta.appendChild(level);

  // Why this happened. The panel's job is not only to show what crossed
  // the wire but to explain what put it there — a row saying "calling
  // calculator" is half an answer without "because Claude's response
  // asked for it".
  if (event.because) {
    const who = document.createElement("span");
    who.className = `log-actor actor-${event.actor ?? "app"}`;
    who.textContent = event.actor ?? "app";

    const why = document.createElement("span");
    why.className = "log-why";
    why.textContent = event.because;

    meta.append(who, why);
  }

  row.append(arrow, headline, meta);

  // Events that carry data get an expander underneath the label. Most do
  // not, and those rows stay a single line.
  if (event.detail !== undefined) {
    row.appendChild(buildDetail(event.detail));
    row.classList.add("has-detail");
  }

  // The closing summary carries the turn's total cost. Accumulating it
  // here rather than on each API row avoids double-counting, since the
  // per-request rows and the summary both report money.
  const detail = event.detail;
  if (
    detail !== null &&
    typeof detail === "object" &&
    "total_cost" in detail &&
    typeof (detail as { total_cost: unknown }).total_cost === "number"
  ) {
    state.sessionCost += (detail as { total_cost: number }).total_cost;
    refreshLogCost();
  }

  // The caching summary carries what this turn saved. Read from the
  // formatted string because that is what the server sends; adding a
  // raw number alongside it would mean two sources of truth for one
  // figure, and they would eventually disagree.
  const cacheDetail = event.detail as { saved?: string } | undefined;
  if (typeof cacheDetail?.saved === "string") {
    const amount = Number(cacheDetail.saved.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(amount) && amount > 0) {
      state.sessionCacheSaved += amount;
      refreshLogCost();
    }
  }

  // Group rows under the request they belong to. One turn can produce
  // fifteen rows across three requests, and a flat list makes it very
  // hard to see which belong together — or that the exchange is three
  // round trips rather than one.
  const container = containerFor(event.iteration);
  container.appendChild(row);

  // A group hides itself when every row in it is filtered out. A new
  // visible row has to bring it back, or rows arrive into a container
  // nobody can see.
  const group = container.closest<HTMLElement>(".log-group");
  if (group && !row.hidden) group.hidden = false;

  // Keep the count in the header honest.
  state.logEventCount += 1;
  levelCounts[event.level] += 1;


  // A new row obeys the current filters immediately, rather than
  // appearing and then vanishing on the next redraw.
  if (state.hiddenLevels.has(event.level)) row.hidden = true;

  // Only the counts change here. Rebuilding the whole checkbox row on
  // every log event — which an earlier version did — destroys the
  // element whose change event is still being handled, so toggling a
  // filter during a live run did nothing at all.
  refreshFilterCounts();
  // Just the number: the badge sits beside the word "Activity log",
  // which already says what is being counted.
  logCount.textContent = String(state.logEventCount);

  // Follow the newest row, but only if the reader was already at the
  // bottom. Scrolling someone back down while they are reading an earlier
  // row is one of the most irritating things a live log can do.
  if (wasAtBottom) scrollLogToBottom();
}

/**
 * Turns an event's detail into a collapsed expander.
 *
 * The panel has to stay scannable. An orchestration pattern can produce
 * twenty events in one turn, and if each dumped its full request body the
 * sequence — which is the thing worth watching — would be buried. So the
 * label is always visible and the data is always one click away.
 *
 * <details> is used rather than a click handler and a CSS class, because
 * the browser already implements exactly this: keyboard operable, correctly
 * announced by screen readers, and open/closed state for free.
 */
function buildDetail(detail: unknown): HTMLDetailsElement {
  const wrapper = document.createElement("details");
  wrapper.className = "log-detail";

  // Expanding a row makes it taller, which can push the revealed JSON
  // below the fold — the content moves away in response to the click
  // that was meant to show it. Nudging the row into view fixes that.
  //
  // scrollIntoView with block:"nearest" only scrolls when the element is
  // actually outside the viewport, so expanding a row that already fits
  // does nothing. Scrolling unconditionally would be worse than the
  // original problem.
  wrapper.addEventListener("toggle", () => {
    if (wrapper.open) {
      wrapper.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });

  const summary = document.createElement("summary");
  summary.textContent = describeDetail(detail);

  // The size, so you know whether you are opening three lines or three
  // hundred. Request bodies carrying the full tool definitions are
  // routinely several kilobytes, and that is worth knowing before the
  // row expands and pushes everything else off screen.
  const size = detailSize(detail);
  if (size) {
    const badge = document.createElement("span");
    badge.className = "detail-size";
    badge.textContent = size;
    summary.appendChild(badge);
  }

  wrapper.appendChild(summary);

  // A tree rather than a wall of JSON.stringify.
  //
  // A request body runs to a few kilobytes once tool definitions are
  // in it, and the field anyone is looking for — output_config,
  // cache_control, one tool's schema — is three lines inside it. The
  // tree opens the top two levels and folds the rest, so the shape is
  // visible without the bulk.
  //
  // Primitives are not worth a tree: a number or a string renders as
  // itself.
  if (typeof detail === "object" && detail !== null) {
    wrapper.appendChild(buildJsonTree(detail));
  } else {
    const pre = document.createElement("pre");
    pre.textContent = formatDetail(detail);
    wrapper.appendChild(pre);
  }

  return wrapper;
}

/**
 * How big the detail is, as a short label, or null if it is small.
 *
 * Only shown past a threshold: putting "84 B" on every row would be
 * noise. The point is to warn before opening something large.
 */
function detailSize(detail: unknown): string | null {
  let characters: number;
  try {
    characters = JSON.stringify(detail)?.length ?? 0;
  } catch {
    return null; // circular or otherwise unserialisable
  }

  if (characters < 400) return null;
  if (characters < 10_000) return `${Math.round(characters / 100) / 10} kB`;
  return `${Math.round(characters / 1000)} kB`;
}

/**
 * A one-line hint at what is inside, shown on the closed expander.
 *
 * "3 keys" or "5 items" tells a learner whether expanding is worth it.
 * A bare "details" label would make every row look identical.
 */
function describeDetail(detail: unknown): string {
  if (Array.isArray(detail)) {
    return `${detail.length} item${detail.length === 1 ? "" : "s"}`;
  }

  if (detail !== null && typeof detail === "object") {
    const keys = Object.keys(detail);
    if (keys.length === 0) return "empty object";

    // Name as many keys as fit in a reasonable line rather than a fixed
    // count. An earlier version stopped at three, which hid the `tools`
    // key on every request-body row behind "+1 more" — the one field a
    // learner most needs to find.
    const preview: string[] = [];
    let width = 0;

    for (const key of keys) {
      if (width + key.length > 46 && preview.length > 0) break;
      preview.push(key);
      width += key.length + 2;
    }

    const remaining = keys.length - preview.length;
    return remaining === 0
      ? preview.join(", ")
      : `${preview.join(", ")}, +${remaining} more`;
  }

  // A primitive: show it directly if short, otherwise say what it is.
  const text = String(detail);
  return text.length <= 48 ? text : `${typeof detail}, ${text.length} chars`;
}

/**
 * Pretty-prints the detail for the expanded view.
 *
 * JSON.stringify is not total: it returns undefined for a function or a bare
 * undefined, and throws outright on a circular structure or a BigInt. Any of
 * those would otherwise render as the word "undefined" or take down the
 * whole log row, so each case is handled.
 */
function formatDetail(detail: unknown): string {
  try {
    const json = JSON.stringify(detail, null, 2);
    // undefined means stringify had nothing it could represent.
    return json ?? String(detail);
  } catch {
    // Circular reference, BigInt, or similar.
    return String(detail);
  }
}

/**
 * Scrolls the log to the newest row, unless the reader has scrolled up.
 *
 * The 40px tolerance covers the case where the panel is a pixel or two off
 * the bottom after a row is added.
 */
export function isLogAtBottom(): boolean {
  const distanceFromBottom =
    logPanelTab.scrollHeight - logPanelTab.scrollTop - logPanelTab.clientHeight;
  // A few pixels of tolerance: fractional scroll positions and sub-pixel
  // row heights mean "at the bottom" is rarely exactly zero.
  return distanceFromBottom < 8;
}

/**
 * Scrolls the log to the newest row.
 *
 * Call this only when isLogAtBottom() was true BEFORE the new row was
 * added. Measuring afterwards is what the earlier version did, and it was
 * wrong in both directions: a tall row pushes the distance past any fixed
 * threshold, so following stops working exactly when a detailed event
 * arrives; and a generous threshold instead yanks a reader back down when
 * they had deliberately scrolled up.
 */
function scrollLogToBottom(): void {
  logPanelTab.scrollTop = logPanelTab.scrollHeight;
}

// --- Log filters ------------------------------------------------------------



/** How many rows of each level have arrived, for the counts. */
const levelCounts: Record<LogLevel, number> = {
  info: 0,
  api: 0,
  tool: 0,
  warn: 0,
  error: 0,
};

const LEVEL_ORDER: LogLevel[] = ["api", "tool", "info", "warn", "error"];

const FILTER_STORAGE_KEY = "chat-lab-hidden-levels";

/** Reads the remembered filters. */
export function loadHiddenLevels(): Set<LogLevel> {
  try {
    const saved = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!saved) return new Set();
    const parsed: unknown = JSON.parse(saved);
    return Array.isArray(parsed)
      ? new Set(parsed as LogLevel[])
      : new Set();
  } catch {
    return new Set();
  }
}

/** Remembers them. */
function saveHiddenLevels(): void {
  try {
    localStorage.setItem(
      FILTER_STORAGE_KEY,
      JSON.stringify([...state.hiddenLevels]),
    );
  } catch {
    /* storage unavailable — the filters last for this session only */
  }
}

/**
 * Builds the checkbox row.
 *
 * Rebuilt rather than updated in place, because the counts change on
 * every row and keeping five labels in sync by hand is more code than
 * redrawing five checkboxes.
 */
export function renderLogFilters(): void {
  logFilters.replaceChildren();

  for (const level of LEVEL_ORDER) {
    const label = document.createElement("label");
    label.className = `log-filter log-filter-${level}`;

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !state.hiddenLevels.has(level);
    box.addEventListener("change", () => {
      if (box.checked) state.hiddenLevels.delete(level);
      else state.hiddenLevels.add(level);
      saveHiddenLevels();
      applyLogFilters();

      // The label's dimming is driven by :has(input:not(:checked)) in
      // CSS, so there is nothing to redraw — and redrawing would
      // destroy this very checkbox mid-event.
    });

    const name = document.createElement("span");
    name.className = "log-filter-name";
    name.textContent = level;

    const count = document.createElement("span");
    count.className = "log-filter-count";
    count.textContent = String(levelCounts[level]);

    label.append(box, name, count);
    logFilters.appendChild(label);
  }
}

/**
 * Updates just the numbers beside each checkbox.
 *
 * Separate from renderLogFilters because it runs on every log row,
 * and rebuilding five checkboxes several times a second is both
 * wasteful and — more importantly — destructive: it replaces the
 * element the browser is currently dispatching a change event on.
 */
function refreshFilterCounts(): void {
  for (const level of LEVEL_ORDER) {
    const count = logFilters.querySelector<HTMLElement>(
      `.log-filter-${level} .log-filter-count`,
    );
    if (count) count.textContent = String(levelCounts[level]);
  }
}

/**
 * Shows or hides rows to match the filters.
 *
 * Hiding rather than removing, so unchecking and rechecking a level
 * brings its rows back rather than losing them. A log you can
 * accidentally destroy by clicking a filter would be worse than no
 * filters at all.
 *
 * A group whose rows are all hidden is hidden too — an empty "Message
 * 3" header with nothing under it is just noise.
 */
function applyLogFilters(): void {
  const rows = logList.querySelectorAll<HTMLElement>(".log-row");

  for (const row of rows) {
    const level = LEVEL_ORDER.find((l) => row.classList.contains(`log-${l}`));
    row.hidden = level ? state.hiddenLevels.has(level) : false;
  }

  for (const group of logList.querySelectorAll<HTMLElement>(".log-group")) {
    const visible = group.querySelectorAll<HTMLElement>(
      ".log-row:not([hidden])",
    ).length;
    group.hidden = visible === 0;
  }
}

/** Empties the panel and resets the counter. Wired to the log's Clear. */
export function clearLog(): void {
  // replaceChildren clears the request groups too, since they are
  // children of this list rather than siblings of the rows.
  logList.replaceChildren();
  state.logEventCount = 0;
  logCount.textContent = "0";
  // The counter must reset too, or the next turn's group keys collide
  // with elements that have just been removed.
  state.logTurn = 0;
  state.logTurnLabel = "";
  for (const level of LEVEL_ORDER) levelCounts[level] = 0;
  renderLogFilters();
  state.sessionCost = 0;
  state.sessionCacheSaved = 0;
  refreshLogCost();

  const empty = document.createElement("li");
  empty.className = "log-empty";
  empty.textContent = "Nothing yet. Send a message to see what happens.";
  logList.appendChild(empty);
}



/** Updates the running totals beside the Clear button. */
export function refreshLogCost(): void {
  if (state.sessionCost === 0) {
    logCostLabel.textContent = "";
    return;
  }

  // Four decimals below a dollar, matching formatCost on the server —
  // two would collapse the figures this panel exists to compare.
  const money = (n: number): string =>
    n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;

  logCostLabel.textContent =
    state.sessionCacheSaved > 0
      ? `${money(state.sessionCost)} · ${money(state.sessionCacheSaved)} saved`
      : money(state.sessionCost);

  // The header shows the same number. Updated here rather than at
  // every call site that touches state.sessionCost, so the two cannot drift.
  refreshSessionCost();
}
/**
 * Adds "request N" to this turn's earlier groups.
 *
 * Called when a second request appears. Until then the number is
 * noise — every turn would carry "request 1" whether or not there
 * was ever a request 2.
 */
export function labelEarlierRequests(): void {
  const groups = logList.querySelectorAll<HTMLElement>(
    `[data-group^="${state.logTurn}:"]`,
  );

  for (const group of groups) {
    const header = group.querySelector<HTMLElement>(".log-group-header");
    const span = group.querySelector<HTMLElement>(".log-group-iteration");
    if (!header || !span || span.textContent) continue;

    span.textContent = `request ${header.dataset["iteration"] ?? "1"}`;
  }
}

/**
 * Shows the running total in the header.
 *
 * The same figure the log panel carries, in a place you cannot miss.
 * It is an ESTIMATE: the rates are hard-coded in server/usage.ts and
 * published prices change, so this is for noticing that a pattern
 * costs four times what another does, not for reconciling a bill.
 */
export function refreshSessionCost(): void {
  sessionCostValue.textContent =
    state.sessionCost === 0
      ? "$0.00"
      : state.sessionCost < 1
        ? `$${state.sessionCost.toFixed(4)}`
        : `$${state.sessionCost.toFixed(2)}`;
}

/**
 * Relabels the groups of the turn just completed.
 *
 * The baseline run does not know it is a baseline until someone asks
 * for a comparison, so its headers say "Request 1" until the re-run
 * starts and retrospectively makes it run A.
 */
export function labelPreviousTurn(label: string): void {
  const groups = logList.querySelectorAll<HTMLElement>(
    `[data-group^="${state.logTurn}:"]`,
  );

  for (const group of groups) {
    if (group.dataset["run"]) continue; // already labelled
    group.dataset["run"] = label;

    // Replaces the turn name rather than prefixing it: "Run A" and
    // "Message 3" answer the same question, and "Run A · Message 3"
    // says it twice. Setting textContent on the header would also
    // destroy the iteration span, so only the first text node moves.
    const header = group.querySelector<HTMLElement>(".log-group-header");
    const firstNode = header?.firstChild;
    if (firstNode && firstNode.nodeType === Node.TEXT_NODE) {
      firstNode.textContent = `Run ${label}`;
    }
  }
}
