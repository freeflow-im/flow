# MCP Docs Features

- Built-in PDF parsing (OCR) to markdown
- Edit: Excel, Powerpoint, Docx files
- Edit: PDF, Image, and HTML files
- Live Markdown preview
- Full Agentic editing of files
- Slides embedding support: images, videos, HTML pages, PDF
- PDF signing support, plus ad-hoc editing
- Image editing: remove background, composting, etc...
- JSON viewer and editor
- Open multiple folders and files

# MCP Docs

![PowerPoint](https://img.icons8.com/color/48/microsoft-powerpoint-2019--v1.png) ![Word](https://img.icons8.com/color/48/microsoft-word-2019--v1.png) ![Excel](https://img.icons8.com/color/48/microsoft-excel-2019--v1.png) ![PDF](https://img.icons8.com/color/48/pdf.png) ![Images](https://img.icons8.com/color/48/image.png)

[![Download MCP Docs for macOS](https://img.shields.io/badge/Download-macOS%20%28Apple%20silicon%29-2ea44f?logo=apple)](https://github.com/freeflow-im/mcp-docs/releases/latest)
[![Download MCP Docs for Windows](https://img.shields.io/badge/Download-Windows%20%28x64%29-0078d4?logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0wIDBoNy41djcuNUgwek04LjUgMEgxNnY3LjVIOC41ek0wIDguNWg3LjVWMTZIMHpNOC41IDguNUgxNlYxNkg4LjV6Ii8%2BPC9zdmc%2B)](https://github.com/freeflow-im/mcp-docs/releases/latest)
[![npm](https://img.shields.io/npm/v/@freeflow-im/mcp-docs?label=npx%20%40freeflow-im%2Fmcp-docs)](https://www.npmjs.com/package/@freeflow-im/mcp-docs)


MCP Docs is universal document editor, built with "native" AI integration. It started as sort of my own rewrite of Google Docs - but now its some kind of combination of Office suite, Google Docs, Sublime Text and Mac _Preview_. 

It runs locally on your computer, but also runs in the cloud - you can access the cloud version from either the local app or just a browser.

![MCP Docs presentation editor showing a scaled dot-product attention diagram](docs/images/presentation-editor.png)

![MCP Docs spreadsheet editor showing recent YC batch companies](docs/images/spreadsheet-editor.png)

It supports editing all the standard Office documents:
- Spreadsheets (Excel)
- Slides (Powerpoint)
- Documents (Word)

But also offers quite capable editing for:
- Images (including background removal)
- HTML files
- PDF Files
- Markdown and text files
 
The app is a bit of a "bridge" between traditional productivity suites and the AI agents world.

## Using *MCP*

MCP Docs offers two **_agent_** experiences:
1. A built-in assistant available "in situ" that sits next to the current doc for editing:

![MCP Docs spreadsheet with the built-in assistant sorting companies by location](docs/images/assistant-sort.png)

2. Any external agent can connect to the MCP server and drive the application:

![External agent converting a monthly budget into a startup company budget in MCP Docs](docs/images/external-agent-budget.png)
_Codex driving the MCP Docs app_

For the internal _assistant_, you can provide either an LLM API key, **OR** you can connect your local coding agent (Codex or Claude). This second mode is convenient to take advantage of your existing coding agent setup and subscription, although the latency is a little higher than the built-in assistant.

## Features

Besides editing standard Office files (don't need to pay for Office!), and using the AI integration to supercharge your editing, some other interesting features include:
- Excellent PDF OCR parsing (_Convert to markdown_) using [liteparse](https://github.com/run-llama/liteparse) from LlamaIndex 
- PDF signing and editing support, similar to _Preview_
- Live Markdown preview
- JSON tree viewer

But probably the biggest feature is **open source** - add your own new features as you need them.

### Single-player

Current version of MCP Docs is "single player" - document sharing is coming later.


## Install

```
npx @freeflow-im/mcp-docs
```

This downloads the latest MCP Docs into `/Applications` (on Windows it runs its setup program, which installs it for
you), offers to install the **mcp-docs** plugin (the app's MCP
server and a skill on using it) into Claude Code and Codex, whichever you have, starts the app, and prints the app's
MCP address for any other client. Run it again to update everything. `--claude` or `--codex` picks the agents without
asking, `--yes` takes every one found. You can also download the app
from the [latest release](https://github.com/freeflow-im/mcp-docs/releases/latest) (`MCP-Docs-<version>-mac-arm64.zip`
for a Mac, `MCP-Docs-<version>-win-x64-setup.exe` for Windows); its notes say how to install it by hand. It
needs a Mac with Apple silicon or Windows (x64).

## Uninstall 

```
npx @freeflow-im/mcp-docs --uninstall
```
 removes the app, its data and settings, and agent config.

## Connect your coding agent

While the app runs it is an MCP server at `http://127.0.0.1:39217/mcp` (Streamable HTTP).

- **Claude Code**: the installer adds the plugin. Restart Claude Code, run `/mcp`, choose `plugin:mcp-docs:mcp-docs`
  and sign in; MCP Docs asks you to allow it. In Claude Code the plugin alone is
  `/plugin install mcp-docs --marketplace freeflow-im/mcp-docs`, or add the server without it:
  `claude mcp add --scope user --transport http mcp-docs http://127.0.0.1:39217/mcp`.
- **Codex**: the installer adds the same plugin from the repository's Codex marketplace (`.agents/plugins/marketplace.json`).
  Sign in once with `codex mcp login mcp-docs` and start a new session; MCP Docs asks you to allow it. By hand:
  `codex plugin marketplace add freeflow-im/mcp-docs` and `codex plugin add mcp-docs@mcp-docs`.
- **Any other MCP client**: point it at the same address. It signs in with OAuth 2.1 (dynamic client registration
  and PKCE, as MCP clients do), and MCP Docs shows a dialog asking you to allow each client; nothing is typed into a
  browser.
- **File › Connect an Agent (MCP)…** (or the **Connect your agent** tile on the home page) shows the address and the
  command, lists the agents connected and disconnects them.

An agent gets about 60 tools: list, search, open, create, rename, move and delete files and folders; read and edit
documents (as Markdown), presentations (slides, their elements and themes; `render_slide` shows it a slide as drawn)
and spreadsheets (cells, formulas, formatting, sorting, filters, rows, columns and tabs); read PDFs as Markdown or
convert them; look at and edit pictures, background removal included; import files from the web, or upload them from
disk.

- **You see what it does.** A file it opens is shown in the window, and its edits to the file open there are made in
  the editor: they appear as they happen, one ⌘Z undoes its whole run, your own unsaved edits are kept, and deleting
  rows, slides or blocks asks you first.
- **The open file is the default.** With no id, the tools act on the file shown in the app, and see your selection.
- **The folder is the library.** The files are the real files on disk, saved back in their own format.

## The assistant in the app

**Assistant** in the header (or **⌘K**) opens a chat panel beside the file. **Settings** (File › Settings…, ⌘,)
chooses what powers it:

- **Use an API key**: Anthropic, OpenAI or OpenRouter, with your key, billed for each use to your account there. On
  the first run a key already set in your login shell (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`)
  is used.
- **Use a local coding agent**: the Claude Code installed and signed in on your Mac runs the assistant, in the open
  folder with all of its own tools and settings, on your Claude plan. Routine steps go ahead on their own; it asks in
  the panel only when it is unsure.

Each file has its own chat, and the home page has one. See [Assistant](#assistant) for how it works.

## Using the app

The folder's files are the file list and its directories are the library's folders (see Folders below; hidden entries and `node_modules` are skipped). A file's name in the list is its whole file name, extension included: the app never hides one. **File → Open Folder…** switches to another folder. Your folders need no account and nothing to sign in to; your web files do (see Your web files below).

- Markdown (`.md`) and CSV (`.csv`) files open in their editors and are saved back as the plain text they are.
- Spreadsheets, presentations and documents are Excel, PowerPoint and Word files (`.xlsx`, `.pptx`, `.docx`), edited in place; new ones are made as those too, and a CSV file that outgrows CSV becomes an `.xlsx` file. A file made elsewhere that holds something the app can't keep opens read-only until you allow editing, and the first save over it keeps a copy in the app's trash. Only a file its Office format cannot hold (a picture in a cell, a gradient, a video in a document) is kept in the app's own format (`.ffsheet`, `.ffslides`, `.ffdoc`), after asking.
- PDFs and images open in a preview, and videos (`.mp4`, `.m4v`, `.mov`, `.webm`, `.ogv`) in a player.
- Renaming a file in the app renames it on disk, and **Move to…** moves it into another directory. Deleting moves the file out of the folder into the app's data directory (`trash/`), not the system trash.
- A file changed by another program while it is open in the app is not overwritten: the save is refused.

The app's own data for a folder (the assistant's chats, pasted images, branch snapshots, deleted files) is kept under its data folder (`~/Library/Application Support/MCP Docs/folders/` on macOS), not in the folder, so images pasted into a file are not part of the file. Its settings are kept there too, for every folder. The app talks to a server it starts on a loopback port (`desktop/server.ts`), which only answers the app's own windows and, through the MCP port, the agents you allowed.

## Developing

```sh
npm install
npm run desktop                 # build the client, then open the current directory in the desktop app
npm run desktop -- ~/Documents  # or a folder you name
npm link                        # once, to get the `mcp-docs-dev` command:
cd ~/Documents && mcp-docs-dev  # open the directory you are in (after `npm run build`)
npm test                        # vitest
npm run typecheck
```

Requires Node 22.18+. The server runs TypeScript directly through Node's built-in type stripping and uses the
built-in `node:sqlite`. `CLAUDE.md` explains the codebase.

On macOS the `mcp-docs-dev` command starts the app through LaunchServices, so the app itself (listed as Electron until
it is packaged) is what macOS asks about and grants access to Downloads, Documents and Desktop, not the terminal; a
folder it may not read shows a message saying so.

### Packaging and releases

`npm run desktop:win` builds the Windows app with electron-builder into `release/`: its setup program (`MCP-Docs-<version>-win-x64-setup.exe`), for x64. It can be run on macOS; there the `.exe` keeps Electron's icon (the release, built on Windows, has the app's). It is not code-signed, so Windows shows its "unknown publisher" warning on first run. `npm run desktop:pack` builds the unpacked app for the machine it runs on, to try the packaged layout.

The packaged app holds the server's TypeScript as plain files (`asar` is off), which Electron's Node runs as it does in development. Started from its icon it reopens the folder it showed last, or opens your home folder the first time; a folder can also be given on its command line. It reads no `.env`.

`npm run desktop:mac` builds the macOS app and its zip in `release/`. A release is made by GitHub Actions
(`.github/workflows/desktop-release.yml`):

1. Write what is new in `release-notes/<version>.md` (a Markdown list; `release-notes/template.md` adds the install
   steps).
2. `npm run release -- <version>` sets the version of the app, the Claude Code and Codex plugin (`claude-plugin/`), its
   Claude marketplace entry (`.claude-plugin/marketplace.json`) and the installer (`installer/`, the `@freeflow-im/mcp-docs`
   npm package), commits that and tags it `desktop-v<version>`.
3. `git push origin main desktop-v<version>`. The workflow checks and builds the app on Apple silicon and on Windows,
   makes the GitHub release with the Mac zip and the Windows setup program, and publishes the installer to npm
   (trusted publishing: no npm token or one-time code).

Running the workflow by hand (Actions › Desktop release › Run workflow) builds both without publishing anything; the
builds are kept as the run's artifacts for three days.

## Videos

A video file (`.mp4`, `.m4v`, `.mov`, `.webm`, `.ogv`) opens in a page with the browser's player. On the web, import one from the home page (the Import tile or a drop, 200 MB maximum); it is stored as the file it is, like a PDF. The server answers Range requests for stored files, so the player can seek without downloading the whole file. Whether a file plays depends on its codec: H.264 and VP8/VP9 play everywhere, while HEVC (the default of recent iPhones) does not play in every browser.

## Folders

The file list shows one folder at a time. **New folder** creates one inside the folder being shown, clicking a folder opens it, and the breadcrumbs over the list lead back up; the folder is part of the address (`/?folder=Reports/2026`). New and imported files go into the folder being shown, **Move to…** in a file's menu moves it, and a folder can be deleted once it is empty. Typing anywhere on the page filters the folder being shown; **Find files**, under the filtered list, looks for the same text in the names of files and folders in every folder (`GET /api/library/search?q=`) and shows where each match is. In the desktop app that walks the mounted folder level by level for up to a minute, and says so when a very large tree could not be covered; with a home directory mounted, its `Library` is left out. The search is part of the address too (`&q=plan`, and `&find=1` for Find files), and an open file's logo and breadcrumb links lead back to the list as it was, so the same results are there after looking at a file. Folders cannot be renamed or moved yet, and the assistant lists and creates files without regard to folders (what it creates lands at the top).

The switch over the files shows them as a list or as thumbnails (remembered per browser). A thumbnail is the image itself, a frame of a video, the first page of a PDF (drawn by pdf.js, loaded only then), or a small rendering of how a document, spreadsheet or presentation starts (`shared/preview.ts`, `GET /api/library/preview/:id`); each is fetched when its card scrolls into view. Excel, PowerPoint and Word files show an icon.

Clicking a file opens it in place, inside its folder: the page header shows the folders down to the file as breadcrumbs, each a link back to the file list there. The **Open ↗** button on a row opens the file in a new browser tab instead; in the desktop app that is a new tab of the window (macOS) or a new window.

On the server a folder is a row (`folders` table, `server/folders.ts`) and each file records the path of its folder; in the desktop app folders are the directories of the mounted folder. `GET /api/library?folder=` returns a folder's folders, documents and stored files.

## Layout

| Path | Contents |
| --- | --- |
| `shared/` | Workbook types, A1 helpers, value parsing and formatting, and the formula engine (tokenizer, parser, dependency-tracking evaluator, ~120 functions). Used by both client and server. |
| `server/` | Fastify API: auth (scrypt password hashes, hashed session tokens in httpOnly cookies) and sheet CRUD. |
| `client/src/state/` | `WorkbookStore` (patch-based undo/redo, incremental recalculation), `AutoSaver`, spreadsheet operations (`ops.ts`) and `SheetController` (selection, editing, clipboard and commands). |
| `client/src/grid/` | Canvas grid: virtualized rendering, frozen panes, hit testing, and the mouse and keyboard interaction. |
| `client/src/deck/`, `client/src/doc/` | The presentation and document editors (stores with undo/redo, controllers, views and toolbars). |

## Assistant

**Assistant** in the header (or **⌘K** / **Ctrl+K**) opens a chat panel on the right. Ask it in plain language to
read, write, edit, format, sort or restructure the open file, or to find, read, create and open others. It knows which
file, tab and selection you're looking at. In the desktop app it runs on your API key or your local coding agent (see
[The assistant in the app](#the-assistant-in-the-app)); in the web version it uses Claude Sonnet 5.5 through the
server's key by default (`AGENT_MODEL` switches it), and **Settings** lets a user use their own key instead, which is
then not counted against the daily limit.

- **Edits appear immediately** and save like your own. Everything the assistant changes for one message undoes as a
  single step with ⌘Z. Deleting tabs, rows, columns, slides or blocks, and clearing more than 100 cells, asks you first.
- **A chat for each file**, and one for the home page, kept across page loads. A reply stays in the chat it was asked
  in, even when the assistant opens another file. **New chat** starts that chat over (old conversations stay in the
  database).
- Click an action in the chat (such as "Wrote 8 cells at A1") to select that range.

Screenshots: paste, drop or attach images (PNG, JPEG, GIF, WebP; up to four per message) in the chat and the assistant sees them, for example to transcribe a table from a screenshot into the sheet. Images are downscaled in the browser and stored with the conversation.

How it works:

- The **server** (`server/agent/`) runs the agent loop and holds the API key, system prompt and tools. Conversations
  are stored in SQLite exactly as sent to the API and are only ever appended to. That keeps prompt caching effective
  and lets the model's thinking blocks be passed back unchanged.
- **Account tools** (`list_sheets`, `read_other_sheet`, `create_sheet`) run on the server.
- **File tools** (`read_range`, `write_range`, `insert_content`, `update_slide` and the others) run in the
  **browser**, on the open file (`client/src/agent/clientTools.ts`), so edits render, autosave and undo like any
  other edit. When the model calls one, the server streams the call to the browser and pauses; the browser runs it
  and posts the result back, and the loop continues.
- Every request carries the current context: the page, the file, its tabs or slides, and the selection. It's added in
  front of the user's message, so the system prompt stays cacheable.
- Tool inputs are checked against Zod schemas (`server/agent/tools.ts`) before anything runs. The same schemas
  generate the JSON Schema sent to the model.
- With a **local coding agent** (desktop app), each message is a Claude Agent SDK query on the user's own Claude Code
  (`server/agent/claudeAgent.ts`), which works through the app's MCP server, so its edits go through the window like
  any MCP agent's.

## Presentations

**Blank presentation** on the home page creates a slide deck (`/d/<id>`). A slide is a fixed 960×540 canvas (PowerPoint's 16:9 size) holding text boxes, images and shapes (rectangles, ellipses, triangles, diamonds, polygons, stars, arrows, chevrons, speech bubbles, hearts and lines; the table in `shared/shapes.ts` also maps each one to its PowerPoint preset). Slides are made from **layouts** (title, section header, title and body, two columns, title and image, blank), and a deck has a **theme** (light, dark, ocean, forest, sunset, paper) that sets its colors and fonts.

- Click a slide in the strip on the left to edit it; drag to reorder; right-click for slide commands. Double-click a text box or shape to edit its text; **Tab** indents a bullet. Drag elements to move them and use the handles to resize (corner handles keep an image's aspect ratio). Arrow keys nudge, **Delete** removes, ⌘D duplicates, ⌘C/⌘V copy and paste elements, and ⌘Z undoes.
- **Insert → Image…**, dropping an image file on the slide, or pasting one adds an image element (stored like cell images).
- **Present** (F5) shows the deck full screen; arrow keys and clicks move between slides, **N** shows the speaker notes and the next slide, and Esc leaves.
- **File → Download as PowerPoint (.pptx)** exports the deck (text with bullets, images, shapes, backgrounds and notes) with pptxgenjs in the browser; **File → Print / Save as PDF…** lays out one slide per page.
- **PowerPoint import**: drop a `.pptx` on the home page (or use the Import tile) to create a presentation from it, or **File → Import PowerPoint slides…** inside a deck to add its slides after the current one. The conversion runs on the server (`server/pptxImport.ts`) and keeps text boxes with bullets, per-paragraph sizes, weights and colors, fonts, line and paragraph spacing, alignment and insets, theme colors, translucent fills and outlines, pictures (PNG, JPEG, GIF, WebP), shapes (text on a filled shape becomes a text element on top of it), horizontal and vertical lines, solid slide backgrounds and speaker notes. Fonts that are on Google Fonts (Inter, Poppins, Montserrat, ...) are loaded when a deck uses them. Tables, charts, SmartArt, other picture formats, gradients and picture backgrounds are dropped and listed in a banner.
- Speaker notes live under the slide.

The assistant edits presentations too: `read_deck`, `add_slides` (layout plus plain content), `update_slide` (change the title, body, notes or layout of one slide), `edit_elements` (move, resize, restyle, add or remove elements), `delete_slides`, `move_slide` and `set_deck_theme` run in the browser against the open deck, and `list_decks`, `create_deck` (optionally with all its slides) and `open_deck` find, create and open decks. "Turn this spreadsheet into a short presentation" reads the sheet, creates the deck and opens it.

Decks are stored like spreadsheets (`shared/deck.ts` is the format; the `sheets` table has a `kind` column) and are listed with them on the home page. Branches and compare are for spreadsheets only.

## Documents

**Blank document** on the home page creates a text document (`/doc/<id>`): a WYSIWYG editor for writing, built on ProseMirror. A document is a sequence of blocks (paragraphs, a title and subtitle, headings, bulleted and numbered lists, quotes, code blocks, images and horizontal rules) whose text can be bold, italic, underlined, struck through, code, linked, colored or highlighted, set in another font or size (the toolbar lists system fonts and a set loaded from Google Fonts), and aligned left, center, right or justified.

- The toolbar and the **Format** menu set the paragraph style and text formatting; the usual shortcuts work (⌘B/I/U, ⌘⇧X strikethrough, ⌘E code, ⌘K link, ⌘⇧7/8 lists, ⌘⌥0–3 paragraph and headings, ⌘⇧L/E/R/J alignment, Tab and ⇧Tab to indent list items). Typing `# `, `- `, `1. `, `> `, ```` ``` ```` or `---` at the start of a line turns it into the matching block, and a web address followed by a space or Enter becomes a link.
- **Insert → Image…**, pasting or dropping an image adds an image block (stored like cell images); drag its corner handle to resize it, and use the alignment buttons to place it. Clicking into a link shows a small card with the address (click it to open in a new tab), Edit and Remove; ⌘-click a link to open it directly.
- Every edit is a command (a ProseMirror transaction whose steps know how to invert themselves), recorded by `DocStore` (`client/src/doc/store.ts`): ⌘Z undoes a run of typing, or everything the assistant changed for one request, as a single step. Changes save automatically.
- **File** downloads the document as Markdown or as a web page, or prints it (Save as PDF).
- **Document style** (Format → Document style…): the default font, body size, line spacing and space after paragraphs, stored on the document and used by all text without a font or size of its own; headings scale with the body size. Format → Line spacing sets the spacing of the selected paragraphs.
- **Pages**: a document is paginated by default (View → Pages; View → Pageless gives one continuous column). Format → Page setup… sets the paper size (Letter, Legal, A4), orientation, margins, page numbers, and a header and footer (`{page}` and `{pages}` are replaced). Insert → Page break (⌘⏎) starts a new page. The editor stays one continuous column; `client/src/doc/pagination.ts` measures where lines and blocks land and inserts spacer decorations at page boundaries (whole images and rules move, paragraphs split between lines, and headings stay with the block after them), and the page frames, numbers, header and footer are drawn from the same result. Printing in Pages mode lays out one page per sheet from the same measurements, so the printout matches the screen. View → Zoom fits the page to the window or sets a percentage. A rail on the left shows a thumbnail of every page with the current page highlighted; click one to jump to it, drag its edge to resize it, and collapse it with the arrow (or View → Page thumbnails).
- **Word import**: drop a `.docx` on the home page (or use the Import tile) to create a document from it, or **File → Import Word document…** inside a document to add its content after the cursor. The conversion runs on the server (`server/docxImport.ts`) and keeps the document's default font, size, line and paragraph spacing (as the document style), paragraph styles (title, subtitle, headings, quotes) with their fonts and sizes, paragraph spacing, bulleted and numbered lists with nesting, bold, italic, underline, strikethrough, colors, highlights, fonts and sizes, hyperlinks, line breaks, page breaks, pictures, and the page size, orientation and margins. Tables become one paragraph per row; headers, footers, footnotes, comments, charts and SmartArt are dropped and listed in a banner.

The assistant edits documents too. It sees a document as numbered blocks in Markdown (`read_doc`) and writes Markdown back: `insert_content`, `replace_blocks` and `delete_blocks` work on whole blocks, `replace_text` changes words in place, `format_text` makes text bold, italic, underlined, colored, highlighted or a link without retyping it, `format_blocks` changes a block's kind or alignment, `insert_image` adds a picture, `set_page_setup` changes the page setup, `set_doc_style` changes the document's default font, size and spacing, and `\newpage` in Markdown is a page break. `list_docs`, `create_doc` (with the content as Markdown), `read_other_doc` and `open_doc` find, create, read and open documents. Deleting blocks, or replacing ten or more at once, asks for confirmation.

The file format (`shared/doc.ts`) is the ProseMirror JSON of the document under a schema that is the single definition of what a document may contain; `shared/docMarkdown.ts` converts documents to and from Markdown (plus `# text {.title}`, `## text {.subtitle}`, `<u>`, `<mark>` and `<span style="color: …; font-family: …; font-size: 14pt">` for what Markdown cannot say), and the server validates every save against the schema.

## Branches

**File → Create branch…** (or **Create branch** in a spreadsheet's menu on the home page) makes a branch: a copy you can edit freely that stays connected to its original. Branches are listed under their original on the home page.

In a branch, **Compare with original** opens a three-way comparison. When the branch is created, a snapshot of the original is saved as the *base* (`data/sheets/<id>.base.json`). Each difference is then labeled by who made it:

- **Yours** (green): changed in your branch since it was created.
- **Original** (purple): changed in the original since then.
- **Conflict** (red): changed differently on both sides. Identical changes on both sides don't show.

Changed cells are tinted on the grid, and hovering one shows the base, your and the original's values. Rows that exist only on the other side are drawn as a line where they would be. The side panel lists every change; click one to jump to it. The comparison updates as you edit, and **↻** fetches the original's latest state.

How the comparison works (`shared/diff.ts`):

- **Rows** are aligned with a Myers diff (the algorithm behind `git diff`), so an inserted or deleted row is one change rather than every row below it. Columns are compared by position.
- **Formulas** are rewritten into the base's row numbers and sheet IDs before comparing. Formulas that the app adjusted because of row inserts, deletes or sheet renames don't show as edits.
- **Detached branches:** if the original is deleted, the branch keeps working and compares against the base.

## Your web files

Beside the folders on your computer, the app shows your MCP Docs account on the web (mcpdocs.freeflow.im) in a **Web tab**, in the same window. The **Local | Web** switch beside the logo goes from one to the other (**File → Open Web Tab** too), and each tab's title ends in "— Local" or "— Web". The two are separate libraries: nothing syncs, and a copy is a new file.

- **Signing in:** only when you first open a Web tab. Email and password sign in inside the tab; **Continue with Google** finishes in your browser, and the tab signs itself in a moment later. **File → Sign Out of Web** signs out.
- **Upload to Web…** (a file's ⋮ menu in a folder) copies it into one of your web folders, pictures and all.
- **Download to Folder…** (a file's ⋮ menu in a Web tab) copies a web file into a folder on your computer as a Word, PowerPoint or Excel file, in the app's own format (which keeps everything), or as a PDF; the dialog says what an Office file would not keep. On the web in any browser the same item is **Download to MCP Docs**, which opens the app's dialog.

Developing, a Web tab can point at a local server instead: start the app with `UNIVERSAL_WEB_URL=http://localhost:5173`. How it works is in `docs/web-and-pdf.md`.

## PDFs

**File → Download as PDF** in a document, presentation or Markdown file, and **Download as PDF** on a saved web page (or in a file's ⋮ menu), downloads it as a PDF laid out as it prints: documents with their page setup, one slide per page, Markdown as its preview with diagrams drawn. Agents can make one with `export_pdf`, which keeps the PDF next to the file. The desktop app prints them itself; the web version needs Chromium (see below).

## Find

Press **⌘F** (Ctrl+F on Windows and Linux), or use **Edit → Find…**, to open the find bar. Inside a spreadsheet it replaces the browser's page search.

- Search runs as you type, highlights every match, and jumps to the nearest one.
- **Enter** and **Shift+Enter** step through matches, and **Esc** closes the bar.
- Options: match case, match the entire cell, also search formula text, and search all sheets.
- It matches values as displayed (for example `$1,500`) and skips rows hidden by a filter.

## Excel import

There are two ways to import an Excel workbook:

- **Home page** (the **Import Excel** tile, or drop a file on the page): creates a new spreadsheet from the file.
- **File → Import Excel file** inside a spreadsheet: adds the file's sheets as new tabs after the existing ones, as one undoable change. Sheets whose names are already taken get a number added (`Summary` → `Summary 2`), and references between the imported sheets are updated to match.

The conversion runs on the server (`server/xlsxImport.ts`). `.xlsx` files are read with ExcelJS. Older `.xls` files are first converted to `.xlsx` with SheetJS (pinned to 0.20.3 from the vendor's CDN, because the npm copy is outdated), so only their values, formulas, number formats and column widths carry over, not fonts, colors or alignment. The format is detected from the file contents, not the extension. For `.xlsx` files it keeps:

- values, formulas (including shared formulas), dates, and text that looks like a number (such as `001`)
- bold, italic, underline, strikethrough, text and fill colors, alignment and number formats
- column widths, row heights, frozen panes, the filter range, and multiple sheets with the references between them

Features the app doesn't support are reported in a banner after import: unsupported functions (shown as `#NAME?`), table references or links to other files (shown as `#ERROR!`), merged cells (unmerged, with the value kept in the top-left cell) and hidden sheets. Charts, images, comments, conditional formatting, data validation and filter criteria are dropped. Uploads are limited to 20 MB, 300 MB uncompressed and 1 million cells.

## CSV files

Drop a `.csv` file on the home page (or use the Import tile) and it opens in the spreadsheet editor as the CSV file it is: one sheet of plain values, listed with type **CSV** and marked with a CSV badge next to its name. Edits are saved back as CSV text (`shared/csv.ts`), keeping the file's line endings; formulas are stored as typed (`=B2*2`) and still calculate. **File → Download → Comma-separated values** gives the file back.

CSV cannot hold formatting, images, column widths and row heights, frozen rows and columns, filters, sheet names or a second sheet. Using one of these asks to convert the file to a spreadsheet first (also **File → Convert to spreadsheet…**), then makes the change. Converting keeps the same file and content; it can still be downloaded as CSV afterwards. The assistant works on a CSV file like on any spreadsheet, and tells you when what you asked for needs the conversion. Imports are limited to 10 MB.

Inside a spreadsheet, **File → Import CSV file…** adds a CSV file as a new sheet, and **File → Save a copy as CSV file…** saves the current sheet as a new CSV file in the app, with the values as shown and without formatting, formulas, images or the other sheets. The home page menu of a spreadsheet has **Download as CSV** for its first sheet.

## Connectors

The **Connectors** page (from the home page, or File > Data connectors… in a sheet) connects external data
sources, starting with **Brex** (card and cash transactions, cash accounts, cards, users, expenses, budgets).
For Brex, paste a read-only user token from the Brex dashboard (Developer > User Tokens). The token is tested,
stored encrypted (key from `CONNECTOR_ENCRYPTION_KEY`, or one generated in `data/connector.key`) and never
shown again. The assistant can then pull data in: "ingest my Brex card transactions from the last 30 days into
a tab called Brex" calls `list_connections` and then `ingest_connector_data`.

See [docs/connectors.md](docs/connectors.md) for how it works and how to add a connector or dataset (API key or
OAuth 2.0).

## Web version

The same app runs as a web service with accounts (`npm run dev`, or `npm run build && npm start`), hosted as
MCP Docs at docs.freeflow.im, where it is also a plugin for ChatGPT (`plugin/`, named Universal Docs there). The desktop app
shows it in its Web tabs (see Your web files).

```sh
npm run dev        # API on :3001 and Vite on :5173; open http://localhost:5173
npm run build && npm start   # production: serves dist/client and the API on :3001
```

Users register and sign in with email and password (verified by an emailed link) or with Google.

Password reset: **Forgot your password?** on the sign-in page emails a one-time link (valid for an hour) that opens `/reset` to set a new password and signs the user in; other sessions are signed out. Email goes through Cloudflare Email Service when `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set (`MAIL_FROM` must then be an address on a domain verified for sending in that account), else through Resend when `RESEND_API_KEY` (and optionally `MAIL_FROM`) is set; otherwise the message, link included, is written to the server log, so on a single-operator deployment the link can be copied from the server's log.

Email verification: a password sign-up gets no session until the link in the verification email (valid 24 hours) is opened at `/verify`; signing in before that is refused with a "send it again" option, and signing up again with the same address just replaces the password and resends the link. Opening a password reset link also verifies the address. Accounts that existed before verification was added count as verified.

Google sign-in: with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set (an OAuth web client whose authorised redirect URIs include `<APP_URL>/api/auth/google/callback`), the sign-in and registration pages show **Continue with Google**. The first Google sign-in links to an existing verified account with the same email, takes over an unverified one (its password stops working, since whoever set it never proved they own the address), or creates a new one with no password (set one later with **Forgot your password?**). `APP_URL` sets the origin used in the link (defaults to the requesting origin). `LEGACY_HOSTS` lists old host names (comma-separated) that redirect to `APP_URL` with the same path, for moving the app to a new domain.

Environment variables: `PORT` (default 3001), `HOST` (default 127.0.0.1), `DATA_DIR` (default `./data`), and `SECURE_COOKIES=1` for HTTPS deployments. Download as PDF needs a Chromium: `CHROMIUM_PATH` names one (in the hosted app's image, Debian's `chromium` at `/usr/bin/chromium`), else a Playwright-installed Chromium or Chrome on the machine is used; in development the pages it prints come from Vite (`PRINT_ORIGIN`, default `http://localhost:5173`). The assistant needs `ANTHROPIC_API_KEY`. For local development, copy `.env.example` to `.env` (git-ignored) and fill it in; the server loads it on start (`server/env.ts`), so restart it after editing. You can also set `AGENT_MODEL` (`claude-sonnet-5-5` by default, or `claude-opus-5-5`), `AGENT_EFFORT` (`low`, `medium` (default) or `high`) and `AGENT_DAILY_REQUEST_LIMIT` (model calls per user per day, default 500). The coding and research jobs run Claude Code with the same key and its default model unless `CODING_API_KEY` (a separate API key, or a Claude Code OAuth token from `claude setup-token`, billed apart) or `CODING_MODEL` (a model id to pin) is set.

