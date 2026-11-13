/**
 * mcp-panel.ts — the Settings controls for connecting an MCP server.
 *
 * Its own module rather than more lines in settings.ts, which is
 * already 1,400 lines and covers nine unrelated controls. This is one
 * self-contained feature with its own three routes, so it gets its own
 * file.
 *
 * ---------------------------------------------------------------------------
 * What connecting actually does
 * ---------------------------------------------------------------------------
 *
 * The server fetches the remote tool list and adapts each entry into
 * the same shape a local tool has. They then appear in the Tools tab
 * above, badged `mcp`, and are ticked and sent exactly like the rest.
 *
 * The thing worth noticing is what does NOT change. Claude receives one
 * `tools` array and answers with one `tool_use` block; nothing in the
 * request says where a tool runs, and nothing in the model's reply
 * distinguishes them. Where the function executed — in this process, on
 * Anthropic's infrastructure, or on a machine reached over MCP — is
 * this server's problem alone.
 *
 * ---------------------------------------------------------------------------
 * The import direction
 * ---------------------------------------------------------------------------
 *
 * This imports `appendLog` from log.ts and `reloadTools` from
 * settings.ts, and nothing imports it except app.ts. That keeps the
 * frontend's one-way rule intact: app.ts may know about everything,
 * and nothing may know about app.ts.
 */

import { appendLog } from "./log.js";
// initTools re-fetches /api/tools and redraws the checkbox list.
// Reusing it rather than adding a reloadTools() alias: connecting is
// exactly the "load the current tool list" case it already handles,
// and a second name for one behaviour is a second thing to keep
// correct.
import { initTools } from "./settings.js";

/**
 * What GET/POST/DELETE /api/mcp return.
 *
 * Mirrors `McpStatus` in server/mcp/client.ts. Declared again rather
 * than shared through shared/types.ts, because that file is the CHAT
 * STREAM's contract — what travels over SSE while a turn runs — and
 * this is an ordinary request/response that has nothing to do with it.
 * Putting it there would widen that file's meaning to "anything both
 * halves know about", which is how a wire contract stops being one.
 */
interface McpStatus {
  connected: boolean;
  transport?: "http" | "stdio";
  target?: string;
  serverName?: string;
  serverVersion?: string;
  toolNames: string[];
  shadowed: string[];
  error?: string;
}

const transportSelect = document.getElementById(
  "mcp-transport",
) as HTMLSelectElement;
const urlField = document.getElementById("mcp-url-field") as HTMLElement;
const urlInput = document.getElementById("mcp-url") as HTMLInputElement;
const commandField = document.getElementById(
  "mcp-command-field",
) as HTMLElement;
const commandInput = document.getElementById(
  "mcp-command",
) as HTMLInputElement;
const connectButton = document.getElementById(
  "mcp-connect",
) as HTMLButtonElement;
const disconnectButton = document.getElementById(
  "mcp-disconnect",
) as HTMLButtonElement;
const statusEl = document.getElementById("mcp-status") as HTMLElement;

/** Shows the field the selected transport needs, and hides the other. */
export function handleMcpTransportChange(): void {
  const stdio = transportSelect.value === "stdio";
  urlField.hidden = stdio;
  commandField.hidden = !stdio;
}

/**
 * Draws the current connection state.
 *
 * textContent throughout, and the reason is sharper here than
 * elsewhere in the app: the server name and every tool name come from
 * a REMOTE SERVER. That is the same untrusted category as model
 * output, and the rule the whole frontend follows.
 */
function render(status: McpStatus): void {
  statusEl.replaceChildren();
  connectButton.hidden = status.connected;
  disconnectButton.hidden = !status.connected;

  if (status.error) {
    const line = document.createElement("div");
    line.className = "mcp-error";
    line.textContent = status.error;
    statusEl.appendChild(line);
    return;
  }

  if (!status.connected) {
    statusEl.textContent =
      "Not connected. Start the MCP Lab, then connect.";
    return;
  }

  const summary = document.createElement("div");
  summary.textContent =
    "Connected to " +
    status.serverName +
    " " +
    status.serverVersion +
    " over " +
    (status.transport === "stdio" ? "stdio" : "HTTP") +
    " — " +
    status.toolNames.length +
    " tool(s) borrowed.";
  statusEl.appendChild(summary);

  // Collisions are surfaced rather than swallowed. A remote tool whose
  // name is already taken is DROPPED and the local one kept — so
  // someone who connected expecting the remote behaviour has to be
  // told why they did not get it.
  if (status.shadowed.length > 0) {
    const clash = document.createElement("div");
    clash.className = "mcp-warn";
    clash.textContent =
      "Ignored " +
      status.shadowed.length +
      " remote tool(s) whose names are already taken locally: " +
      status.shadowed.join(", ") +
      ". The local tools are still the ones that run.";
    statusEl.appendChild(clash);
  }
}

