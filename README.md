# Anthropic Chat Lab

A small chat app for learning the Claude API by watching it work.

It is a normal chat window with an activity log beside it. The log shows
every request that leaves your machine and every response that comes
back — the actual JSON, not a summary — along with what each one cost
and why it happened. You can switch the orchestration pattern, the
models, the tools, the system prompt, caching, thinking and effort
between messages, and watch the numbers change.

Built for people preparing for the Anthropic certifications, and for
anyone who would rather see `stop_reason: "tool_use"` arrive than read
about it.

It runs entirely on your machine. Nothing is hosted, nothing is shared,
and the only network calls are to the Anthropic API.

📄 **[Project overview](https://cjsharp1.github.io/anthropic-chat-lab/)**
— a one-page tour of the architecture, the patterns and what each one
costs, without cloning anything.

---

## What you need

| | |
|---|---|
| **Node.js** | 20 or newer. Developed on 24.4.1 — check with `node --version` |
| **An API key** | From [console.anthropic.com](https://console.anthropic.com/settings/keys). Starts with `sk-ant-`. You paste it into the app itself — there is no config file to edit |
| **About $2** | Enough for weeks of learning. Most turns cost a fraction of a cent; the figure in the header tells you as you go |

No database, no Docker, no build step to watch. One `npm install` and
one `npm run dev`.

---

## Setup

Three steps, and none of them involve editing a file.

**1. Install the dependencies.**

```bash
npm install
```

**2. Start the server.**

```bash
npm run dev
```

**3. Open http://localhost:3000 and paste your API key.**

The app opens with a banner saying no key is set. Click **Add a key**,
paste your key from
[console.anthropic.com](https://console.anthropic.com/settings/keys),
and press Save. The banner disappears and you can send your first
message.

That is the whole setup. There is no `.env` to create.

### Where the key goes

Worth knowing, because the app is partly about this.

The key is sent to the small Express server in `server/`, which holds
it **in memory** and uses it to call Anthropic on your behalf. It is
never stored in your browser — not in `localStorage`, not in a cookie
— and no endpoint will give it back. The browser can only ask whether
a key is set and see a masked hint like `sk-ant-…7gAA`.

That is the same reason the chat itself goes through a server rather
than calling Anthropic from the page: a key in frontend code is a key
anyone can read with DevTools. The frontend `tsconfig` sets
`"types": []` so server-only globals like `process` cannot even be
referenced from client code by accident.

The trade is that **the key is forgotten when you stop the server.**
For a laptop running a teaching app, retyping it is cheaper than
having a secret written somewhere that backups and sync tools might
pick up.

### Optional: skip retyping the key

If re-entering the key each session annoys you, put it in a `.env`
file and the server will load it at startup instead:

```bash
# macOS / Linux
cp .env.example .env

# Windows (PowerShell)
Copy-Item .env.example .env
```

```
ANTHROPIC_API_KEY=sk-ant-...
PORT=3000
```

`.env` is git-ignored; `.env.example` is committed and holds no
secret. When a key is loaded this way, Settings labels it as coming
from `.env`. Saving a key in Settings overrides it for that session,
and clearing one falls back to the `.env` value.

To check that a `.env` file is being read correctly:

```bash
npm run check-env
```

That only inspects `.env` — it cannot see a key you typed into
Settings, because that one lives in the running server's memory.

### If your machine has a company API gateway

If `ANTHROPIC_BASE_URL` is set in your environment, the SDK will use it
and you may get a `401` with a key that is otherwise fine. This app
pins `baseURL` to `https://api.anthropic.com` in `server/anthropic.ts`
to bypass that. If you *want* to go through a gateway, change it there.

---

## Running it

```bash
npm run dev
```

Then open **http://localhost:3000**.

`npm run dev` uses `tsx`, which runs the TypeScript directly and
restarts on save. That is the normal way to use this app.

A restart clears the in-memory API key, so you will be asked for it
again unless you set up a `.env` as described above.

`npm run build` compiles both halves into `dist/` and copies
`server/data` alongside them, so `node dist/server/index.js` also
works. You will not need it for learning, but it is there if you want
to check the compiled output.

---

## The first five minutes

With a key saved, you are ready. Above the message box is a row of
five example questions. Each one is
chosen to make a different mechanism visible, and each sets up whatever
it needs — pattern, tools, effort — when you click it. They fill the
box rather than sending, so you can read the question first.

Click them left to right:

| Button | What to watch in the log |
|---|---|
| **Tool call** | Claude's first reply has `stop_reason: "tool_use"` and no answer. Your code runs the calculator and sends the result back. Two requests for one question. |
| **Tool loop** | Three tool calls, four requests. The loop runs until `stop_reason` stops being `tool_use`. |
| **Caching** | Send it **twice**. The first write puts the tool definitions in the cache; the second reads ~2,150 tokens back. |
| **Extract** | Then click *Extract structured data* under your own message. Look at `output_config.format` in the request, and at how the raw reply is bare JSON with no code fence. |
| **Effort** | Send at effort `low`, then again at `xhigh`. About 2.5× the output tokens on Haiku, for an answer the same length. |

---

## The two panes

The window is two columns, each with its own header and its own
Clear:

```
Message log            Clear  │  Activity log  14       Clear
Tool loop · effort: low       │  ☑ API  ☑ TOOL  ☑ INFO  ☑ WARN
──────────────────────────────┼──────────────────────────────
the conversation              │  what each turn actually did
```

Clearing one does not touch the other. The line under **Message log**
summarises the settings and opens the dialog that holds them; it
shows only what is set away from its default, so it is short until
you start experimenting. The running cost sits beside the activity
log, because that pane is where the money is accounted for — and it
resets only when you clear that pane.

Drag the divider between the columns to resize.

---

## Reading the activity log

Each row is one thing that happened:

```
→  Calling claude-haiku-5-5 · 1 message(s)            10:51:19
   API  APP  the user sent a message
   ▸ request  0.9 kB
```

- **The arrow** is the most important thing on the row. `→` means data
  left your machine, `←` means it came back, `·` means neither — the app
  did something locally. A row that claims a boundary crossing when
  nothing crossed is a bug, and several were fixed during development.
- **The tag** (`API`, `TOOL`, `INFO`, `WARN`, `ERROR`) and the stripe
  down the left edge say what kind of event it was. Use the checkboxes
  at the top of the panel to hide kinds you are not reading.
- **The actor chip** (`APP`, `CLAUDE`, `USER`, `TOOL`) says who caused
  it. The difference between "Claude asked for this" and "our code did
  this" is the single most misunderstood thing about tool use.
- **The ▸ expander** holds the real payload. Click it.

The figure in the header is what the session has cost so far. It is an
estimate from published rates hard-coded in `server/usage.ts`, so treat
it as a way to notice that one pattern costs four times another, not as
a bill.

---

## The seven patterns

Switch between them in the settings dialog. The same question through two
patterns, with the costs side by side, is the whole point of the
dropdown.

| Pattern | Requests | When it earns its cost |
|---|---|---|
| **Single call** | 1 | The default, and the baseline every other pattern has to beat. Does **not** run tools — if Claude asks for one, it stops and tells you. |
| **Tool loop** | 2–4 | Anything the model cannot know: the time, a calculation, a file, a search. |
| **Prompt chaining** | 2 | Long structured answers. A plan call, then a writing call that follows it. |
| **Routing** | 2 | Mixed question types that one system prompt cannot serve. Classify cheaply, then answer with the right prompt. |
| **Parallelisation** | 4 | Several angles that all matter, with someone waiting. Buys latency, not money. |
| **Orchestrator + workers** | 3–7 | Separable parts, where what the parts *are* depends on the question. |
| **Evaluator + optimiser** | 2–6 | When being wrong is expensive and being slow is not. A separate judge catches what self-review misses. |

### Models by role, not by pattern

Patterns use up to three roles — **deciding**, **producing**,
**judging** — and you assign a model to each. A planner or a classifier
is a deciding job: short structured output that feeds code, nobody reads
it. At published rates Opus is 40× Haiku per token ($4/$20 against
$0.10/$0.50 per million), so that choice is most of the bill on a
multi-call pattern.

The dialog shows only the roles the selected pattern actually uses. After
a reply, the **Re-run with** row lets you change one model and run the
same question again, so the comparison holds everything else constant.

---

## The tools

Six run on your machine, one runs on Anthropic's.

| Tool | Where it runs | What it teaches |
|---|---|---|
| `calculator` | client | The basic loop. Arithmetic the model would get wrong. |
| `get_current_time` | client | Something the model genuinely cannot know. |
| `notes` | client | State across calls, and multi-step loops. |
| `search_docs` | client | Retrieval over a local corpus. |
| `read_file` | client | Sandboxing. Resolves the path first, then checks it is still inside the sandbox — the order that defeats `../`. |
| `flaky_service` | client | Controllable failure. `failRate: 1` fails every time, so error handling can be demonstrated on purpose. |
| `web_search` | **server** | Runs on Anthropic's infrastructure. No loop, no client code — the result arrives in the same response, with `stop_reason: "end_turn"`. |

Tick and untick them on the **Tools** tab of the settings dialog. An
unticked tool is not sent
at all, so the model is never told it exists. Each tool lists a prompt
that triggers it.

**A trap worth knowing:** Single call strips client tools from the
request, because it cannot run them. So enabling every tool and
wondering why nothing caches is expected — the definitions never left.
Caching needs the tools actually sent, which means a pattern that runs
them.

---

## The settings, and what each one costs you

Everything below is in the settings dialog, opened by clicking the
line above the conversation that summarises them (or the tool count
beside it). Each control carries a longer explanation.

**System prompt** — five of them, from `Terse` to `Teaching assistant`
to none at all. This is the cheapest lever in the app and the easiest
to overlook: asked "what does stop_reason end_turn mean?", Terse
answered in **23 output tokens** and Teaching assistant in **589** —
25× the cost, same fact.

**Tool choice** — `auto`, `none`, and the two forced options that
current models reject with a 400, left in so you can see the error.

**Prompt caching** — off, prefix, or full. Caching is a **prefix**
match: the API renders `tools → system → messages`, and any byte that
changes before a breakpoint invalidates everything after it. The minimum
cacheable prefix is 1,024 tokens, or 2,048 on Haiku — shorter prefixes
are silently not cached, which is why enabling tools usually matters
more than the prompt.

**Extended thinking** — this does *not* control whether Claude thinks.
On these models thinking is always on and always billed; `display` only
decides whether the blocks come back with text in them. Measured on
Haiku: hidden cost 825 output tokens, summarized cost 836. You are
paying for reasoning either way.

**Effort** — `output_config.effort`, which replaced `budget_tokens`
(now a 400 on every model here). Five levels. Measured on Haiku with
`npm run try-effort`:

- Hard question: `low` 2,438 output tokens, `xhigh` 6,501 — 2.7× the
  cost for an answer the same length.
- Easy question: `max` costs **5.2×** what `low` does and returns the
  same answer. That is effort you pay for and do not receive.
- At `max`, the model can spend the entire `max_tokens` budget thinking
  and return **no answer at all**, with `stop_reason: "max_tokens"`.

---

## A suggested lesson order

Each of these is one sitting. Use the preset buttons as starting points
and change one thing at a time.

1. **One request, one response.** Single call, Terse prompt. Send
   anything. Expand the request row and read it — note that your whole
   conversation is in it, because the API is stateless and keeps nothing
   between calls.
2. **Verbosity is a cost.** Same question under each of the five system
   prompts. Compare output tokens in the header.
3. **The tool loop.** The *Tool call* preset. Watch `stop_reason`
   change, and count the requests.
4. **Tools are not magic.** Untick every tool and ask the same question.
   Claude answers from memory, and gets the arithmetic wrong.
5. **Multi-step tools.** The *Tool loop* preset — three calls, each
   depending on the last.
6. **Failure.** `flaky_service` with `failRate: 1`. Watch the error come
   back as a `tool_result` with `is_error: true`, and Claude react to it.
7. **Client vs server tools.** Ask something needing `web_search`. No
   loop, no client execution, `end_turn` straight away.
8. **Patterns, measured.** One question through Single call, then
   Chaining, then Orchestrator. Compare cost and latency. Decide whether
   the expensive one earned it.
9. **Models by role.** Set the deciding model to Opus, re-run with
   Haiku, compare. The planner's job does not need the big model.
10. **Structured outputs.** The *Extract* preset. Read the raw reply —
    bare JSON, no fence, nothing to strip.
11. **Caching.** The *Caching* preset, sent twice. Then change one byte
    of the system prompt and send again — the hit disappears.
12. **Thinking and effort.** The *Effort* preset at `low` and `xhigh`.
    Then turn on the reasoning summary and read what it was doing.

---

## Project layout

```
server/
  index.ts              Express app and every API route
  anthropic.ts          The shared SDK client and model ids
  api-key.ts            The API key, held in memory for the session
  types.ts              LogEvent, StreamEvent, the shared shapes
  logger.ts             Builds log events; knows nothing about HTTP
  usage.ts              Token counts, pricing, the cache tally
  caching.ts            Where cache_control breakpoints go
  models.ts             Roles and model assignment
  thinking.ts           Adaptive thinking and display
  effort.ts             output_config.effort
  extract.ts            Structured outputs with Zod
  prompts.ts            The five system prompts
  orchestration/
    types.ts            Pattern and PatternContext
    registry.ts         The seven patterns, listed
    patterns/           One file per pattern
  tools/
    types.ts            LabTool, defineTool
    registry.ts         The tool list
    definitions/        One file per tool
shared/
  types.ts              The wire contract: LogEvent, StreamEvent.
                        Imported by both halves so they cannot
                        disagree about what crosses the connection.
public/
  index.html            The whole UI
  app.ts                Sending, the event stream, A/B comparison,
                        structured extraction, startup wiring
  log.ts                The activity panel: rows, groups, filters,
                        the running cost
  settings.ts           The six controls, and tool selection
  transcript.ts         Tool cards between messages
  state.ts              The handful of values more than one module
                        writes — a plain object, because ES modules
                        will not let one module reassign another's
                        exported binding
  types.ts              Shapes the browser defines for itself
  json-tree.ts          The collapsible JSON viewer in the log
  markdown.ts           A small hand-written Markdown renderer
  styles.css
  favicon.svg
scripts/                Standalone experiments, see below
build-plan.html         The 68-step plan this was built from
index.html              A one-page tour of the finished project.
                        Named index.html because GitHub Pages serves
                        it as the site root
CLAUDE.md               Conventions for Claude Code — the comment
                        rule, the key invariants, what not to break
```

The frontend splits along one rule: the import graph runs one way.
`app.ts` imports from `log.ts`, `settings.ts` and `transcript.ts`;
`settings.ts` imports `appendLog` from `log.ts`; nothing imports
`app.ts`. The A/B comparison and the extraction card look like they
belong in `transcript.ts`, but both send their own requests and need
the sending machinery — moving them would mean a cycle, so they stay
with the code they depend on.

Every file opens with a comment explaining what it does and why it
exists. `npm run audit-comments` checks that none have been missed.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the app on port 3000, restarting on save |
| `npm run check-env` | Inspect `.env` — note it cannot see a key set in Settings |
| `npm run hello` | The smallest possible API call |
| `npm run try-notes` | Exercise the notes tool directly |
| `npm run try-flaky` | Prove the unreliable tool is reliably unreliable |
| `npm run try-effort` | Sweep all five effort levels across two questions |
| `npm run audit-comments` | Check every file has a header comment |
| `npm run typecheck` | Type-check server and client |
| `npm run build` | Compile both halves |

`try-effort` takes flags: `--model claude-sonnet-5-5`, `--runs 3`,
`--max-tokens 32000`. It spends real money — ten requests, about two
cents on Haiku.

---

## Things that will trip you up

**A blank reply at high effort.** The model spent the whole token
budget thinking. Check `stop_reason` — if it is `max_tokens` with no
text block, lower the effort or raise `max_tokens`.

**Caching that never hits.** Check three things: the prefix is over the
minimum (2,048 tokens on Haiku), nothing in it changed between
requests, and the pattern actually sends tools. Entries also expire
after about five minutes idle.

**"Claude asked for a tool but this pattern does not run them."** You
are on Single call. That message is the pattern working as designed.

**A 400 on `tool_choice`.** Forced tool use (`any` / `tool`) was removed
on current models. The options are in the dropdown so you can see the
error.

**`budget_tokens` returns a 400.** It was replaced by
`output_config.effort`.

---

## Costs

Everything here is deliberately cheap. On Haiku a single turn is around
$0.0002; the heaviest pattern on Opus with every tool enabled is a few
cents. The header figure is cumulative for the session and resets when
you clear.

The rates are hard-coded in `server/usage.ts` and **will go out of
date**. Check [anthropic.com/pricing](https://www.anthropic.com/pricing)
for current numbers.

---

## Security notes

The key is held in the server's memory and is never sent to the
browser: the only key endpoint that returns anything returns a masked
hint (`sk-ant-…7gAA`) and a yes/no. It is not written to disk, and not
stored in `localStorage`. An optional git-ignored `.env` can supply it
at startup instead. The client `tsconfig` sets `"types": []` so server
globals cannot be referenced from frontend code. Model output is rendered with
`textContent`, never `innerHTML` — including inside the Markdown
renderer, which is hand-written for that reason rather than pulled from
a package. `read_file` is sandboxed to one directory: it resolves the
requested path to a canonical absolute path and then checks that the
result is still inside the sandbox, which is the ordering that defeats
`../` — see the comment at the top of
`server/tools/definitions/read-file.ts`.

This is a local teaching tool. It has no authentication and binds to
localhost. **Do not put it on a network.** That matters more now that
the key can be set over HTTP: anyone who can reach the port can set,
replace or use the key, and spend against your account.
