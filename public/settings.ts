/**
 * settings.ts — the six controls that shape a request.
 *
 * Orchestration pattern, system prompt, tool_choice, prompt caching,
 * extended thinking, effort — plus which tools are offered at all.
 *
 * Every one follows the same shape: fetch the options from an
 * endpoint, build a dropdown, remember the choice in localStorage,
 * and explain what the current value does. Seeing six variations on
 * one pattern side by side is part of what this file teaches.
 *
 * Each control logs its own change, which is why this imports
 * appendLog. Nothing here imports from app.ts.
 */

import type {
  CacheModeOption,
  EffortLevel,
  ModelOption,
  PatternOption,
  PromptOption,
  RoleInfo,
  ThinkingOption,
  ToolChoiceOption,
  ToolInfo,
} from "./types.js";
import { appendLog } from "./log.js";

/* The composer, for presets that fill it and controls that
   return focus to it after a change. Looked up here rather than
   imported: a getElementById is cheaper than a dependency. */
const input = document.getElementById(
  "message-input",
) as HTMLTextAreaElement;

export const patternSelect = document.getElementById(
  "pattern-select",
) as HTMLSelectElement;
const patternHelp = document.getElementById(
  "pattern-help",
) as HTMLElement;
const patternTableBody = document.getElementById(
  "pattern-table-body",
) as HTMLElement;
export const promptSelect = document.getElementById(
  "prompt-select",
) as HTMLSelectElement;
const promptHelp = document.getElementById(
  "prompt-help",
) as HTMLElement;
export const toolChoiceSelect = document.getElementById(
  "tool-choice-select",
) as HTMLSelectElement;
const toolChoiceHelp = document.getElementById(
  "tool-choice-help",
) as HTMLElement;
export const cacheModeSelect = document.getElementById(
  "cache-mode-select",
) as HTMLSelectElement;
const cacheModeHelp = document.getElementById(
  "cache-mode-help",
) as HTMLElement;
export const modelRoles = document.getElementById(
  "model-roles",
) as HTMLElement;
const toolList = document.getElementById(
  "tool-list",
) as HTMLElement;
const toolCount = document.getElementById(
  "tool-count",
) as HTMLElement;
export const toolsAllButton = document.getElementById(
  "tools-all",
) as HTMLButtonElement;
export const toolsNoneButton = document.getElementById(
  "tools-none",
) as HTMLButtonElement;
export const toolSummary = document.getElementById(
  "tool-summary",
) as HTMLButtonElement;
const toolSummaryText = document.getElementById(
  "tool-summary-text",
) as HTMLElement;
const settingsSummaryText = document.getElementById(
  "settings-summary-text",
) as HTMLElement;

// --- Orchestration pattern selection ----------------------------------------


const PATTERN_STORAGE_KEY = "chat-lab-pattern";

export let patternOptions: PatternOption[] = [];

/**
 * Loads the available patterns and fills the selector.
 *
 * The descriptions come from the server rather than the HTML because
 * they live beside each pattern's implementation — a pattern that
 * changes what it does cannot leave a stale description behind.
 */
export async function initPatterns(): Promise<void> {
  try {
    const response = await fetch("/api/patterns");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as {
      patterns: PatternOption[];
      default: string;
    };

    patternOptions = data.patterns;
    patternSelect.replaceChildren();

    for (const option of data.patterns) {
      const el = document.createElement("option");
      el.value = option.id;
      // The request count in the label, so the cost is visible before
      // the pattern is chosen rather than after the bill arrives.
      el.textContent = `${option.name} (${option.typicalRequests} request${
        option.typicalRequests === "1" ? "" : "s"
      })`;
      patternSelect.appendChild(el);
    }

    let chosen = data.default;
    try {
      const saved = localStorage.getItem(PATTERN_STORAGE_KEY);
      if (saved && data.patterns.some((p) => p.id === saved)) chosen = saved;
    } catch {
      /* storage unavailable — the default applies */
    }

    patternSelect.value = chosen;
    renderPatternTable();
    describeSelectedPattern();
    // Both lists load independently; whichever arrives second triggers
    // the render that needs them both.
    if (Object.keys(roleInfo).length > 0) renderModelRoles();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog({
      level: "error",
      label: `Could not load the pattern list: ${message}`,
      at: Date.now(),
    });
  }
}

/**
 * Fills the comparison table.
 *
 * The figures are pulled out of each pattern's measuredCost sentence
 * rather than stored separately, so there is one source of truth: a
 * pattern whose cost changes is edited in one place and the table
 * follows.
 */