/** Reads the current state at startup, so the dialog opens honest. */
export async function refreshMcpStatus(): Promise<void> {
  try {
    const response = await fetch("/api/mcp");
    if (!response.ok) throw new Error("HTTP " + response.status);
    render((await response.json()) as McpStatus);
  } catch {
    statusEl.textContent = "Could not reach the server.";
  }
}

/**
 * Connects, then reloads the tool list.
 *
 * The reload is the point. The borrowed tools have to appear in the
 * list above, badged, or connecting has no visible effect inside the
 * dialog that did it.
 */
export async function connectMcp(): Promise<void> {
  connectButton.disabled = true;
  statusEl.textContent = "Connecting…";

  const stdio = transportSelect.value === "stdio";

  // A stdio command is split on whitespace into a program and its
  // arguments. Crude, and worth saying what it cannot do: a path
  // containing a space has to be given another way. The honest
  // alternative is a second field for arguments, which is more UI
  // than this lab needs for a case that mostly does not arise.
  const parts = commandInput.value.trim().split(/\s+/).filter(Boolean);

  try {
    const response = await fetch("/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        stdio
          ? { transport: "stdio", command: parts[0], args: parts.slice(1) }
          : { transport: "http", url: urlInput.value },
      ),
    });

    if (!response.ok) throw new Error("HTTP " + response.status);

    const status = (await response.json()) as McpStatus;
    render(status);

    if (status.connected) {
      appendLog({
        level: "info",
        label:
          "Connected to MCP server " +
          status.serverName +
          " — " +
          status.toolNames.length +
          " tool(s) available",
        at: Date.now(),
        actor: "user",
        because: "an MCP server was connected in Settings",
        detail: {
          transport: status.transport,
          target: status.target,
          tools: status.toolNames,
          shadowed: status.shadowed,
          note:
            "These tools now appear in the Tools tab beside the local " +
            "ones. Claude is told about them in exactly the same way — " +
            "one tools array — and cannot tell where any of them run.",
        },
      });

      // warn, not error: the run proceeds exactly as designed, and
      // the note exists so the Tools tab's count is not misleading.
      // Same test the log's own levels use.
      if (status.shadowed.length > 0) {
        appendLog({
          level: "warn",
          label:
            status.shadowed.length +
            " remote tool(s) ignored — name already taken",
          at: Date.now(),
          actor: "app",
          because: "a local tool already uses that name",
          detail: {
            ignored: status.shadowed,
            note:
              "Tools are looked up by name, so two with one name means " +
              "the second silently never runs. The local tool is kept, " +
              "because it is the one you can change.",
          },
        });
      }
    } else {
      appendLog({
        level: "error",
        label: "Could not connect to the MCP server",
        at: Date.now(),
        actor: "app",
        detail: { error: status.error },
      });
    }

    await initTools();
  } catch (error) {
    statusEl.textContent = "Could not reach the server: " + String(error);
  } finally {
    connectButton.disabled = false;
  }
}

/** Disconnects, and takes the borrowed tools out of the list. */
export async function disconnectMcp(): Promise<void> {
  disconnectButton.disabled = true;

  try {
    const response = await fetch("/api/mcp", { method: "DELETE" });
    if (!response.ok) throw new Error("HTTP " + response.status);

    render((await response.json()) as McpStatus);

    appendLog({
      level: "info",
      label: "Disconnected from the MCP server",
      at: Date.now(),
      actor: "user",
      because: "the connection was closed in Settings",
    });

    await initTools();
  } catch (error) {
    statusEl.textContent = "Could not reach the server: " + String(error);
  } finally {
    disconnectButton.disabled = false;
  }
}
