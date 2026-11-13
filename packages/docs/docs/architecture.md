# Architecture

How each part of MCP Docs works, area by area: what CLAUDE.md points to. Read the part you are working on.

## The code, area by area

- `client/src` — React app. Spreadsheet state lives in `client/src/state` (`WorkbookStore` + `Tx` transactions,
  `SheetController` for selection/editing, `ops.ts` for workbook operations such as insert/delete/sort/filter).
- `server` — Fastify API (`app.ts`), auth, sheet storage (`sheets.ts`), and the assistant (`server/agent`).
- **The runtime seam** (`server/runtime/`, design in `../../docs/specs/docs-core.md` §3.1): the server reaches the machine it
  runs on only through `#runtime/*` imports, which `package.json`'s `imports` map resolves to `runtime/node/` by default
  (Node's own `fs`, `fs/promises`, `sqlite`, Fastify, Playwright, LiteParse) and to `runtime/workerd/` under the `workerd`
  condition, which the suite's Worker sets in its bundler, tests and typecheck (files are R2 objects, the database is the
  Docs object's SQLite, HTTP is `DocsApp`, PDFs are read by pdf.js and the OCR container). `#runtime/local/*` is the
  standalone app's own (the folder-backed stores, backup, folder watching, the local MCP server, window tools, jobs,
  the Claude Code driver, Spotlight recents): real on Node, inert on Workers. A core server file never imports `node:fs`,
  `node:sqlite` or `fastify` directly; what it needs of the machine is added to the seam, on both sides, in one change.
  A host (the suite) extends the assistant through `AgentOptions.pages/extend/guidance` and `setAssistantToolSource`
  (`server/agent/agent.ts`, `tools.ts`) rather than by editing it.
- In the FreeFlow suite (design in `../../docs/specs/freeflow-suite.md`) this app is the Workspace app inside Flow's server
  (`packages/server/src/docs.ts`): `buildApp({ host })` wires its routes into the host's Fastify instance as an encapsulated
  plugin (`wire()` in `app.ts`) instead of making a server, and the host says who is signed in (`host.authenticate`: Flow's
  session, as a bearer or the `sid` cookie), signs out (`host.signOut`) and names the client's base path (`/docs`, which
  the client is built with: `BASE_PATH`, read as Vite's `BASE_URL` in `client/src/basePath.ts` and the router's basename). Hosted,
  the app's own sign-in, sign-up, password and Google routes, its mailer and its legal pages are off; a visitor at the base is sent
  to the suite's sign-in (`/?next=`), as are the ChatGPT plugin's OAuth pages (`suiteSignIn`, resumed at `/oauth/resume`). The plugin
  is reached on hosts of its own (`docs.freeflow.im`, `mcpdocs.freeflow.im`, still the AWS server), and a session cookie is per
  host, so its sign-in is handed across (`host.handoff`, `plugin/server/http.ts` `PluginHandoff`): the sign-in page's link is
  `/oauth/sign-in?next=/oauth/resume?p=…` on the plugin's host, which forwards to the suite's `/api/auth/cross-host` on the Worker's
  host (`packages/edge/src/routes/crossHost.ts`); signed in there, the browser comes back to `/oauth/handoff?key=…&next=…` with a
  one-time key, which the host's server trades server to server (`/api/auth/cross-host/exchange`, under the edge secret) for the
  user, mirrored into its `users` when new (`packages/server/src/services/mirrorUser.ts`), and signs them in on that host; and the
  `users` table is a mirror of the host's users, upserted as each request comes in, so the owner columns keep their foreign keys.
  Flow's `scripts/import-workspace-users.ts` moves the hosted app's accounts over once. Standalone (`pnpm start`, the desktop app)
  nothing changes.
- In the suite (`useAuth().suite`) every signed-in page has the suite bar above it (`@flow/suite-bar`, the package
  `packages/suite-bar` both apps bundle): `main.tsx` wraps the shell in `.suite-frame` with `components/DocsSuiteBar.tsx`
  on top, and the page scrolls under it. The bar replaces the page headers' `.wb-logo`, `Account`, `AgentButton` and the
  home page's brand, which those pages draw only without `suite`; its Assistant button calls `useAgent().setOpen`, and
  ⌘K is its search (the home page's file search, `?q=…&find=1`), so `AgentProvider` leaves ⌘K alone in the suite.
  `suite.ts` reads the suite's API on the same origin with the cookie (`/v1/me`, `/v1/me/workspaces`, refreshed every
  60 s, and `PATCH /v1/me` for presence and status), the organization Chat selected (its key in Chat's connection
  registry in localStorage, which a selection here writes too), and the editors' saves the bar's Log out waits for
  (`onBeforeLeave`). What is Chat's (adding an organization, its settings, inviting, notifications, the profile) opens
  Chat at `/?open=…`; Chat's Assistant comes here as `?assistant`, which the home page turns into the open panel.
- `shared` — code used by both: workbook types (`types.ts`), cell references, the formula engine, the slide deck
  format with its layouts and themes (`deck.ts`), and the assistant protocol (`shared/agent`).
- Presentations (slide decks) live in `client/src/deck` (`DeckStore` + `DeckController`, the `SlideView`
  renderer, editor, toolbar, present mode) and `client/src/pages/DeckPage.tsx`. They are stored with
  spreadsheets (`server/sheets.ts`, `kind` column) behind `/api/decks`.
- Text documents live in `client/src/doc` (`DocStore` + `DocController` over a ProseMirror state, the
  `DocEditor` view, toolbar) and `client/src/pages/DocPage.tsx`, behind `/api/docs`. The schema and
  file format are in `shared/doc.ts`; `shared/docMarkdown.ts` converts documents to and from the Markdown
  the assistant reads and writes.