function renderPatternTable(): void {
  patternTableBody.replaceChildren();

  for (const option of patternOptions) {
    const row = document.createElement("tr");

    const name = document.createElement("td");
    name.textContent = option.name;

    const requests = document.createElement("td");
    const reqMatch = /^(\d+) requests?/.exec(option.measuredCost);
    requests.textContent = reqMatch?.[1] ?? option.typicalRequests;

    const cost = document.createElement("td");
    // A digits-and-dots class swallows the sentence's final full
    // stop, giving "$0.0290." — so the fractional part is matched
    // explicitly rather than greedily.
    const costMatch = /\$\d+(?:\.\d+)?/.exec(option.measuredCost);
    cost.textContent = costMatch?.[0] ?? "—";

    // Mark the current selection, so the table answers "where am I" as
    // well as "what are the options".
    if (option.id === patternSelect.value) row.className = "is-current";

    row.append(name, requests, cost);
    patternTableBody.appendChild(row);
  }
}

/** Shows the selected pattern's description in the Settings tab. */
function describeSelectedPattern(): void {
  const selected = patternOptions.find((p) => p.id === patternSelect.value);
  if (!selected) return;

  // Three layers rather than two, because a pattern needs more
  // explaining than a prompt: what it does, when to reach for it, and
  // what it measurably cost.
  patternHelp.replaceChildren();

  const what = document.createElement("p");
  what.className = "setting-what";
  what.textContent = selected.description;

  const when = document.createElement("p");
  when.className = "setting-when";
  when.textContent = selected.whenToUse;

  const cost = document.createElement("p");
  cost.className = "setting-effect";
  cost.textContent = `Measured: ${selected.measuredCost}`;

  patternHelp.append(what, when, cost);

  // Example prompts. Each pattern needs a different shape of question
  // to show what it does, and a pattern tried with the wrong question
  // looks identical to a single call — which teaches the opposite of
  // what it should.
  if (selected.examples.length > 0) {
    patternHelp.appendChild(buildExamples(selected.examples));
  }

  refreshSettingsSummary();
}

/**
 * Builds the clickable example prompts for a pattern.
 *
 * Clicking one loads it into the composer rather than sending it. The
 * extra click is deliberate: every send costs real money, and a panel
 * that fires requests on a stray click would be an unpleasant way to
 * find that out.
 */
function buildExamples(
  examples: PatternOption["examples"],
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "pattern-examples";

  const heading = document.createElement("p");
  heading.className = "examples-heading";
  heading.textContent = "Try it";
  wrapper.appendChild(heading);

  for (const example of examples) {
    const item = document.createElement("div");
    item.className = `example example-${example.kind}`;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "example-prompt";
    button.textContent = example.prompt;
    button.title = "Load this into the composer";

    button.addEventListener("click", () => {
      input.value = example.prompt;
      input.focus();
      // Put the caret at the end, so typing extends the prompt rather
      // than inserting at the start of it.
      input.setSelectionRange(example.prompt.length, example.prompt.length);

      appendLog({
        level: "info",
        label: `Example loaded: ${example.prompt.slice(0, 44)}…`,
        at: Date.now(),
        detail: { prompt: example.prompt, watch_for: example.watch },
      });
    });

    const tag = document.createElement("span");
    tag.className = "example-tag";
    tag.textContent = example.kind === "good-fit" ? "good fit" : "poor fit";

    const watch = document.createElement("p");
    watch.className = "example-watch";
    watch.textContent = example.watch;

    item.append(button, tag, watch);
    wrapper.appendChild(item);
  }

  return wrapper;
}

/** Remembers the choice and logs the switch. */
export function handlePatternChange(): void {
  try {
    localStorage.setItem(PATTERN_STORAGE_KEY, patternSelect.value);
  } catch {
    /* not important enough to surface */
  }

  describeSelectedPattern();
  renderPatternTable();
  // The roles on offer depend on the pattern.
  renderModelRoles();

  const selected = patternOptions.find((p) => p.id === patternSelect.value);
  appendLog({
    level: "info",
    label: `Pattern switched to: ${selected?.name ?? patternSelect.value}`,
    at: Date.now(),
    detail: selected?.description,
  });
}

// --- System prompt selection ------------------------------------------------


/** Where the chosen prompt is remembered between visits. */
const PROMPT_STORAGE_KEY = "chat-lab-prompt-id";

/** Everything the server offers, once loaded. */
export let promptOptions: PromptOption[] = [];

/**
 * Loads the available system prompts and fills the selector.
 *
 * Fetched rather than hard-coded in the HTML so the prompts live in exactly
 * one place — server/prompts.ts. Editing a prompt there changes the app
 * with no corresponding frontend change, which is the point of keeping
 * content out of the UI.
 */
