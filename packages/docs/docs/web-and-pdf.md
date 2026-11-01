# The web in the desktop app, and Download as PDF

Status: phases 1 to 4 are built (Download as PDF, `export_pdf`, Web tabs, copying between them), except
registering the desktop as a device, which waits for phase 5 (keep updated), which is design. Phase 1 came first because it stands on its
own in the hosted app and the desktop's "keep updated" PDFs depend on it. Decisions still open are listed at
the end.

Two features, one after the other:

1. **Download as PDF** for documents, presentations, Markdown files and stored web pages, made by the server
   so it is one click (a file arrives) rather than the browser's print dialog, and so other things can make
   the same PDF without a window: the assistant, the MCP tools, and the desktop app keeping a PDF up to date.
2. **The web in the desktop app**: the hosted app (MCP Docs on the web) in a tab of the desktop app, beside the local folders,
   with files copied between the two on request and, if asked, kept updated one way (web to local).

## Decisions made

- **Local and web stay separate libraries.** No sync: copying is explicit, the copy is a different file, and
  a file may land in a different folder than it came from. (Dropbox-style sync was considered and dropped:
  the hosted app stores its own JSON formats and the desktop Office files, and a two-way sync would round-trip
  every file through a lossy conversion.)
- **PDFs are made by a headless browser on the server**, from a print view of the same React components the
  editor draws with, so the PDF matches the screen and the existing Print. Building PDFs with a library
  (pdf-lib, already a dependency for signing) would mean writing our own text layout; converting through
  Word with LibreOffice would look like LibreOffice's idea of the file. Both rejected.
- **Spreadsheets are out of this round** (print areas, page breaks across rows and columns and scaling are a
  feature of their own).
- **Print / Save as PDF… stays** as it is, for printing.

## Phase 1: Download as PDF

### What the user sees

File › Download as PDF in the document, presentation and Markdown editors, and Download as PDF on a stored
web page's page (`FilePage`) and in its menu in the list. The PDF is named after the file (`Proposal.pdf`).
While it is made (a second or two; longer for a big presentation) the menu item shows progress; an error says
what failed.

- **Documents**: as Print makes them today: in Pages mode the pages exactly as on screen (`DocPrint`), with
  the page setup's size and margins; in flowing mode the text on the page size the setup names. Links stay
  links.
- **Presentations**: one page per slide, the page the presentation's size (`deck-print`'s layout). Videos
  are their still, linked tables and charts their values as last read, builds in their final state. Speaker
  notes are not included (a later option: a notes page per slide).
- **Markdown**: the rendered preview (`MarkdownPreview`), Mermaid diagrams drawn, not the text. Markdown has
  no page setup, so the page is Letter for a US or Canadian locale and A4 otherwise, with ordinary margins.
  Code blocks, diagrams and table rows are not split across pages; a table's header row repeats.
  Headings become the PDF's outline (bookmarks).
- **Web pages** (a stored `text/html` file): the page as a browser's Save as PDF makes it, with the page's own
  print styles if it has any. Relative addresses in a stored page usually lead nowhere; what loads is what is
  shown.

### How it works

`server/pdf.ts` has a `PdfRenderer`: given a page to render and the PDF options, the PDF's bytes.

```ts
interface PdfRenderer {
  /** Load `url` with the print ticket as its cookie, wait for the page to say it is drawn, and print it. */
  page(url: string, ticket: { name: string; value: string }, opts: PdfOptions): Promise<Buffer>;
  /** Print untrusted HTML (a stored web page) with its network locked down. */
  html(html: string, opts: PdfOptions): Promise<Buffer>;
}
```

- **Hosted and `npm run dev`**: `playwright-core` driving Chromium. One browser is started on the first
  request and kept; each render is a new context (no shared cookies or storage) and is closed after. At most
  two renders run at once, the rest wait; a render has a deadline (30 s, 60 s for a presentation). The browser
  is found by `CHROMIUM_PATH`, else a Playwright-installed Chromium, else Chrome on the machine. The hosted
  app's image (`deploy/aws/Dockerfile`) has Debian's `chromium` and `CHROMIUM_PATH` points at it.
- **The desktop app**: the server is a child of Electron, which already is a browser: the server
  (`ElectronRenderer`) asks `main.js` (a message to its parent, as `openFile` does) to load the page in a
  hidden window with a session of its own and `printToPDF` it (`printPdf`). No Chromium is shipped. Without a
  parent (the server run on its own) it falls back to Playwright.

