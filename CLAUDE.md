# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

A teaching app for the Claude API. It is a chat client beside a live
activity log that shows every request, response, token count and cost.
People read this code to learn from it, which changes what "good" means
here: **the explanation is part of the deliverable, not decoration on
top of it.**

Optimising a file into something terse and clever makes this codebase
worse even when the result is objectively better code.

## The comment convention

Every `.ts` file opens with a block comment that names the file and
explains what it does, why it exists, and which concept it teaches.
This is enforced:

```bash
npm run audit-comments
```

It checks that a header exists, names its file, and is long enough to
be an explanation rather than a label. It cannot judge quality — that
part is on you.

Inline comments follow the same spirit. Explain **why**, and especially
explain the trap: several comments in this repo exist specifically to
stop a bug from being reintroduced (see the dialog click handler in
`public/app.ts`, and the path-resolution ordering in
`server/tools/definitions/read-file.ts`). Do not delete a comment like
that because the code "looks obvious" — the comment is why it looks
obvious.

When you change behaviour, update the comment that describes it in the
same edit. A stale explanation is worse here than no explanation.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start on port 3000, restart on save (`tsx`) |
| `npm run typecheck` | **Both** halves — server and client |
| `npm run build` | Compile both halves into `dist/` |
| `npm run audit-comments` | Verify every file has a header |
| `npm run check-env` | Inspect `.env` only (see below) |

Before finishing any change, run `npm run typecheck` and
`npm run audit-comments`. Both are fast.

## Architecture

Two halves with a hard boundary between them:

- `server/` — Express, the Anthropic SDK, the API key, tool execution.
- `public/` — the browser. Compiles **in place** (`public/app.ts` →
  `public/app.js`), which is why `public/*.js` is git-ignored.
- `shared/types.ts` — the wire contract, imported by both so they
  cannot disagree about what crosses the connection.

The client `tsconfig` sets `"types": []` deliberately, so server
globals like `process` cannot be referenced from browser code even by
accident. Do not "fix" that by adding `node` types.

The frontend import graph runs one way: `app.ts` imports from
`log.ts`, `settings.ts` and `transcript.ts`; `settings.ts` imports
`appendLog` from `log.ts`; **nothing imports `app.ts`.** Keep it
acyclic.

## The API key

Lives in `server/api-key.ts`, held in memory for the life of the
process, set through the app's Settings dialog. An optional
git-ignored `.env` can seed it at startup.

Rules that are not negotiable:

- **Never send the key to the browser.** The only key endpoint that
  returns anything returns a masked hint (`sk-ant-…7gAA`) and a
  boolean. There is deliberately no route that returns the value.
- **Never store it in `localStorage`**, a cookie, or any file. The
  whole point of routing chat through a server is that the browser
  cannot hold the key.
- **Never log it.** Log the masked hint if you must log anything.

`server/anthropic.ts` exports `client` as a `Proxy`, not an `Anthropic`
instance. That is what lets the key arrive after startup and change at
runtime while every call site still reads `client.messages.create(...)`.
If you need the real client, call `getClient()` inside that module —
do not reintroduce a module-level `new Anthropic()`, which would
capture whatever key existed at import time.

Scripts in `scripts/` are separate processes with no browser, so they
read `ANTHROPIC_API_KEY` from `.env` and cannot see a key set in
Settings. `npm run check-env` inspects `.env` only — a passing app and
a failing `check-env` is a normal, consistent state.

## MCP tools

The app can connect to an MCP server (Settings → Tools → Connect an
MCP server), and that server's tools then appear in the Tools tab
badged `mcp`, alongside the local ones.

The design rule that makes this cheap: **the tool loop was not
changed to accommodate them.** A remote tool is adapted into a
`LabTool` and goes in the same list, so from the model's point of
view — and from `tool-runner.ts`'s — there is no second kind of tool.
That it did not need changing is the lesson; keep it that way.

Three things are load-bearing:

- `LabTool.inputSchema` is a **`SchemaLike`**, not a `z.ZodType`. It
  names the only two operations this app performs on a schema
  (`toJsonSchema`, `safeParse`). Tool files still write plain
  `z.object({...})`; `defineTool` adapts it. An MCP tool carries the
  server's JSON Schema **verbatim** — there is deliberately no
  JSON-Schema-to-Zod converter, because a lossy one fails silently as
  a tool that rejects valid arguments.
- `toApiTool` **deep-clones** before editing. It deletes keys, and a
  remote tool returns the same schema object every call, so editing
  in place would strip the bounds permanently on the first request.
- `findTool()`, not `TOOLS_BY_NAME`. The Map is fixed at import time
  and cannot see a tool that arrived over a connection.

`server/tools/registry.ts` and `server/mcp/client.ts` import each
other. The cycle resolves only because **neither calls the other at
module load**. A top-level call on either side breaks it.

A remote tool whose name is already taken is **dropped**, the local
one kept, and the clash reported in Settings and as a `warn` row. It
cannot be an error: the tools are not ours and cannot be renamed.

## Model IDs

`MODEL` is defined in `server/anthropic.ts` and used by
`scripts/hello-claude.ts`. The app's own per-role model ids — the
`deciding`, `producing` and `judging` roles the patterns read — live
in `server/models.ts`.

**Model IDs are complete as written — never append a date suffix**,
which returns a 404. Pricing in `server/usage.ts` is hard-coded and
will go out of date; it is illustrative, not authoritative.

## Security invariants

These are load-bearing. Changing one is a deliberate decision, not a
refactor:

- Model output renders with `textContent`, **never** `innerHTML` —
  including inside the hand-written Markdown renderer, which exists
  precisely so no third-party renderer can introduce an injection.
- `read_file` resolves to a canonical absolute path **then** checks it
  is still inside the sandbox. That ordering is what defeats `../`;
  reversing it reintroduces the traversal.
- The app has no authentication and binds to localhost. It is not
  built to be exposed, and the key can now be set over HTTP, so
  exposing it hands over the key too.

## Style

- TypeScript is `strict`. Prefer narrowing over `as`; the existing
  casts are for DOM lookups and the SDK proxy, both unavoidable.
- ES modules with `.js` extensions on relative imports (`NodeNext`),
  including from `.ts` files. This looks wrong and is correct.
- Line endings are LF, enforced by `.gitattributes`.
- Error handling matches on SDK **error classes**, never on message
  text — wording changes between versions, classes do not. Order the
  `instanceof` checks specific-to-general: every SDK error is also an
  `APIError`, so testing that first swallows everything.

## Documentation to keep in sync

Changing setup, routes or counts means updating:

- `README.md` — setup, scripts table, project layout, security notes
- `index.html` — the stat strip, dependency table, route count
- `.env.example` — if env handling changes

`docs/build-plan.html` is a historical record of how the app was
built, kept deliberately as an artifact of the process. Leave its
`.env`-era references alone; they were accurate when written. It is
also served by Pages, so keep it a valid HTML document.

## GitHub Pages

`index.html` is the project overview, published at
<https://cjsharp1.github.io/anthropic-chat-lab/> and served from the
repo root on `main`. It carries that name, rather than a more
descriptive one, because Pages serves it as the site root.

Editing it changes a live page, so keep its stat strip and dependency
table accurate — they are checkable claims, and the counts have gone
stale before.

It is a complete HTML document: doctype, `<html lang>`, `<head>` with
`<meta charset="utf-8">`, `<body>`. Keep it that way. Served over HTTP
without a doctype it renders in quirks mode, and without the charset
the browser guesses windows-1252 and every em-dash becomes mojibake —
both of which this file did before it was published.