export async function initPrompts(): Promise<void> {
  try {
    const response = await fetch("/api/prompts");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as {
      prompts: PromptOption[];
      default: string;
    };

    promptOptions = data.prompts;
    promptSelect.replaceChildren();

    for (const option of data.prompts) {
      const el = document.createElement("option");
      el.value = option.id;
      // Just the name. The size goes in the description line below, which
      // has room for it — in the dropdown it only made every option wider.
      el.textContent = option.name;
      promptSelect.appendChild(el);
    }

    // Restore the last choice, falling back to the server's default.
    let chosen = data.default;
    try {
      const saved = localStorage.getItem(PROMPT_STORAGE_KEY);
      if (saved && data.prompts.some((p) => p.id === saved)) chosen = saved;
    } catch {
      /* storage unavailable — the default applies */
    }

    promptSelect.value = chosen;
    describeSelectedPrompt();
  } catch (error: unknown) {
    // A failure here is not fatal: the server falls back to its default
    // prompt when the browser does not name one, so chat still works.
    const message = error instanceof Error ? error.message : String(error);
    appendLog({
      level: "error",
      label: `Could not load system prompts: ${message}`,
      at: Date.now(),
    });
  }
}

/**
 * Writes the two-part help text for a setting.
 *
 * The first paragraph says when you would choose this option; the
 * second says what it changes on the wire and what to watch for in the
 * activity log. Two paragraphs rather than one, because they answer
 * different questions — a learner reading "when would I use this" does
 * not always want "and here is what it sends".
 */
function renderSettingHelp(
  target: HTMLElement,
  description: string,
  effect: string,
): void {
  const what = document.createElement("p");
  what.className = "setting-what";
  what.textContent = description;

  const wire = document.createElement("p");
  wire.className = "setting-effect";
  wire.textContent = effect;

  target.replaceChildren(what, wire);
}

/**
 * Shows the selected prompt's description under the controls.
 *
 * The size goes here rather than in the dropdown label: it is the number
 * that makes the cost difference concrete, and this line has room for it.
 */
function describeSelectedPrompt(): void {
  const selected = promptOptions.find((p) => p.id === promptSelect.value);
  if (!selected) return;

  renderSettingHelp(
    promptHelp,
    selected.characters > 0
      ? `${selected.description} (${selected.characters} characters)`
      : selected.description,
    selected.effect,
  );

  refreshSettingsSummary();
}

/** Remembers the choice and logs the switch, so the panel records it. */
export function handlePromptChange(): void {
  try {
    localStorage.setItem(PROMPT_STORAGE_KEY, promptSelect.value);
  } catch {
    /* not important enough to surface */
  }

  describeSelectedPrompt();

  const selected = promptOptions.find((p) => p.id === promptSelect.value);
  appendLog({
    level: "info",
    label: `System prompt switched to: ${selected?.name ?? promptSelect.value}`,
    at: Date.now(),
    detail: selected?.text ?? "(no system prompt will be sent)",
  });
}

// --- tool_choice selection --------------------------------------------------


const TOOL_CHOICE_STORAGE_KEY = "chat-lab-tool-choice";

let toolChoiceOptions: ToolChoiceOption[] = [];

/**
 * Loads the tool_choice options and fills the selector.
 *
 * Two of them (`any` and `tool`) are expected to fail on current models.
 * They are offered anyway — meeting the 400 deliberately is more useful
 * than being told about it, and the description says so before you pick.
 */
export async function initToolChoices(): Promise<void> {
  try {
    const response = await fetch("/api/tool-choices");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as {
      choices: ToolChoiceOption[];
      default: string;
    };

    toolChoiceOptions = data.choices;
    toolChoiceSelect.replaceChildren();

    for (const option of data.choices) {
      const el = document.createElement("option");
      el.value = option.id;
      el.textContent = option.name;
      toolChoiceSelect.appendChild(el);
    }

    let chosen = data.default;
    try {
      const saved = localStorage.getItem(TOOL_CHOICE_STORAGE_KEY);
      if (saved && data.choices.some((c) => c.id === saved)) chosen = saved;
    } catch {
      /* storage unavailable — the default applies */
    }

    toolChoiceSelect.value = chosen;
    describeToolChoice();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog({
      level: "error",
      label: `Could not load tool_choice options: ${message}`,
      at: Date.now(),
    });
  }
}

/** Shows the selected option's description under the controls. */
function describeToolChoice(): void {
  const selected = toolChoiceOptions.find((c) => c.id === toolChoiceSelect.value);
  if (selected) {
    renderSettingHelp(toolChoiceHelp, selected.description, selected.effect);
  }

  refreshSettingsSummary();
}

/**
 * Updates the one-line summary in the header.
 *
 * The header no longer holds the controls, so it needs to say what they
 * are currently set to — otherwise the only way to know is to open the
 * tab, which defeats the point of moving them.
 */