**The print view** is the file's own page in the app with `?print=pdf` (`client/src/print.ts`): it lays itself
out as File › Print does (documents in Pages mode as `DocPrint`'s pages, presentations as `deck-print`'s
slides, Markdown as its preview, shown whatever the user's preference), with the print styles hiding the
rest, and never asks to print. When everything is drawn (fonts loaded, pictures decoded, Mermaid diagrams
drawn) it sets `window.__printReady = true`; the renderer waits for that, not for a delay. So the PDF is
always what Print makes, from the same code.

**How the headless browser is let in.** It loads the print view from the server's own address on loopback,
without the user's session. The server makes a print ticket for the request: a random token, kept in memory
for two minutes, naming the user and the file. The renderer sets it as a cookie (`print`) on its context; the
`onRequest` hook makes a request carrying a live ticket that user, but only for `GET` requests, so a print
view can read and never write. The ticket is never shown to the user or put in an address.

**Web pages are untrusted.** A stored web page is someone else's HTML, and printing it runs it in a browser on
our server. So:

- Every request the page makes is routed through the renderer (`context.route`): `data:` and `blob:` load;
  `http(s)` addresses are fetched with `server/webFetch.ts`'s checks (public internet only, at every
  redirect) and the answer handed back; everything else is refused. The page cannot reach the server itself,
  the private network or the cloud's metadata address.
- Its scripts run (many pages draw themselves), but the render has its deadline, downloads, pop-ups and
  dialogs are refused, and the context is thrown away after.
- It is loaded with `page.setContent`, not from our origin, so it has no cookie of ours and no same-origin
  access to the app.
- In the desktop app its requests are not fetched at all (only the page itself and `data:`/`blob:`
  addresses load), so a stored page prints with what it holds.

**The API.** `GET /api/files/:id/export?format=pdf` (the export every file kind has) answers with the PDF
of a document, presentation, Markdown file or stored web page as an attachment named after the file
(`Proposal.pdf`); a spreadsheet or any other stored file is refused. `locale` (the browser's language, else
`Accept-Language`) picks Letter or A4. The file's revision is in a header (`X-Revision`), for the desktop's
keep-updated. The client's Download as PDF saves first, then fetches it and saves it (`downloadPdf`).

**The assistant and the MCP.** `export_pdf` (a file id, the open file by default, and `letter` or `a4`)
makes the PDF and keeps it as a stored file beside the file (same folder, `<name>.pdf`), for the built-in
assistant (`server/agent/tools.ts`) and the MCP (version 2, `plugin/server/mcp.ts`, which shows it in the app).
All three go through `PdfMaker` (`server/pdf.ts`), which the app makes once and hands to the agent and to
`FileHub`. It reads the saved file: an edit still waiting to be saved in an open editor is not in it.

### Tests

`server/pdf.test.ts`: the renderer is an interface, so the route, tickets and naming are tested with a fake
that records what it was asked to print and what the page could read and write with its ticket. One test
runs the real Playwright renderer when a Chromium or Chrome is found (skipped otherwise): a stored web page
that tries to reach this machine prints without reaching it.

## Phase 2: the web in the desktop app

### Tabs and windows

- Each tab (a window, joined into tabs on macOS with `addTabbedWindow`, as File › New Tab does now) is either
  **Local**, one folder with its own server as today, or **Web**, the hosted app loaded from its address
  (`UNIVERSAL_WEB_URL`, the production address by default). Local and Web tabs can be in one window.
- A **Local | Web switch** beside the logo (on the home page, and on a signed-out Web tab's sign-in page) says
  which kind this is and switches to the other: it
  selects a tab of the other kind in this window, else brings one forward in another window, else opens one
  as a new tab here.
- A tab's title carries its kind (*Proposal — Web*, *Q3 — Local*): native tabs show only titles.
- File › New Tab opens the same kind as the tab in front. Open Folder… from a Web tab opens a Local tab.
  A file opened from the web list opens in a Web tab, a local one in a Local tab.
- Web tabs have their own session partition (`persist:web`), so web cookies and the local servers' tokens
  never mix, and the hosted page is given nothing of the app's (no preload, no IPC; links to other sites go to
  the browser as now). `main.js`'s map of windows to servers learns that a window may have none: agents (MCP)
  follow the last Local tab used, and closing the last Local tab of a folder still stops its server.
- Without native tabs (Windows, Linux) Web is a window of its own, until the app has a tab strip of its own.

As built: `UNIVERSAL_WEB_URL` (default `https://mcpdocs.freeflow.im`) is the hosted app. Both sessions add
`MCPDocs/1` to the user agent, which is how the client knows to show the switch (`PlaceSwitch`); a page in
a Local tab knows it is local from `/api/auth/me`. The switch's other side is an `mcpdocs://switch?to=web|local`
link that `main.js` catches in `will-navigate` (`switchTo`), so the hosted page is given no IPC. A tab of the
other kind "in this window" is one with the same frame (macOS tabs share it), else the one last in front
(`recent`). File › Open Web Tab and File › Sign Out of Web are in the menu.

### Signing in