- Markdown documents live in `client/src/markdown` (`MarkdownController` over the plain text with autosave,
  the GitHub-flavored `MarkdownPreview` built on react-markdown + remark-gfm) and
  `client/src/pages/MarkdownPage.tsx` (a textarea editor with a resizable preview panel), behind
  `/api/markdown`. The preview can be edited in place (`WysiwygPreview.tsx`, `wysiwyg.ts`): each top-level block
  (`markdownBlocks`) is its own contentEditable element, frozen while it has the focus, and an edit turns only that
  block's HTML back into Markdown (hast-util-to-mdast + mdast-util-to-markdown) and replaces its lines, so the other
  blocks keep their text exactly; front matter and Mermaid blocks stay text-only. A picture pasted or dropped into
  the text or the preview is stored as a file beside the document (`POST /api/files` in its folder and root) and
  linked by its relative name (`pastedImage.ts`), which the preview reads back through `/api/files/at`. The stored format is `shared/markdown.ts`. A ```mermaid code block is drawn as its diagram
  (`MermaidDiagram.tsx`); Mermaid is loaded on demand by the page (`loadMermaid`), and the plugin, which is
  built as one script, does not pass it, so there the block stays code. The assistant's content tools (`read_doc`,
  `insert_content`, `replace_blocks`, `delete_blocks`, `replace_text`, plus `open_doc`, `list_docs`,
  `create_doc`, `read_other_doc`) work on them too, through `client/src/agent/markdownTools.ts` and
  `shared/agent/markdownBlocks.ts` (blocks are the top-level Markdown constructs, edits are text ranges
  applied through the editor so they are undoable); the formatting and page tools do not.
- A video in a presentation or a document is named by its address (`shared/video.ts`): a stored video
  file (`/api/files/<id>`) or a YouTube video's watch address. It is a slide element of type `video`
  (`shared/deck.ts`) and a `video` block in a document (`shared/doc.ts`; in Markdown an image whose address
  is a video's). `VideoDialog` (`client/src/components/VideoDialog.tsx`: upload, YouTube link, or one of the
  user's files) inserts one in either editor. It is drawn as its still until played (`VideoPlayer.tsx`; in a
  document, `VideoView` in `DocEditor.tsx`): a double-click on a slide, the play button in a document, and
  always in the show.
- A table on a slide is an element of type `table` (`shared/deck.ts`): rows of text cells with their own look,
  column shares, a header row and banding; `shared/deckTable.ts` has its operations and the colors both the
  renderer (`SlideView`'s `TableView`) and the PowerPoint writer use. A cell is edited in place (`DeckController.selectCell`,
  Tab moves on). It is written as a PowerPoint table (`writePptx` adds the header and banding flags pptxgenjs
  cannot) and read back as one; a PowerPoint table with merged cells is still read as boxes and lines.
  A table can be linked to a spreadsheet range (`TableElement.source`: a fixed range, or with `used` the tab's
  used part, which it follows as it grows). Its cells are the range's values and look as last read
  (`shared/sheetTable.ts`, `GET /api/sheets/:id/table`), so everything that draws or exports a table needs nothing
  more; they are not edited on the slide. While a presentation is open `LinkedTableSync` (`client/src/deck/linkedTables.ts`)
  follows each linked spreadsheet's revision feed and refreshes its tables as undo steps. Insert › Table from
  spreadsheet… (`SheetTableDialog`) makes one, and the assistant's `edit_elements` takes `link`, read before the
  tool runs by `linkDeckTables` (in `AgentProvider` and `FileService.editDeck`). In a PowerPoint file the source is
  an extension in the table's frame (`TABLE_SOURCE_EXT`).
- Charts (`shared/chart.ts`) float over a spreadsheet tab (`Tab.charts`): Excel's model (an anchor cell and
  offset, a size in pixels, categories and series as ranges in formula syntax from the chart's own tab, so the
  formula adjusters in `ops.ts` keep them on their data as rows, columns and tabs change). `chartData` reads what
  one shows through the engine; `ChartView` (`client/src/chart/`) draws it as SVG (so it draws the same in
  pictures and PDFs made from the DOM), `ChartLayer` puts the tab's charts over the grid's canvas (select, move,
  resize, Delete) and `ChartEditor` is the panel beside it. Insert › Chart (`SheetController.insertChart`,
  `suggestChart`) charts the selection. The assistant has `add_chart`, `edit_chart`, `delete_chart`
  (`client/src/agent/chartTools.ts`) and sees charts in `get_sheet_overview`. ExcelJS neither reads nor writes
  charts: `server/xlsxCharts.ts` adds the DrawingML parts after it writes a workbook and reads them on import
  (kinds ours cannot be are counted as lost); it also hands ExcelJS the file without its drawings, which it can
  fail on. A slide's `chart` element (`ChartElement`) is a sheet chart's look and data, linked to it
  (`ChartSource`, `GET /api/sheets/:id/charts` and `/chart`, followed by `LinkedTableSync`); Insert › Chart from
  spreadsheet… (`SheetChartDialog`) and `edit_elements` (type `chart`, `link: {sheet_id, chart_id}`) make one.
  It is written as a native PowerPoint chart (pptxgenjs) with its link as an extension (`CHART_SOURCE_EXT`), and
  a PowerPoint chart is read back from its cached data (`readChartWithData`).
- CSV files are spreadsheets stored as CSV text (`shared/csv.ts`; `SheetMeta.format === 'csv'`, the `format`
  column in `server/sheets.ts`). `SheetStore.load` parses the text into a one-tab workbook and `save` writes
  CSV back for as long as the workbook holds only plain values, so everything that reads spreadsheets works
  on them. In the editor `csvGuard` (`client/src/state/store.ts`) refuses a change CSV cannot store
  (formatting, images, column sizes, frozen panes, filters, more tabs) and the page offers to convert the
  file to a native spreadsheet (`POST /api/sheets/:id/convert`); the assistant's tools get a `ToolError`
  telling it to ask the user to convert.
- The desktop app (`desktop/`, `pnpm desktop`) is Electron around the same server and client, named MCP Docs
  (the hosted app is MCP Docs too, the ChatGPT plugin Universal Docs; code shared by both names it with `appName` in
  `shared/brand.ts`, and the client with `appName()` in `client/src/brand.ts`, set from `/api/auth/me`). `main.js`
  starts `desktop/server.ts` as a child process for the folder being opened (the command-line argument or
  the current directory) and loads it in a window. Each window (a tab, on macOS) shows one folder, and each folder
  open in a window has a server of its own, stopped when its last window closes; opening a folder (Open Folder…, a
  file of Recents outside it) changes only the window it was asked in. File › New Tab (⌘T, `newTab`) opens the
  folder and list of the window in front. A right-click the page leaves alone gets the menu a browser would show (copy or
  save a picture, links, text, spelling: `desktop/contextMenu.js`). Open in Finder (File Explorer on Windows: a file's and a folder's menu in the list, the
  folder button's menu, each editor's File menu) is `POST /api/local/reveal`, which `main.js` does with `shell`; a file
  dragged out of the list is the file itself to other apps (Finder, a video editor): the page cancels its own drag and
  asks `POST /api/local/drag`, and `main.js` runs the system's (`webContents.startDrag`, `dragOut`). Dropped on a folder
  of the list it still moves there (`FileLibrary`'s `onDragOut`). The servers' token cookies are on one host, so each has its own cookie
  name (`local.cookie`, `LOCAL_COOKIE`). `buildApp({ local: { dir, token } })` swaps in the
  folder-backed stores of `server/localStore.ts` (`LocalSheetStore` and `LocalFileStore`, subclasses that
  override the on-disk hooks of `SheetStore` and `FileStore`: real `.md`/`.csv` files, `.ffsheet`/`.ffslides`/
  `.ffdoc` for the JSON formats, the tables synced with the folder on every list; a document's title is its whole file name,
  extension included, and what is made from a title drops it with `titleBase` in `shared/docNames.ts`) and makes every request
  the one local user. The client learns it is local from `useAuth().local`.
  It has no background jobs (app changes, research): `AgentOptions.jobs` is false, so the assistant is not
  offered `JOB_TOOLS` and its prompt is `PROMPT_WITHOUT_JOBS`, and `/api/agent/jobs` refuses.
  There documents are Office files: spreadsheets Excel (`format === 'xlsx'`, `shared/xlsxFormat.ts`),
  presentations PowerPoint (`'pptx'`, `shared/pptxFormat.ts`), documents Word (`'docx'`, `shared/docxFormat.ts`).
  A file is imported when read and written back with its export (`workbookXlsx`, `deckPptx`, `docDocx` in
  `server/docxExport.ts`); pictures read from one are stored once (`ImageStore.createOnce`). New documents
  and CSV files that outgrow CSV become Office files (`SheetStore.richFormat`); only one its Office file
  cannot hold (a picture in a cell, a gradient, a video in a document, ...) is kept as `.ffsheet`/`.ffslides`/
  `.ffdoc`, and in the editor such a change asks first (`xlsxGuard`, `pptxGuard`, `docxGuard`, the stores'
  `guard`). What writing back would remove (the import's losses, the export's approximations) is `notKept`
  on a load of a file the app did not write: the editor is read-only (`lockedGuard`, `useOfficeFile` in
  `client/src/components/OfficeFile.tsx`) until the user allows editing, and the first save over it keeps a
  copy in the trash.
  On macOS the app declares the file types it opens (`build.mac.extendInfo` in `package.json`: it owns
  `.ffsheet`/`.ffslides`/`.ffdoc` and edits Markdown, CSV, Office files and PDFs, and is an Open With
  choice, never the default, for PNG, JPEG, WebP and GIF pictures). macOS keeps Apple's apps
  the default for the standard ones whatever the app declares, so the installed app offers once, and has
  Make Default App… in the app menu, to set itself as the person's default (`setDefaultApp`). Finder's
  `open-file` shows the file in the open folder when it is inside it, else opens the file's own folder.
  New files in Downloads, Documents and Desktop (`app.getPath`, so Windows' known folders too) open the same way, but always in a new tab, and
  bring the app to the front (`desktop/newFiles.js`, `watchFolders` in `main.js`): not recursively, only the kinds chosen in
  Settings (`KINDS`: Office files, PDFs, Markdown, CSV, other text files, which are any name whose first 8 KB are text, pictures,
  and videos, off at first), never hidden, lock or unfinished ones (`.crdownload`, `.part`, …), once a file stops changing, and
  not when several settle at once (a copy). The app's own writes are not new: `writeAtomic` and Download to Folder tell `onOwnWrite` (`server/sheets.ts`),
  which `desktop/server.ts` passes to `main.js` (a `wrote` message). It is on unless turned off in Settings' Desktop tab, which has the kinds too
  (`#desktop`, `GET`/`PUT /api/settings/new-files`, `AppOptions.local.newFiles`, kept by `main.js` in `new-files.json`
  in the app's data folder); Settings asks `main.js` for it, and for the agents below, with an `ask` message.
  Its Recents (see Folders) adds, below the files opened in the app, the files last opened on the machine in any
  app, as Finder's Recents lists them, read from Spotlight on macOS (`recentFiles` in `server/recents.ts`). Opening one outside the open folder
  (`POST /api/local/open`) has the server ask `main.js` (a message to its parent) to open the file's own
  folder instead; the new window starts at `/open?file=…&from=recents` (`pages/OpenLocalFile.tsx`), which
  finds the file (`GET /api/local/resolve`) and makes Recents the first breadcrumb (`client/src/listing.ts`).
  A window may instead be a Web tab: the hosted app (`UNIVERSAL_WEB_URL`) in a session of its own (`persist:web`),
  beside the Local tabs (`createWebWindow`, `isWeb`). Both kinds show a Local | Web switch beside the logo (`PlaceSwitch`, shown
  when the user agent has `MCPDocs/`) whose switch is an `mcpdocs://switch` link `main.js` catches (`handleAppLink`).
  Google sign-in in a Web tab runs in the system browser with a key of the app's, which the app asks after
  (`googleSignIn`, `/api/auth/handoff/status`) and trades for the tab's session at `/api/auth/handoff` (design in
  `docs/web-and-pdf.md`). Upload to Web… and Download to Folder… copy files between
  the folder and the web (`server/webCopy.ts`, `/api/web/*`, `WebCopyDialogs.tsx`): the folder's server asks the
  hosted app through `WebBridge`, which `main.js` answers with the Web tab's session (`webRequest`).
  Over the file list the breadcrumbs show only the folder and the one above it (`FileLibrary`'s `crumbsShown`; at the
  open folder's top that is its parent on disk, `LocalFolderParent`), each with its full path as its tooltip, and the list
  starts with a ".." row (`up`). The star before them marks the folder shown as a favorite (see Favorites); the house button that went to the home folder (`LocalFolderHome`) is hidden for now.
  The folder button left of it (`LocalFolderMenu`) lists the usual folders in the home folder (`GET /api/local/places`: it, Documents, Downloads, Desktop), and offers Open Folder… (`POST /api/local/choose-folder`,
  `main.js`'s dialog) and Open file by path… (`POST /api/local/open-path`: a file or folder, absolute, `~/` or
  relative to the open folder; one outside it has `main.js` open it, or the file's own folder).
  Each editor's File menu (a stored file's page too, `FilePage`: pictures, PDFs, text, web pages, videos) starts with an Open menu (`useOpenInTab`, `client/src/components/OpenInTab.tsx`): both of them, then
  Open Favorites and Open Recents, the user's lists (on the web too). All open in a new tab instead (`tab` in the request): one
  inside the folder by `window.open`, one outside by `main.js` (`openFileInTab`, `openFolder`'s `inTab`).
  The home page's Scratch pad tile (`ScratchPadTile`) is a menu of the Markdown files in `~/.config/mcp-docs` (`SCRATCH_DIR`,
  `GET /api/local/scratch-pads`) and New scratchpad, which makes `Scratch pad.md`, then ones named for the day
  (`scratchPadName`: `Scratch pad-sep05.md`), and opens it (`POST /api/local/scratch-pad`, with a `name` to open one); outside
  the open folder the window moves to that folder, as Open file by path… does, but keeps the folder it came from
  (`/open?…&backDir=&backFolder=`, `returnTo` in `client/src/listing.ts`): the editor's breadcrumbs show it, and a list
  asked for there (breadcrumbs, the logo, Home) moves the window back to it (`HomePage`, `POST /api/local/return`).
  On the web the tile's scratch pads are the Markdown documents in the user's `Scratch pads` folder (`ScratchPadTile`).
  Connect your agent goes to Settings' second tab (`#agents`; Assistant is the first), which shows the MCP address (`mcpUrl`
  from `/api/settings/agents`) and the agents connected: on the web the hosted address with Copy agent instruction; in
  the desktop app (`local: true`) the app's own server on this computer with Copy Claude Code command, its agents and
  whether it is running, which `desktop/server.ts` asks `main.js` for (`AppOptions.local.agents`, an `ask` message).
  The desktop app is also an MCP server for agents on the same machine (Claude Code, say), named MCP Docs
  (`mcp-docs`; the hosted one is MCP Docs too from version 2, with the id `universal-docs`): `server/localMcp.ts`
  serves the ChatGPT plugin's model tools (`plugin/server`, the newest version, no UI parts) over the open
  folder's stores at `/mcp`. `main.js` serves it on a fixed port (127.0.0.1:39217, `UNIVERSAL_MCP_PORT`),
  passing requests to the server of the window in front (`frontServer`) with a secret made for each run. Agents sign in
  with OAuth 2.1 (`desktop/mcpAuth.js`: registration, PKCE, refresh; the person allows each agent in a native
  dialog, not on the web page; tokens hashed in `mcp-auth.json` in the app's data folder), and File › Connect
  an Agent (MCP)… opens Settings at `#agents`, which shows the `claude mcp add` command and disconnects them (`revoke`). For Claude Code and Codex it is also a plugin,
  `claude-plugin/` (the server and a skill, `skills/mcp-docs/SKILL.md`; manifests `.claude-plugin/plugin.json` and
  `.codex-plugin/plugin.json`; the marketplaces are `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`
  at the root), installed with the app by `npx @freeflow-im/mcp-docs` (`installer/`, its own npm package, which asks
  which agents to add it to and prints the MCP address for any other client; its version, the plugins' and the Claude
  marketplace entry's are the desktop release's: `pnpm release -- <version>` sets them all and tags
  `desktop-v<version>`, and pushing the tag has `.github/workflows/desktop-release.yml` build the Mac and Windows apps, make the GitHub
  release and publish the installer to npm, with the notes in `release-notes/<version>.md`). Check for Updates… (the app menu; Help on Windows, `desktop/updater.js`)
  downloads that release's file and installs it over the running app: on macOS it unpacks the new app beside the old one
  and a detached script swaps it in after the app quits (the app is not Developer ID signed, so Electron's updater cannot);
  on Windows the setup program runs silently with `--force-run`. A file
  the model opens, creates or imports is shown in the window (`FileHub.onShow`, a `show` message to `main.js`,
  a `universal-show` event to the router), and the window reports the file it shows (`POST /api/local/showing`,
  `client/src/desktopBridge.ts`, with the window's `WINDOW_ID`), which the tools act on when no id is given.
  An edit tool on the file a window shows runs in that window, as the built-in assistant's tools do: `FileHub.live`
  (`LiveEditor`) is `server/windowTools.ts`, which sends the call to the window (`GET /api/local/tool-calls`,
  server-sent events) and waits for its answer (`POST /api/local/tool-calls/:id`); `AgentProvider`'s
  `runWindowCall` runs it with `runTool` on the open editor, so it is undoable (calls less than a minute apart
  share an undo group), asks about destructive changes (`confirmationFor`, opening the panel), and is saved by
  the editor. A window that no longer has the file answers `unavailable`, and the tool runs headless on the
  stored file (`FileService.editDoc`/`editDeck`/`editSheet`). `render_slide`, `export_deck` and `select_range`
  only run in the window, and only the desktop MCP server has them (`McpOptions.local`), with `open_path`, which
  opens a file by its path (`McpOptions.openPath`: in the folder as `open_file` does, else in a new tab on its own folder, `openFileInTab`).
  There `transform_image` (remove_background included) runs in the window in front too, whatever it shows
  (`WindowTools.runInFront`, `FileService.editImageInWindow`), with the built-in assistant's image tool; the
  hosted plugin's goes to its app's job queue (`runImageJob`) and cannot remove a background.
- The image editor (`client/src/image`, design in `docs/image-editor.md`) is our fork of react-image-editor
  (github.com/freeflow-im/react-image-editor, on Fabric.js), installed from the tarball in `vendor/`.
  `ImageEditorHost` is the editor itself, loaded on demand and unaware of where a picture comes from;
  `ImageFileEditor` is a stored picture being edited on `FilePage` (Save rewrites the file through
  `PUT /api/files/:id`, which keeps the version before for one revert; Save a copy makes a new file).
  The assistant's `transform_image` (`client/src/agent/imageTools.ts`) applies its operations
  (`client/src/image/imageOps.ts`) with the same engine: in the open editor when the picture is open there
  (`activeEditor.ts`), else in one off screen (`hiddenEngine.ts`). Its `overlay` puts another picture (an attached one
  by its `/api/images/...` address, or a stored picture) on top as a layer (`engine.addImageAt`); on a stored picture
  with no `save` it opens the file in the editor first (`openImageEditor`, `/f/<id>?edit=1`), so the user can still
  move and resize it before saving. The engine needs a browser canvas, so tests
  use `fakeEngine.ts`. In the plugin the model's `transform_image` is a job the plugin's app takes with its
  state and does in the browser (`FileService.runImageJob`, `plugin/web/imageJobs.ts`).
  A picture inside a file is edited in `ImageEditDialog` over the page and never rewritten: the page uploads
  the result and puts it in place as an undoable step (on a slide, `DeckController.replacePicture`; in a document, `DocController.replaceImage`).
  A slide's own Crop (`client/src/deck/CropOverlay.tsx`, `shared/deckCrop.ts`) changes the image element's
  `crop` and box, not the picture.
- Importing a file's bytes, whatever they are, is `server/importFile.ts` (`importBytes`: a Word, PowerPoint,
  Excel, CSV or Markdown file becomes a file the app edits, a Markdown file staying Markdown; a PDF, video, picture or web page is stored as
  it is, and so is any other plain text file, edited as text). Both assistants have an `import_file` tool over it that takes a web address; the server fetches it
  with `server/webFetch.ts`, which refuses addresses that are not on the public internet, at every redirect.
- A PDF's text is read as Markdown by `server/pdfMarkdown.ts` (`pdfToMarkdown`, on LiteParse: PDFium for the text and
  layout, Tesseract OCR for the pages that are scans, in worker processes with a deadline; pictures are left out).
  `read_doc` on a stored PDF reads it, and Convert to Markdown (the PDF's page and its menu in the list,
  `POST /api/files/:id/markdown`), the assistant's `convert_pdf` and the MCP `convert_pdf_to_markdown` (version 2)
  make a Markdown file of it beside the PDF (`pdfToMarkdownFile`).
- Download as PDF (documents, presentations, Markdown, stored web pages; design in `docs/web-and-pdf.md`) is made by
  the server: `GET /api/files/:id/export?format=pdf` has a `PdfRenderer` (`server/pdf.ts`) load the file's page in
  the app with `?print=pdf`, which lays itself out as File › Print does and sets `window.__printReady` when drawn
  (`client/src/print.ts`), and print it. The headless browser is let in by a print ticket, a cookie making its
  requests the user's for reading only (`PrintTickets`, the `onRequest` hook). A web page's HTML is printed
  from its text with each request it makes checked as an import's (`webFetch.ts`). The hosted app's renderer is
  Chromium through `playwright-core` (`CHROMIUM_PATH`, Debian's `chromium` in the hosted app's image); the desktop app's
  (`ElectronRenderer`) asks `main.js` to print in a hidden window (`printPdf`). `PdfMaker` (made once in `buildApp`)
  also serves `export_pdf`, for the assistant and the MCP, which keeps the PDF as a stored file beside the file.
- A PDF is signed on its page (Edit, `client/src/pdf/PdfSigner.tsx`): the pages drawn by pdf.js with the user's
  signature, lines of text and dates placed over them, which `signPdf` (`shared/pdfSign.ts`, on `@cantoo/pdf-lib`)
  writes into the page content (Helvetica text, the signature as a picture; positions in points from the top left of
  the page as shown). Save rewrites the PDF (`PUT /api/files/:id`, keeping the version before; in the desktop app a
  copy goes in the trash) and Save a copy makes `<name>-signed.pdf`. The signature is drawn, typed or uploaded in
  `SignatureDialog` (signature_pad); a user keeps several, picked from the Sign menu (`server/signatures.ts`,
  `/api/settings/signatures`; in the desktop app in its settings database).
- Find (⌘F) in the editors other than the spreadsheet's (`state/search.ts`, `FindBar`) is `client/src/find`: one find bar
  (`FindBox`, which `FindBar` also uses), matches in a document as ProseMirror decorations (`docFind.ts`, `DocController.find`),
  in a presentation's slides by element (`deckFind.ts`, `DeckController.find`), in Markdown over the textarea
  (`TextareaMatches`) and in the preview, in a plain text file's editor (`TextFileEditor`, the same layer), and in the JSON tree; text the page draws is highlighted with the CSS Custom
  Highlight API (`highlights.ts`). PDFs have none of their own yet (the browser's viewer).
- A stored file that is plain text (`StoredFile.text`) is edited as text on its page (`TextFileEditor`, saved as it is typed by an `AutoSaver` as the other editors are; in the desktop app its Tail follows a growing file, a log, by asking
  `GET /api/files/:id` for the bytes past those it has, a Range request); a JSON file
  is shown as a tree first (`JsonViewer`: all open, Collapse all / Expand all, each object or array on its own; a very
  large one opens only its top levels), with Edit for the text.
- A zip file's page lists what it holds and opens each file in it read-only (`client/src/components/ZipBrowser.tsx`,
  the folder and file in the address as `?dir=` / `?entry=`). The server never unpacks to disk
  (`server/zipView.ts`): `GET /api/files/:id/zip` lists the files, `/zip/entry?path=` sends one (inline only
  for PDFs, pictures and videos, as stored files are), and `/zip/view?path=` converts a Word, Excel or
  PowerPoint file with the importers, its pictures inline as `data:` addresses. The browser shows text,
  Markdown, CSV and web pages from the bytes; a spreadsheet is the `Grid` with a store guard that refuses
  every change, a document the `DocEditor` with `readOnly`.
- Open editors (spreadsheets, documents, Markdown, presentations) keep to the latest revision of their file: saves name the
  revision loaded and the server answers 409 when it changed, and `GET /api/revisions/:id` (server-sent events,
  `server/revisionFeed.ts`, fed by `SheetStore.onRevision`) announces each new one so an editor with nothing
  unsaved reloads (`client/src/state/revisionSync.ts`). The feed is per process; more than one server node
  would need shared pub/sub for it. In the desktop app other programs change files too: the directories open editors and lists look at
  are watched (`DirWatchers`, `server/folderWatch.ts`, not recursively), a file whose time is not the one the store
  knows is a new revision (`LocalSheetStore.fileChanged`/`retime`), and `GET /api/local/folder-changes?folder=` tells
  the home page's list to load again.
- The hosted app's public site for visitors: the front page (`LandingPage`) is drawn when the app is built
  (`pnpm build` runs `scripts/prerender-landing.ts` on `client/src/landingPrerender.tsx`, making
  `dist/client/landing.html` with its head for search engines), and the server sends it at / to a visitor who is not
  signed in, with the app's address for `ORIGIN_MARK`; the app keeps it while it asks who is signed in. Each box on
  it can link to a feature page: Markdown with front matter in `content/features/<slug>.md`, served by
  `server/marketing.ts` as HTML at `/features/<slug>` (styled by `client/public/marketing/site.css`, with structured
  data, its FAQ section included) and as Markdown for agents at `/features/<slug>.md` (or with `Accept: text/markdown`),
  listed on `/features`, in `/sitemap.xml` and in `/llms.txt`. A new page is a new file there and a `page` on its
  box in `LandingPage`'s `FEATURES`.
- Public links (`server/publicLinks.ts`; a `link:<token>` viewer grant since platform phase 3.2, `public_links` kept one release, unread):
  the hosted app only, a presentation or a video (a stored file a browser plays)
  can have an address, `/p/<token>`, that anyone can view without signing in (`PublicPage`). A manager of the file turns it on and off (`POST /api/grants/:kind/:id/link`,
  removing the grant; the Sharing menu's `ShareDialog` still uses the older `/api/sharing/:kind/:id`, now wrappers over the grant; the organization's `linkSharing` policy, `host.linkSharing`, can refuse it with `policy_forbids`);
  a link works while its grant does (`resolveLink`); a link turned on again gets a new token, and deleting a file ends its link (triggers on `sheets` and
  `stored_files`, whichever path deleted it, so a restored file is not public again). Guests use `/api/public/:token...` only: `publicDeck` gives them
  a copy of the deck without speaker notes or links to spreadsheets, with its pictures and videos named under the token, and only what its elements
  show can be fetched with it (`shownBy`, checked per request, so what leaves the deck stops being available). Answers carry `no-referrer`,
  `noindex` and a `sandbox` CSP, and browsers keep files at most five minutes.
- Previews (`server/previews.ts`, table `previews`, bytes and converted views under `previews/` in the data directory): the hosted
  app only, a file shown read-only for an hour without becoming one of the user's files. FreeFlow Mail opens an attachment through
  one: the suite's Worker reads the bytes from the person's Mail object and posts them to `POST /api/previews?filename=&type=&key=`
  (`packages/edge/src/routes/previews.ts`), so the browser uploads nothing. A Word, Excel or PowerPoint file is converted as a zip's
  entry is (`zipOfficeView`, pictures inline as `data:` addresses), a CSV with `csvToWorkbook`, Markdown kept as text, a PDF kept as
  it is; anything else is kept only to be saved. The importers' limits apply (20 MB for an Office file), and 25 MB for any preview.
  A preview is its owner's only (anyone else gets 404), is not in the library, Recents or search, and `GET /api/previews?key=` finds
  the owner's live one for the same source (`mail:<account>:<folder>:<uid>:<index>`) and gives it another hour. Expired ones are
  swept on each use and, on the Worker, by the Docs object's alarm. `/preview/<id>?workspace=` (`client/src/pages/PreviewPage.tsx`)
  draws one with no bar, folders or assistant, meant for a frame: `ReadOnlyDoc`/`ReadOnlySheet`/`ReadOnlyDeck` from `ZipBrowser`,
  `MarkdownPreview`, and a PDF with pdf.js (`client/src/pdf/PdfView.tsx`; `/api/previews/:id/file` is a sandboxed download, so the
  browser's own viewer would not show it). Escape, and ← / → where they do not move around in the file, are posted to the page
  around it. `POST /api/previews/:id/save` imports the bytes with `importBytes` into the top of My files (once; again gives the same
  file) and returns its page (`url`). On the Worker the page is served with `frame-ancestors 'self'`.
- Organizations (the FreeFlow suite only; design in `../../docs/specs/freeflow-suite.md` §2.4, ruled 2026-11-02): every row that
  belongs to someone (`sheets`, `stored_files`, `images`, `folders`, `public_links`, `agent_conversations`) carries `workspace_id`, the
  organization (Flow's workspace), and files and folders `private` (1, the default). A root of the library is a `Scope`
  (`server/scope.ts`: `{ ownerId, workspaceId, private }`): Organization files are an organization's `private = 0` rows, any member's;
  My files in an organization are the user's `private = 1` rows there plus their rows from before organizations (`workspace_id IS NULL`),
  shown in My files of every organization. A plain user id is a scope too (the standalone app, the desktop app, the ChatGPT plugin): all
  of the user's private rows, and new rows with no organization, so without a host nothing changes. `scopeWhere` is the stores' WHERE for
  listing and searching; creates write the scope's columns; a folder's path is unique per root (`folders.scope` is `scopeKey`). By-id reads
  are `find(id)` and the one access check, `canAccess(viewer, row)`: a private row (or one with no organization) is its owner's, a shared
  row a member's; the stores' by-id methods take the `Viewer` (`{ userId, workspaces }`) and act as if a row the viewer cannot access did
  not exist (a 404). `requireUser` sets both on the request: `req.scope` from `workspace` and `shared` (query or body; `host.isMember`
  checks the organization, else 403) and `req.viewer` from `host.organizationsOf` (Flow caches both a minute; an organization the
  request names, or a file's of the `:id` it names, is checked by itself so one just joined works at once). Moving between roots is
  `POST /api/files/:id/scope` and `POST /api/folders/scope` (the target is the request's scope; a folder goes to the target's top with its
  contents): the file keeps its folder when the target has it, the one who makes it private becomes its owner, and its pictures
  (`ImageStore.retag`: a picture is visible to the members of its `workspace_id`) and public link go with it. New files are private, in
  the bar's organization, unless made in a folder of Organization files (the client passes `shared`, by `newFileShared` in `listing.ts`:
  `?org=` with no list over it; a request naming no `shared` is private); a file made beside another (a PDF,
  a signed copy, a Markdown of a PDF, a branch) goes in that one's root. The assistant's server tools take the chat's root
  (`ServerToolEnv.scope`/`viewer`): an organization file's chat, its root; the home chat, My files of `AgentTurnRequest.workspace`. On
  the client the bar publishes its organization (`suite.ts`' organization state, `useOrganization`), `api.ts` names it on list and create
  calls (`Place`, `placeFields`; `placeOf` for beside a file), the folder panel on the left of every page (`components/DocsNav.tsx`, in `.app-shell`
  beside `.app-main`) shows both roots as a tree (Organization files with `?org=<id>`, My files without) under Recents and Favorites,
  reads each open folder's subfolders with `api.library` and again on `FOLDERS_CHANGED` (the home page sends it after a change), and on a
  file's page selects the folder it was opened from (`listing.ts`' `last`); so the home page has no `RootSwitch` or Recents/Favorites
  tabs there (`FileLibrary`'s `listTabs={false}`, `RootSwitch` only outside the suite), the breadcrumbs name the root, and `OrganizationActions.tsx` has the menus' Share with organization / Make private /
  Move to organization… (a picker of the user's other organizations).
  Since platform phase 3.2 access is on grants (`server/access.ts`, the `grants` table of `@flow/shared/grants`): objects are `sheet`, `file`
  and `folder` (named `<scopeKey>/<path>`, `folderObjectId`; folders have no id), a file's chain is itself then each folder up to its root's
  top, and `roleOf` is `owner` for the owner column, else (for a member of the row's organization) `effectiveRole` over the chain's grants,
  matched against the caller's account and channels (`host.readerOf`; the Worker passes them in the caller context). `canAccess` is gone: the
  stores' by-id methods take a needed role (read viewer, change editor, delete owner; a lower role is a 403). Organization files are the rows
  with an `org` grant, which every row of an organization's root has (`syncOrgGrant` on create and move; the one-time migration gave it to the
  `private = 0` rows), so `private` stays as the flag derived from it and `scopeWhere` lists as before. Share with organization and Make private
  give and take `org` (a manager's), Move to organization… is the owner's. `/api/grants/:kind/:id` (GET viewer+, PUT `{ principal, role }` and
  DELETE `/:principal` manager+; `org` there is the same move) backs the Share… dialog (`ShareWithDialog.tsx`; the home page also opens it for
  the suite's share intent, `/docs/?share=<org>/docs/<kind>/<id>`, platform phase 6.4), and `/api/library?scope=shared`
  (`&in=<folder id>`) is Shared with me, a third list in `DocsNav` (`?withme=1`). Metadata carries `role` when the reader is not the owner (a file
  with one that is not the organization's shows the crumbs `sharedFileCrumbs` makes: Shared with me, then only the shared folder down); a
  viewer's editors are read-only (`viewOnlyGuard` on the sheet, deck and doc stores, `readOnly` on the Markdown and text editors).
  Since phase 3.3 every grant change, once made, goes to `host.onGrantChange` (`reportGrant` in `app.ts`: the grants routes, the `org` toggle,
  Share with organization / Make private, links made and stopped; `role` null is a revoke), and each save or rename of a document to
  `host.onFileChanged`; the suite's Docs object sends them to the organization's share index and event log (`packages/edge/src/docs/object.ts`).
  A folder moved to another root (`/api/folders/scope`) changes its object ids, and to another organization the references of what is in
  it: `reportMove` compares `FolderStore.grantsUnder` before and after, revokes every grant under the old ids (with the people and channels a
  move to another organization drops) and gives the new ones with `silent`, so the index follows without a second notice (phase 3.4).
- Folders (`shared/folders.ts`): a folder is named by its path (`Reports/2026`, `''` for the top). Files
  carry it in the `folder` column (`SheetMeta.folder`, `StoredFile.folder`); the folders themselves are
  rows on the server (`FolderStore`, `server/folders.ts`) and directories in the desktop app
  (`LocalFolders`). The home page lists one folder through `GET /api/library?folder=`; a request that
  names a `folder` (query or body) has it checked and put on `req.folder` by `requireUser`.
  `GET /api/folders/download?folder=` is a folder as a zip (`exportFolder` in `server/export.ts`), and a file
  dragged onto a folder in the list or the breadcrumbs is moved there (`FileLibrary`'s `onMove`).
- The thumbnail view (`FileLibrary`'s `view`, `FileThumb.tsx`): pictures show themselves, videos a frame, PDFs their first
  page (pdf.js, with Range requests for only the parts that page needs), and documents, spreadsheets and presentations a
  small rendering of their start (`GET /api/library/preview/:id`, `shared/preview.ts`). A card loads nothing until it
  scrolls near the view, and then through `thumbQueue.ts`: at most three loads at once, the newest first, a card that
  goes away dropped. The queue is what keeps the cards from staying blank in the desktop app, where each window holds
  one or two of the browser's six connections to the folder's server open for its event streams (`folder-changes`,
  `tool-calls`), so forty loads at once left the small preview requests waiting behind PDFs and videos.
- Recents, a tab beside the folder's name on the home page (`/?recents=1`, `FileLibrary`'s `otherList`): the last
  20 files the user opened, in any folder. Each page that shows a file reports it (`useRecentOpens`,
  `POST /api/recents`) to `RecentOpens` (`server/recents.ts`), which names it by kind and id on the web and by
  its absolute path in the desktop app (ids there are only the open folder's; the list is in the settings
  database, for every folder). `GET /api/recents` lists them, forgetting web files that were deleted; in the
  desktop app the page then asks `GET /api/recents/system` for Spotlight's (slow), shown below. Its last answer is
  kept in the settings database and comes with `GET /api/recents` (`cached`), shown until the new one replaces it;
  only without one is there a spinner.
- Favorites, the tab after Recents (`/?favorites=1`, `FileLibrary`'s `otherLists`): folders and files the user marks with
  Add to Favorites in their menu (`server/favorites.ts`, `GET`/`POST /api/favorites`). On the web each is named by kind and id
  (`folder:<path>` for a folder) and one deleted is forgotten; in the desktop app by its absolute path, in the settings database,
  so the list is the same in every folder and one outside the open folder opens as Open file by path… opens it. `keys` names
  those in the list being shown, so each menu says Add or Remove; each editor's header starts with a star, before the file's folders and name (`FavoriteStar`, `GET /api/favorites/one`).

## The assistant in more detail

The panel floats over the page, in the suite's assistant dock (`AssistantDock` in `packages/suite-bar/src/AssistantDock.tsx`,
shared with Mail and Calendar; `AgentDock` in `client/src/agent/AgentPanel.tsx` mounts it once from `main.tsx` inside
`.app-shell`): closed, it is the "AI Help" pill in the bottom-right corner; open, a 420×640 panel there, or the
larger expanded one. The header's `AssistantDockControls` are the anchor button, which docks it as the side panel beside
the page (the resizable `.agent-panel` of before, which narrows the page), the expand/shrink toggle, the docked panel's
float button, and close, which shows the pill again. `AgentProvider` keeps `open` in localStorage (`agent-panel-open`)
and `placement` (floating by default) and `expanded` through the dock's `useAssistantDockState` (`agent-panel-placement`,
`agent-panel-expanded`). One wrapper draws every state (docked, it is `display: contents`), so the panel is not
remounted, and keeps its draft, when it is anchored or set afloat. The header `AgentButton`, the suite bar's Assistant
button and ⌘K (standalone) still toggle `open`. Floating and idle, the panel minimizes itself to the pill
(`useIdleMinimize`, `IDLE_CLOSE_MS` = two minutes) with no new text from either side (typing, a sent message, the reply
or its tool calls); a running turn or a waiting question holds it open, and the docked panel stays. Closed, by hand or
by that timer, the chat is over: `useNewChatOnClose` in `AgentProvider` resets it (New chat), once a turn still running
has finished, so the next open starts a new one.

Each file has its own chat, and the home page one (`chatScope`, `HOME_CHAT` in `shared/agent/protocol.ts`;
`agent_conversations.scope`, null for home): `GET /api/agent?scope=` is a chat with the file's title, and reset
and turns name the chat (`AgentTurnRequest.scope`). The panel shows the open page's chat (`AgentProvider`'s
`pageScope`), except that a turn stays in the chat it was sent from: when the assistant opens another file the
turn's chat stays shown, with a link to the page's (`showPageChat`), until the user moves on.

New chat ends the active conversation and keeps it. The panel's ‹ › (`ChatHistoryNav` in `@flow/suite-bar/assistant-dock`,
used by Docs', Mail's, Calendar's and the suite bar's panels) step through a chat's conversations: `GET /api/agent/history`
(`AgentStore.history`: those with messages, newest first, each with its first user message) and `POST /api/agent/reopen`
(`AgentStore.reopen`: the chosen one becomes active again and the current one ends), after which the panel reads the chat
again. Only the built-in loop's conversations are listed.

A user can run the assistant on their own Anthropic, OpenAI or OpenRouter API key instead (the Settings page,
`/api/settings/assistant`, stored encrypted by `server/agent/settings.ts`; `server/agent/providers.ts` makes
the model call and checks a key before it is saved). The loop and the stored history stay in the Claude
message format; `server/agent/openai.ts` translates each request to OpenAI's Responses API, and the reply back.
`server/agent/openrouter.ts` sends it almost as it is to OpenRouter's Anthropic Messages API (without Anthropic's
`betas` and `fallbacks`), for any model OpenRouter carries. The model choices are
`ANTHROPIC_MODELS`, `OPENAI_MODELS` and, as suggestions (any tool-calling model id is accepted),
`OPENROUTER_MODELS` in `shared/agent/protocol.ts`. The desktop app has no model of its own
(`AssistantSettings.builtIn` is false): its settings are the app's, in `settings.db` in its data folder
(`local.settingsDir`), and on the first run a key found in the user's login shell (`desktop/main.js`) is used
(`adoptFromEnvironment`: Anthropic's, then OpenAI's, then OpenRouter's).

Most tools are deferred (`server/agent/toolSearch.ts`): a turn sends every definition, but only the search tool, the
file tools (`list_files`, `open_file`, `find_files`) and the open page's main tools (`CORE_BY_PAGE`) are loaded; the
model finds the rest with the provider's tool search (Claude's `tool_search_tool_bm25`, run by Anthropic; `openai.ts`
maps it to OpenAI's `tool_search` and replays a search's output with the definitions it loaded; `openrouter.ts` to
OpenRouter's `openrouter:tool_search`, run by OpenRouter). A search's result stays in the history and names its tools, which
the API requires in every later request: a tool it named that a turn does not offer (another app's, the browser
extension's) gets a deferred stand-in (`keepReferencedTools`), and a call to it is refused as unknown.

A chat can move between providers when the user changes their key, and each refuses some of the others' blocks:
Anthropic wants `srvtoolu_` ids on search calls and thinking it signed; OpenRouter refuses Claude's search result.
`server/agent/history.ts` (`portableHistory`) takes another provider's search steps and thinking out of the history
before each Claude or OpenRouter request; the calls and results stay. OpenRouter's thinking is stored with an
`openrouter:` mark on its signature or data (`markOpenRouterThinking`), which is how it is told apart from Claude's and
taken off again for OpenRouter. `openai.ts` drops thinking and what it does not know, so it needs no cleaning.

In the desktop app the assistant can instead run on the user's own Claude Code (provider `claude-agent`,
`AssistantSettings.agents`): `AgentService` hands those turns to `ClaudeAgentDriver` (`server/agent/claudeAgent.ts`)
instead of its loop. Each turn is a Claude Agent SDK `query` on the `claude` the user installed and signed in
to (`findClaude`: their login shell's PATH; no key or sign-in in the app), in the open folder, resuming the
conversation's session (`agent_conversations.session_id`; a conversation belongs to one `driver`, and switching
starts a new one). It keeps all of Claude Code's own tools and gets the app's MCP server (`mcp-docs-app`, this
server's `/mcp` with its own token; the user's plugin's copy is disallowed), whose edits on the open file run in
the window (`windowTools.ts`, one undo group per turn: `pinGroup`). Its text and tool calls stream to the panel
as the loop's do (labels for Claude Code's tools in `describe.ts`'s `agentToolLabel`) and are stored for the
transcript. It runs in Claude Code's `auto` permission mode; a permission its classifier cannot decide is an
AgentEvent `permission`, answered in the panel (`POST /api/agent/permission`). The desktop build ships the SDK's
JavaScript but not its bundled binaries.

In the FreeFlow suite (since platform phase 6.3) the assistant does not run in the Docs object. It is the account's
`Assistant` Durable Object (`packages/edge/src/assistant/object.ts`, one per account), which runs this same loop and
these stores (`AgentService`, `AgentStore`, `AssistantSettingsStore`) on its own SQLite, with the suite's tool registry:
the open app's browser tools (by `context.page`, the apps' manifests' `assistant.pages`) and every server tool. The
Worker serves `/api/agent`, its turn, reset and permission, and `/api/settings/assistant` from it (`routes/assistant.ts`),
so Docs', Mail's and Calendar's panels share one assistant per account. Docs' server tools reach this app over HTTP as
the person (`assistant/docsTools.ts`: the routes the client uses, plus `GET /api/places/:id` for a chat file's name and
root (it also answers the file's kind and the caller's role, which the suite's `GET /v1/references` reads for a chip), `POST /api/files/:id/pdf` for `export_pdf` and `POST /api/import/bytes` for `import_file` and saved mail
attachments). The seam is `host.assistant`: with it this app makes no `AgentService` and serves none of those routes,
and `edit_image` asks the host for the person's OpenAI key (`host.assistant.openaiKey`). Without a host (standalone,
the desktop app) everything above runs here as before.

Pictures among the stored files: `view_image` attaches one to the message after the tool results so the
model can see it (as `render_slide` does), and `edit_image` asks the server (`POST /api/files/:id/edit-image`,
`server/imageEdit.ts`) for an edited copy from OpenAI's image model, with the user's OpenAI key or the
server's `OPENAI_API_KEY`. The copy is a new stored file; the original never changes.