export function refreshSettingsSummary(): void {
  const prompt = promptOptions.find((p) => p.id === promptSelect.value);
  const choice = toolChoiceOptions.find((c) => c.id === toolChoiceSelect.value);

  const pattern = patternOptions.find((p) => p.id === patternSelect.value);

  // Only what is NOT at its default.
  //
  // The old version always listed pattern, prompt and tool_choice,
  // which meant the line looked equally busy whether you had changed
  // anything or not — and said nothing about caching, thinking or
  // effort, which were added later and all change what a run costs.
  //
  // Listing the departures instead makes the line short at rest and
  // informative once you start experimenting, which is the point of
  // having it in the header at all.
  const parts: string[] = [];

  if (pattern) parts.push(pattern.name);
  if (prompt && promptSelect.value !== "terse") parts.push(prompt.name);
  if (choice && toolChoiceSelect.value !== "auto") {
    parts.push(`tool_choice: ${choice.name}`);
  }
  if (cacheModeSelect.value && cacheModeSelect.value !== "off") {
    parts.push(`cache: ${cacheModeSelect.value}`);
  }
  if (thinkingSelect.value === "summarized") parts.push("thinking shown");
  if (effortSelect.value && effortSelect.value !== "medium") {
    parts.push(`effort: ${effortSelect.value}`);
  }

  settingsSummaryText.textContent = parts.join(" · ") || "Settings";
}

/** Remembers the choice and logs the switch. */
export function handleToolChoiceChange(): void {
  try {
    localStorage.setItem(TOOL_CHOICE_STORAGE_KEY, toolChoiceSelect.value);
  } catch {
    /* not important enough to surface */
  }

  describeToolChoice();

  const selected = toolChoiceOptions.find((c) => c.id === toolChoiceSelect.value);
  appendLog({
    level: "info",
    label: `tool_choice set to: ${selected?.name ?? toolChoiceSelect.value}`,
    at: Date.now(),
    detail: selected?.rejected
      ? "This option returns a 400 on current models. That is the point — " +
        "send a message to see the error."
      : selected?.description,
  });
}

// --- Prompt caching -----------------------------------------------------


const CACHE_STORAGE_KEY = "chat-lab-cache-mode";

let cacheModeOptions: CacheModeOption[] = [];

/**
 * Loads the caching modes.
 *
 * Offered as a setting because the prefix rule is easier to see than
 * to read about: run a state.conversation with caching off, note the cost,
 * then run it again with it on.
 */

// --- Effort -----------------------------------------------------------------


export const effortSelect = document.getElementById(
  "effort-select",
) as HTMLSelectElement;
const effortHelp = document.getElementById("effort-help") as HTMLElement;

const EFFORT_STORAGE_KEY = "chat-lab-effort";

let effortLevels: EffortLevel[] = [];

/** Loads the levels and builds the dropdown. */
export async function initEffort(): Promise<void> {
  try {
    const response = await fetch("/api/effort-levels");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as {
      levels: EffortLevel[];
      default: string;
    };

    effortLevels = data.levels;
    effortSelect.replaceChildren();

    for (const level of data.levels) {
      const option = document.createElement("option");
      option.value = level.id;
      option.textContent = level.name;
      effortSelect.appendChild(option);
    }

    let chosen = data.default;
    try {
      const saved = localStorage.getItem(EFFORT_STORAGE_KEY);
      if (saved && data.levels.some((l) => l.id === saved)) chosen = saved;
    } catch {
      /* storage unavailable */
    }

    effortSelect.value = chosen;
    describeEffort();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog({
      level: "error",
      label: `Could not load effort levels: ${message}`,
      at: Date.now(),
    });
  }
}

/** Shows the selected level's description. */
function describeEffort(): void {
  const selected = effortLevels.find((l) => l.id === effortSelect.value);
  if (selected) effortHelp.textContent = selected.description;
  // The header line lists this now, so it has to be told.
  refreshSettingsSummary();
}

/** Remembers the choice and says what it will do. */
export function handleEffortChange(): void {
  describeEffort();
  try {
    localStorage.setItem(EFFORT_STORAGE_KEY, effortSelect.value);
  } catch {
    /* storage unavailable */
  }

  appendLog({
    at: Date.now(),
    level: "info",
    label: `Effort set to "${effortSelect.value}"`,
    because:
      "Sent as output_config.effort. Watch the output token count on " +
      "the next response row: that is where the level shows up. Ask " +
      "the same question at two levels and compare — on an easy " +
      "question the higher level often spends more for the same answer.",
    actor: "user",
  });
}

// --- Extended thinking ------------------------------------------------------


export const thinkingSelect = document.getElementById(
  "thinking-select",
) as HTMLSelectElement;
const thinkingHelp = document.getElementById("thinking-help") as HTMLElement;

const THINKING_STORAGE_KEY = "chat-lab-thinking";

let thinkingOptions: ThinkingOption[] = [];