Only when a Web tab is first opened, never at start. Signed out, the Web tab shows the hosted app's sign-in
page with Sign in and Create account. Email and password sign in inside the tab. Google refuses to sign in
inside an embedded browser, so Continue with Google opens the system browser (`main.js` catches the
navigation to `/api/auth/google/start`, `googleSignIn`) with a random key of the app's (`desktop=<key>`).
After Google, the callback gives that browser no session, only a page saying to go back to the app, and keeps
the sign-in under the key for ten minutes. The app asks every two seconds whether it is there
(`/api/auth/handoff/status`) and then loads `/api/auth/handoff?key=…` in its Web tab, which sets the tab's
session, once. No link back to the app is needed, so it works in a copy run from a clone too. The session is kept in the partition, so the app stays
signed in; the app menu has Sign out of Web. When the desktop signs in it registers as a device (its name is
the computer's), which the hosted app shows and can remove.

### Copying between them

- **Upload to Web…** on a local file (or several): a picker of the web folders, the same path by default if
  it exists, else the top. The hosted app imports it (`importBytes`): Office files become its own formats,
  Markdown and CSV stay, PDFs, pictures and web pages are stored as they are. What the import could not keep
  is said after, not asked before.
- **Download to Folder…** on a web file: a picker of the folders in the open local folder (the one the
  Local tab shows by default) and, for documents, presentations and spreadsheets, the format:
  - **Office** (`.docx`, `.pptx`, `.xlsx`): what Office cannot hold (a picture in a cell, a gradient, a video
    in a document) is listed under the choice. Office is the default.
  - **MCP Docs** (`.ffdoc`, `.ffslides`, `.ffsheet`): nothing lost, opened only by this app.
  - **PDF** (documents, presentations, Markdown, web pages): phase 1's PDF.

  A name already taken gets a number (`Proposal 2.pdf`), as new files do. Markdown, CSV and stored files
  copy as they are.
- **From any browser**: the hosted app has Download to MCP Docs on a file. It opens
  `mcpdocs://download?file=<kind>/<id>`, which the desktop app handles (it registers the scheme) by opening
  the same dialog in a Local tab.

The desktop does the copying (`server/webCopy.ts`): the folder's server asks the hosted app through `Web`,
which `main.js` answers with the Web tab's session (`WebBridge`, `webRequest`; only `/api/` paths), so the
person's web sign-in never reaches the folder's server. Documents, presentations and spreadsheets travel as the
app's JSON (the hosted app's `export?format=json`, its create routes) with their pictures copied and their
addresses changed, so nothing goes through an Office file on the way; locally they are then written as an
Office file (the desktop's own exporters), the app's format, or the hosted app's PDF. Videos in a file are not
copied (they show only where the file came from), and the copy says so. The local server's routes are
`/api/web/status`, `/folders`, `/upload`, `/preview` and `/download`; the dialogs are
`client/src/components/WebCopyDialogs.tsx`. A Web tab's Download to Folder… (Download to MCP Docs in a
browser) is `mcpdocs://download?kind=&id=&title=`, which opens a Local tab's home page with `?webDownload=`;
Open on the web after an upload is `mcpdocs://open-web?path=`.

### Keep updated

The download dialog has **Keep updated when the web file changes**, off by default. With it, the local file
is linked to the web file, one way:

- The app follows the web file's revision feed (`GET /api/revisions/:id`) and, once edits have settled
  (10 seconds without a new revision, or the editor closing), downloads it again in the same format over the
  local file.
- On launch it checks each link's revision and catches up. Nothing is updated while the app is not running.
- If the local file changed since the app last wrote it (its time and size), the link pauses and says so
  (*Local changes, no longer updated*) rather than overwrite it.
- The local list shows a linked file's state (*Updates from Web · 2 min ago*), and its menu has Open web
  original, Update now and Stop updating.

The links are the desktop's, in its settings database: the web file, the local file (path within the
folder), the format, the last revision written. The desktop reports each link and each update to the hosted
app (`/api/links`), which keeps, per file, the device, the local file's name and folder within the open
folder (never the full path on disk), the format and the last revision delivered. The web file then shows
*Kept updated in MCP Docs on Scott's MacBook Air — Proposal.pdf · up to date*, or *waiting: 3 edits since*
when its revision is ahead of what was delivered, and Stop updating, which the desktop picks up next time it
checks. Uploads leave the same kind of record (*Uploaded from MCP Docs, Q3/Budget.xlsx*), as provenance
only.

## Phases

1. `PdfRenderer` (Playwright; Electron in the desktop app), print views, print tickets, the `/pdf` routes,
   Download as PDF in the four places. Chromium in the hosted app's image.
2. `export_pdf` for the assistant and the MCP.
3. Web tabs, the Local | Web switch, sign-in (with the `mcpdocs://` hand-back for Google), Sign out of Web, devices.
4. Upload to Web…, Download to Folder…, Download to MCP Docs from the browser.
5. Keep updated, and the links on the hosted side.

## Open

- Whether speaker notes are an option of a presentation's PDF.
- Whether "keep updated" is remembered per format (ticked last time for PDF, ticked next time for PDF).
- A tab strip of the app's own, for Windows and Linux and for telling Local and Web tabs apart by more than
  their titles.
