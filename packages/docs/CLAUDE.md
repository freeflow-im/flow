# MCP Docs

An editor for office files and more: spreadsheets, presentations, documents, Markdown, CSV, PDFs, pictures
and videos, with a built-in AI assistant, and an MCP server so other agents can work on the same files. One
codebase ships as three products (names in `shared/brand.ts`):

- **MCP Docs on the web**, the hosted app at mcpdocs.freeflow.im (docs.freeflow.im serves it too, as the ChatGPT
  plugin's server address): accounts, files stored on the server.
- **MCP Docs**, the desktop app (`desktop/`, Electron): the same server and client over a folder of real
  Word, PowerPoint, Excel, Markdown and CSV files, and an MCP server for agents on the machine (Claude Code).
- **Universal Docs in ChatGPT**, the ChatGPT plugin (`plugin/`): model tools and a web view, on the hosted app. It
  keeps the name it was submitted to OpenAI under until its review is done; everything else is MCP Docs.

React + Vite client, Fastify server, SQLite via `node:sqlite`. The server runs TypeScript directly with Node's
type stripping; imports use `.ts` extensions.

**How each area works is in `docs/architecture.md`** (one section per area, with the files and names to look
for). Read the part you are changing before you change it, and keep it up to date when you change how something works.

## Where things are

- `client/src` — the React app: `pages/` (one per editor and the home page), `components/` (shared UI, `FileLibrary`
  is the file list), `state/` (spreadsheets: `WorkbookStore`, `SheetController`, `ops.ts`), `deck/` (presentations),
  `doc/` (documents, on ProseMirror), `markdown/`, `chart/`, `image/` (the image editor), `pdf/` (viewing and signing),
  `find/` (⌘F), `agent/` (the assistant's panel and the tools that run in the browser).
- `server` — the Fastify API (`app.ts`), storage (`sheets.ts` for every kind of document, `files.ts` for stored files,
  `folders.ts`, `recents.ts`, `favorites.ts`), the desktop app's folder-backed stores (`localStore.ts`), Office import and
  export (`*Import.ts`, `docxExport.ts`, `xlsxCharts.ts`), PDFs (`pdf.ts`, `pdfMarkdown.ts`), the desktop MCP server
  (`localMcp.ts`, `windowTools.ts`) and the assistant (`server/agent`).
- `shared` — code used by both: the formats (`types.ts` workbooks, `deck.ts`, `doc.ts`, `markdown.ts`, `chart.ts`,
  `csv.ts`), the formula engine, `folders.ts`, and the assistant protocol (`shared/agent`).
- `desktop/` — Electron (`main.js`, which starts `desktop/server.ts` per folder; `mcpAuth.js`, `updater.js`).
- `plugin/` — the ChatGPT plugin's server (`plugin/server`, its MCP tools, also served by the desktop app) and web view.
- `claude-plugin/`, `installer/` — the Claude Code / Codex plugin and the `npx @freeflow-im/mcp-docs` installer.

## Working on it

- Checks: `npm run typecheck` and `npm test` (vitest). Both must pass before a change is finished.
- Run the desktop app: `npm run desktop -- <folder>` (builds the client first). `node desktop/server.ts` with
  `LOCAL_DIR`, `DATA_DIR` and `PORT` serves one folder to a browser, without Electron. Rebuilding the client
  (`npx vite build`) needs that server restarted.
- Formatting: long lines (up to ~230) and single quotes. Do not run Prettier with its defaults over a file; it rewraps all of it.
- Pushing to main deploys the hosted app (`.github/workflows/aws-deploy.yml`).
- A desktop release: write `release-notes/<version>.md`, run `npm run release -- <version>` (sets every version,
  commits and tags `desktop-v<version>`), then `git push origin main desktop-v<version>`. The tag runs
  `.github/workflows/desktop-release.yml`: the Mac and Windows builds (their tests run on Windows too), the GitHub
  release and the installer on npm.

## How the assistant works

The server runs the Claude loop (`server/agent/agent.ts`). Tools are defined once as Zod schemas in
`server/agent/tools.ts`; the server validates every tool input and sends the JSON Schema to Claude. Each file
has its own chat. A user can run it on their own Anthropic, OpenAI or OpenRouter key; in the desktop app it can
run on the user's own Claude Code instead (`server/agent/claudeAgent.ts`). `web_search` and `image_search` use
Brave Search (the user's key from Settings, else `BRAVE_SEARCH_API_KEY`), else the model provider's own web search
(`server/agent/llmSearch.ts`). Details in `docs/architecture.md`.

Two kinds of tools:

- **Browser tools** act on the open file. The server pauses the turn, the browser runs the tool against the
  live editor (so edits render, autosave and undo like the user's own), and posts the result back.
- **Server tools** act on the account (list/read/create files) and run in `runServerTool`.

## How to add an assistant tool

Follow the existing tools as examples (`set_filter` and `sort_range` are good small ones). A new tool
touches these places:

1. **Schema** — add a Zod object to `schemas` in `server/agent/tools.ts`. Describe every field and the tool
   itself: the descriptions are what Claude reads. Reuse the shared `tab`, `range`, `column` and `row` fields.
2. **Kind** — for a browser tool, add its name to `CLIENT_TOOLS` in `shared/agent/protocol.ts`. A server tool
   instead gets a `case` in `runServerTool` in `server/agent/tools.ts`.
3. **Implementation** (browser tools) — add a `case` to `runClientTool` in `client/src/agent/clientTools.ts`.
   Resolve tabs and ranges with `tabOf` / `rangeOf`, make every change inside `run((tx) => ...)` so it is
   undoable as part of the agent's step, call `show(ctl, tab.id)` so the user sees the tab you changed, and
   return a small JSON string describing what happened. Throw `ToolError` with a helpful message for anything
   Claude should fix (bad range, missing tab, and so on). Tools that act on the open presentation go in
   `client/src/agent/deckTools.ts` instead (add the name to `DECK_TOOLS` there) and use the `DeckController`
   (`ctl.runAgent(group, (tx) => ...)`), with tests in `deckTools.test.ts`. Tools that act on the open
   document go in `client/src/agent/docTools.ts` (add the name to `DOC_TOOLS`) and build one ProseMirror
   transaction with `ctl.runAgent(group, (tr) => ...)`, with tests in `docTools.test.ts`.
   If the action is destructive (deletes data the user cannot easily recover), add a question for it to
   `confirmationFor` in the same file.
4. **Label** — add a `case` to `toolLabel` in `client/src/agent/describe.ts` (the one-line label in the chat,
   e.g. "Sorted A1:D10 by column B").
5. **Test** — add a test to `client/src/agent/clientTools.test.ts` (browser tools) or `server/agent.test.ts`
   (server tools) that calls the tool and checks the workbook.
6. **Prompt** — only if Claude needs guidance on when to use the tool, add a line to `SYSTEM_PROMPT` in
   `server/agent/prompt.ts`. Keep the prompt free of anything that changes between requests.

Workbook model reminders (`shared/types.ts`): tabs hold sparse `cells` keyed by A1 address; `Tab.filter` is
a `FilterState` with the filtered range and per-column criteria keyed by absolute column index (`hidden`
display values and/or a `cond`); rows hidden by a filter are computed in `ops.ts`.

## Rules for automated changes

When a change is made by the assistant's coding job (see `server/agent/worker.ts`):

- Make the smallest change that fully implements the request, following the patterns above.
- Do not modify `CHANGELOG.md` (the job writes it), `data/`, `.env*`, `server/auth.ts`, or anything under
  `server/agent/` other than `tools.ts` and `prompt.ts`.
- Do not commit. The job commits, opens a pull request and merges it after the checks pass.
- Run `npm run typecheck` and `npm test` and fix any failures before finishing.