/** Loads the display options and builds the dropdown. */
export async function initThinking(): Promise<void> {
  try {
    const response = await fetch("/api/thinking-options");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as {
      options: ThinkingOption[];
      default: string;
    };

    thinkingOptions = data.options;
    thinkingSelect.replaceChildren();

    for (const option of data.options) {
      const element = document.createElement("option");
      element.value = option.id;
      element.textContent = option.name;
      thinkingSelect.appendChild(element);
    }

    let chosen = data.default;
    try {
      const saved = localStorage.getItem(THINKING_STORAGE_KEY);
      if (saved && data.options.some((o) => o.id === saved)) chosen = saved;
    } catch {
      /* storage unavailable */
    }

    thinkingSelect.value = chosen;
    describeThinking();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog({
      level: "error",
      label: `Could not load thinking options: ${message}`,
      at: Date.now(),
    });
  }
}

/** Shows the selected option's description. */
function describeThinking(): void {
  const selected = thinkingOptions.find((o) => o.id === thinkingSelect.value);
  if (selected) thinkingHelp.textContent = selected.description;
  // The header line lists this now, so it has to be told.
  refreshSettingsSummary();
}

/** Remembers the choice and explains it. */
export function handleThinkingChange(): void {
  describeThinking();
  try {
    localStorage.setItem(THINKING_STORAGE_KEY, thinkingSelect.value);
  } catch {
    /* storage unavailable */
  }

  appendLog({
    at: Date.now(),
    level: "info",
    label: `Thinking display set to "${thinkingSelect.value}"`,
    because:
      thinkingSelect.value === "summarized"
        ? "You asked to see the reasoning. Claude was already doing it " +
          "and you were already paying for it — this only asks the API " +
          "to return a readable summary with the reply."
        : "Back to the API default. Claude still reasons and the " +
          "thinking tokens are still billed; the blocks just come back " +
          "empty.",
    actor: "user",
  });
}

export async function initCacheModes(): Promise<void> {
  try {
    const response = await fetch("/api/cache-modes");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as {
      modes: CacheModeOption[];
      default: string;
    };

    cacheModeOptions = data.modes;
    cacheModeSelect.replaceChildren();

    for (const mode of data.modes) {
      const option = document.createElement("option");
      option.value = mode.id;
      option.textContent = mode.name;
      cacheModeSelect.appendChild(option);
    }

    let chosen = data.default;
    try {
      const saved = localStorage.getItem(CACHE_STORAGE_KEY);
      if (saved && data.modes.some((m) => m.id === saved)) chosen = saved;
    } catch {
      /* storage unavailable */
    }

    cacheModeSelect.value = chosen;
    describeCacheMode();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog({
      level: "error",
      label: `Could not load caching modes: ${message}`,
      at: Date.now(),
    });
  }
}

/** Shows the selected mode's description. */
function describeCacheMode(): void {
  const selected = cacheModeOptions.find((m) => m.id === cacheModeSelect.value);
  if (selected) {
    renderSettingHelp(cacheModeHelp, selected.description, selected.effect);
  }
  refreshSettingsSummary();
}

/** Remembers the choice and logs it. */
export function handleCacheModeChange(): void {
  try {
    localStorage.setItem(CACHE_STORAGE_KEY, cacheModeSelect.value);
  } catch {
    /* not important enough to surface */
  }

  describeCacheMode();

  const selected = cacheModeOptions.find((m) => m.id === cacheModeSelect.value);
  appendLog({
    level: "info",
    label: `Prompt caching: ${selected?.name ?? cacheModeSelect.value}`,
    at: Date.now(),
    detail: selected?.effect,
  });
}

// --- Models by role ---------------------------------------------------------



const MODEL_STORAGE_KEY = "chat-lab-models";

export let modelOptions: ModelOption[] = [];
export let roleInfo: Record<string, RoleInfo> = {};

/**
 * The current assignment of models to roles.
 *
 * Sent with every request. The server falls back per role for anything
 * it does not recognise, so a stale value here cannot break a request.
 */
export let modelAssignment: Record<string, string> = {};

/** Loads the models and roles, and builds a dropdown for each role. */
export async function initModels(): Promise<void> {
  try {
    const response = await fetch("/api/models");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as {
      models: ModelOption[];
      roles: Record<string, RoleInfo>;
    };

    modelOptions = data.models;
    roleInfo = data.roles;

    // Defaults first, then anything remembered.
    modelAssignment = Object.fromEntries(
      Object.entries(roleInfo).map(([role, info]) => [role, info.defaultModel]),
    );

    try {
      const saved = localStorage.getItem(MODEL_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Record<string, string>;
        for (const [role, id] of Object.entries(parsed)) {
          if (role in modelAssignment && modelOptions.some((m) => m.id === id)) {
            modelAssignment[role] = id;
          }
        }
      }
    } catch {
      /* storage unavailable — the defaults apply */
    }

    renderModelRoles();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog({
      level: "error",
      label: `Could not load the model list: ${message}`,
      at: Date.now(),
    });
  }
}

/**
 * Builds a row for each role the selected pattern actually uses.
 *
 * Showing all three regardless would invite an experiment that cannot
 * produce a result: change the Judging model on a pattern with no
 * evaluator, re-run, and nothing differs — which teaches that model
 * choice does not matter.
 *
 * The hidden roles keep their values. Switching back to a pattern
 * that uses one restores what was set, rather than silently resetting
 * it to the default.
 */
function renderModelRoles(): void {
  modelRoles.replaceChildren();

  const pattern = patternOptions.find((p) => p.id === patternSelect.value);
  // Before the pattern list has loaded, show everything rather than
  // nothing — an empty settings panel looks broken.
  const inUse = pattern?.usesRoles ?? Object.keys(roleInfo);

  const unused = Object.keys(roleInfo).filter((r) => !inUse.includes(r));

  for (const [role, info] of Object.entries(roleInfo)) {
    if (!inUse.includes(role)) continue;
    const row = document.createElement("div");
    row.className = "model-role";

    const label = document.createElement("label");
    label.setAttribute("for", `model-${role}`);
    label.textContent = info.name;

    const select = document.createElement("select");
    select.id = `model-${role}`;

    for (const model of modelOptions) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name;
      select.appendChild(option);
    }

    select.value = modelAssignment[role] ?? info.defaultModel;

    // Marks a role left on its default, so a deliberate change stands
    // out from the starting state.
    const changed = document.createElement("span");
    changed.className = "model-changed";
    const refreshChanged = (): void => {
      changed.textContent =
        select.value === info.defaultModel ? "" : "changed";
    };
    refreshChanged();

    select.addEventListener("change", () => {
      modelAssignment[role] = select.value;
      refreshChanged();

      try {
        localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(modelAssignment));
      } catch {
        /* not important enough to surface */
      }

      const model = modelOptions.find((m) => m.id === select.value);
      appendLog({
        level: "info",
        label: `${info.name} model set to ${model?.name ?? select.value}`,
        at: Date.now(),
        detail: { role, model: select.value, used_by: info.used_by },
      });

      refreshSettingsSummary();
    });

    const usedBy = document.createElement("p");
    usedBy.className = "model-used-by";
    usedBy.textContent = info.used_by;

    const guidance = document.createElement("p");
    guidance.className = "model-guidance";
    guidance.textContent = info.guidance;

    row.append(label, select, changed, usedBy, guidance);
    modelRoles.appendChild(row);
  }

  // Say what is missing and why, rather than leaving a learner to
  // wonder whether the other roles exist.
  if (unused.length > 0 && pattern) {
    const note = document.createElement("p");
    note.className = "model-unused";
    const names = unused.map((r) => roleInfo[r]?.name ?? r).join(" and ");
    note.textContent =
      `${names} ${unused.length === 1 ? "is" : "are"} not used by ` +
      `${pattern.name}, so ${unused.length === 1 ? "it is" : "they are"} ` +
      `hidden. Their settings are kept for patterns that do.`;
    modelRoles.appendChild(note);
  }
}

// --- Tool selection ---------------------------------------------------------


/** Where the unticked tools are remembered between visits. */
const DISABLED_TOOLS_KEY = "chat-lab-disabled-tools";

/** Everything the server offers. */
export let toolInfos: ToolInfo[] = [];

/**
 * Tools the user has switched OFF.
 *
 * Storing the disabled set rather than the enabled one matters: when a new
 * tool is added to the server in a later step, it appears ticked by
 * default instead of silently missing because it was absent from a saved
 * "enabled" list.
 */
export let disabledTools = new Set<string>();

/** Reads the remembered selection. */
function loadDisabledTools(): Set<string> {
  try {
    const saved = localStorage.getItem(DISABLED_TOOLS_KEY);
    if (!saved) return new Set();
    const parsed: unknown = JSON.parse(saved);
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

/** Remembers the selection. */
function saveDisabledTools(): void {
  try {
    localStorage.setItem(DISABLED_TOOLS_KEY, JSON.stringify([...disabledTools]));
  } catch {
    /* storage unavailable — the choice lasts for this session only */
  }
}

/** The names to send with a request: everything not switched off. */
export function enabledToolNames(): string[] {
  return toolInfos.map((t) => t.name).filter((n) => !disabledTools.has(n));
}

/**
 * Updates both places the tool count appears: the tab badge and the
 * header summary.
 *
 * One function rather than two, because two would eventually disagree.
 */
function refreshToolCount(): void {
  const enabled = enabledToolNames().length;
  const total = toolInfos.length;

  toolCount.textContent = `${enabled}/${total}`;

  toolSummaryText.textContent =
    total === 0
      ? "No tools"
      : enabled === 0
        ? "Tools: none enabled"
        : enabled === total
          ? `Tools: all ${total}`
          : `Tools: ${enabled} of ${total}`;

  // Dashed border when Claude can reach nothing, so the state reads
  // without having to parse the number.
  toolSummary.classList.toggle("is-empty", enabled === 0);
}

/**
 * Loads the tool list and renders a checkbox for each.
 *
 * A failure here is not fatal: the app falls back to sending no tools,
 * which means plain chat still works.
 */
export async function initTools(): Promise<void> {
  disabledTools = loadDisabledTools();

  try {
    const response = await fetch("/api/tools");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as { tools: ToolInfo[] };
    toolInfos = data.tools;
    renderToolList();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog({
      level: "error",
      label: `Could not load the tool list: ${message}`,
      at: Date.now(),
    });
  }
}

/** Draws the checkbox rows. */
function renderToolList(): void {
  toolList.replaceChildren();

  if (toolInfos.length === 0) {
    const empty = document.createElement("li");
    empty.className = "tool-empty";
    empty.textContent = "No tools registered yet. They arrive in steps 30–36.";
    toolList.appendChild(empty);
    refreshToolCount();
    return;
  }

  for (const tool of toolInfos) {
    const item = document.createElement("li");

    const row = document.createElement("label");
    row.className = "tool-row";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !disabledTools.has(tool.name);
    box.addEventListener("change", () => {
      if (box.checked) disabledTools.delete(tool.name);
      else disabledTools.add(tool.name);

      saveDisabledTools();
      refreshToolCount();

      appendLog({
        level: "info",
        label: `Tool ${box.checked ? "enabled" : "disabled"}: ${tool.name}`,
        at: Date.now(),
        detail: { available_now: enabledToolNames() },
      });
    });

    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = tool.name;

    // Mark the tools this server does NOT execute itself.
    //
    // "server" is Anthropic's infrastructure; "mcp" is a connected
    // MCP server, which may be another process or another machine.
    // Unbadged means this app runs it. The model sees no difference
    // between the three — one tools array, one tool_use block — so
    // this badge is the only place the distinction is visible.
    if (tool.executedBy === "server" || tool.executedBy === "mcp") {
      const badge = document.createElement("span");
      badge.className = `tool-badge badge-${tool.executedBy}`;
      badge.textContent = tool.executedBy;
      name.appendChild(badge);
    }

    const description = document.createElement("span");
    description.className = "tool-description";
    description.textContent = tool.description;

    row.append(box, name, description);
    item.appendChild(row);

    // A prompt that triggers this tool. A tool nobody knows how to
    // invoke teaches nothing, and guessing one that works is harder
    // than it looks: a model asked something it can answer unaided
    // will not reach for a tool, so a plausible-looking prompt often
    // demonstrates nothing at all.
    if (tool.examplePrompt) {
      const example = document.createElement("div");
      example.className = "tool-example";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "tool-example-prompt";
      button.textContent = tool.examplePrompt;
      button.title = "Load this into the composer";

      button.addEventListener("click", () => {
        // Tick the tool if it is off, otherwise the prompt loads and
        // then silently does nothing.
        if (disabledTools.has(tool.name)) {
          disabledTools.delete(tool.name);
          saveDisabledTools();
          renderToolList();
        }

        input.value = tool.examplePrompt;
        input.focus();
        input.setSelectionRange(
          tool.examplePrompt.length,
          tool.examplePrompt.length,
        );

        appendLog({
          level: "info",
          label: `Example loaded: ${tool.name}`,
          at: Date.now(),
          detail: { prompt: tool.examplePrompt, watch_for: tool.exampleWatch },
        });
      });

      const watch = document.createElement("p");
      watch.className = "tool-example-watch";
      watch.textContent = tool.exampleWatch;

      example.append(button, watch);
      item.appendChild(example);
    }

    toolList.appendChild(item);
  }

  refreshToolCount();
}

/** Ticks or unticks everything at once. */
export function setAllTools(enabled: boolean): void {
  disabledTools = enabled ? new Set() : new Set(toolInfos.map((t) => t.name));
  saveDisabledTools();
  renderToolList();

  appendLog({
    level: "info",
    label: enabled ? "All tools enabled" : "All tools disabled",
    at: Date.now(),
    detail: { available_now: enabledToolNames() },
  });
}

// --- API key ----------------------------------------------------------------
//
// The odd one out in this file. Every other control here stores its value in
// localStorage and sends it with the next request; this one does neither.
//
// The key is POSTed to this app's own server, held in memory there, and never
// written to the browser at all. That is the whole point: a key in
// localStorage is readable by any script on the page and by anyone who opens
// DevTools, which is the problem a server-side key exists to avoid. Storing it
// here "for convenience" would undo the reason the chat goes through a server
// in the first place.
//
// The cost of that choice is that the key is gone when the server stops. The
// note under the input says so, and points at .env for anyone who would
// rather not retype it.

const apiKeyInput = document.getElementById(
  "api-key-input",
) as HTMLInputElement;
const apiKeySave = document.getElementById(
  "api-key-save",
) as HTMLButtonElement;
const apiKeyClear = document.getElementById(
  "api-key-clear",
) as HTMLButtonElement;
const apiKeyStatus = document.getElementById(
  "api-key-status",
) as HTMLElement;
const apiKeyBanner = document.getElementById(
  "api-key-banner",
) as HTMLElement;

/** What GET /api/key-status and the write endpoints return. */
interface KeyStatus {
  set: boolean;
  hint: string | null;
  source: "env" | "settings" | null;
}

/**
 * Whether a key is currently set, for callers that need to know before
 * sending. Read through a function rather than exported directly, because an
 * exported `let` cannot be reassigned by another module.
 */
let keyIsSet = false;

export function hasApiKey(): boolean {
  return keyIsSet;
}

/**
 * Paints the status line, the banner and the Clear button from one status.
 *
 * Everything that changes the key routes through here, so the three pieces of
 * UI cannot disagree about whether a key is set.
 */
function renderKeyStatus(status: KeyStatus): void {
  keyIsSet = status.set;

  apiKeyStatus.classList.remove("is-error");

  if (status.set) {
    apiKeyStatus.classList.add("is-ok");
    // Where it came from is worth saying: a key seeded from .env is already
    // present on a fresh load, which otherwise looks like the browser
    // remembered something it promised not to.
    apiKeyStatus.textContent =
      status.source === "env"
        ? `Key loaded from .env (${status.hint}). Saving one here replaces it for this session.`
        : `Key set (${status.hint}). Held in server memory until the server stops.`;
  } else {
    apiKeyStatus.classList.remove("is-ok");
    apiKeyStatus.textContent =
      "No key set. Paste one above to start — nothing can be sent without it.";
  }

  // Clear only does something when a key is set.
  apiKeyClear.hidden = !status.set;

  // The banner is the inverse of the status: shown exactly when there is no
  // key. Toggled with [hidden] so it takes no layout space when configured.
  apiKeyBanner.hidden = status.set;
}

/** Shows a failed save without disturbing the key that is already loaded. */
function renderKeyError(message: string): void {
  apiKeyStatus.classList.remove("is-ok");
  apiKeyStatus.classList.add("is-error");
  apiKeyStatus.textContent = message;
}

/**
 * Asks the server whether a key is set.
 *
 * Called on load, before anything else, because the answer decides whether
 * the app shows the setup banner or behaves normally.
 */
export async function initApiKey(): Promise<void> {
  try {
    const response = await fetch("/api/key-status");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    renderKeyStatus((await response.json()) as KeyStatus);
  } catch (error) {
    // A failure here means the server is unreachable, not that the key is
    // wrong — say so, rather than prompting for a key that would not help.
    renderKeyError(
      "Could not reach the server to check the API key. Is it still running?",
    );
    appendLog({
      level: "error",
      label: `Could not read key status: ${String(error)}`,
      at: Date.now(),
      actor: "app",
    });
  }
}

/**
 * Sends the typed key to the server.
 *
 * The input is cleared on success. There is nothing to keep it for — the
 * value is on the server now, and leaving a key sitting in a form field is
 * one more place for it to be read from.
 */
export async function saveApiKey(): Promise<void> {
  const key = apiKeyInput.value.trim();

  if (key === "") {
    renderKeyError("Paste a key first.");
    return;
  }

  // Disabled during the request so a double-click cannot send twice.
  apiKeySave.disabled = true;

  try {
    const response = await fetch("/api/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });

    const data = (await response.json()) as KeyStatus & { error?: string };

    if (!response.ok) {
      // The server's own validation message, which names what is wrong with
      // the key rather than just reporting that it failed.
      renderKeyError(data.error ?? `Could not save the key (HTTP ${response.status}).`);
      return;
    }

    apiKeyInput.value = "";
    renderKeyStatus(data);

    // Logged like any other setting change, so the activity panel shows the
    // moment the app became able to send. The hint is safe to log; the key
    // itself never reaches this code path again.
    appendLog({
      level: "info",
      label: `API key set (${data.hint})`,
      at: Date.now(),
      actor: "app",
      because:
        "the key is held in the server's memory, not in the browser — " +
        "stopping the server forgets it",
    });
  } catch (error) {
    renderKeyError(`Could not reach the server: ${String(error)}`);
  } finally {
    apiKeySave.disabled = false;
  }
}

/**
 * Forgets the key.
 *
 * On a machine with a .env key this falls back to that one rather than
 * leaving the app unusable, which is why the resulting status is read from
 * the response instead of assumed.
 */
export async function clearApiKey(): Promise<void> {
  try {
    const response = await fetch("/api/key", { method: "DELETE" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as KeyStatus;
    apiKeyInput.value = "";
    renderKeyStatus(data);

    appendLog({
      level: "info",
      label: data.set
        ? `API key cleared — fell back to the .env key (${data.hint})`
        : "API key cleared",
      at: Date.now(),
      actor: "app",
    });
  } catch (error) {
    renderKeyError(`Could not reach the server: ${String(error)}`);
  }
}
