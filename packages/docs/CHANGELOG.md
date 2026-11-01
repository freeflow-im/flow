# Changes made by the assistant

Each entry is written by the app itself when a change requested through the assistant goes live.

## 2026-10-08 — Draggable freeze-pane separators

Both frozen-pane separators in the grid can now be dragged with the mouse. I haven't tried it in a browser. Typecheck and the full test suite pass, but the tests only cover the freeze setting and undo, not the dragging itself.

- **Drag:** the horizontal line moves the frozen-row count and the vertical line moves the frozen-column count. Each snaps to the nearest row or column boundary, and dragging to the top or left edge sets 0.
- **Cursor and guide:** hovering a separator shows a row-resize or col-resize cursor. A blue guide line follows the mouse while you drag.
- **Saving and undo:** releasing the mouse saves the new freeze for that tab through the existing `setFrozen` call, so it persists and Cmd/Ctrl+Z undoes it.
- **Limits:** once a freeze is 0 there is no line to grab, so you can't drag it back out. Dragging also doesn't auto-scroll the grid.

I added no new assistant tool. The changes are in `client/src/grid/Grid.tsx` and `client/src/styles.css`, plus a new test in `client/src/agent/clientTools.test.ts`.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-08.

### Request

In the spreadsheet grid, the frozen-pane separators (the thick gray line below the frozen rows and the thick gray line right of the frozen columns) cannot currently be adjusted with the mouse; only the freeze tool can change them. Make both separators draggable: dragging the horizontal separator up/down changes the number of frozen rows, snapping to row boundaries; dragging the vertical separator left/right changes the number of frozen columns, snapping to column boundaries. Show a resize cursor (row-resize / col-resize) on hover and a highlighted guide line while dragging. Dragging to the top/left edge sets 0 frozen. The change must persist in the sheet's saved frozen_rows / frozen_columns per tab and be undoable with Cmd/Ctrl+Z. Example: on the 'ARR Build' tab, currently frozen_rows=5 and frozen_columns=1; the user should be able to drag the line under row 5 down to under row 6, or the line right of column A to right of column B, and the freeze updates accordingly.

Files: client/src/agent/clientTools.test.ts, client/src/grid/Grid.tsx, client/src/styles.css

Job: 5c63fd2b-3196-4a36-a8c1-bc57191918be

## 2026-10-07 — Show "FreeFlow Docs" branding in the PDF file preview header

I renamed the app branding from "Sheets" to "FreeFlow Docs" in the file preview header and in every other page I found. The edits cover the browser tab titles, including `client/index.html` and the spreadsheet, presentation and document editor tab titles. They also cover the Connectors and Changes back links, the sign-in, password-reset and verify-email headers, and the sign-in page's diagram text. The file preview link still goes back to the home page.

I did not add tests because there are no page-level tests in the repo, and I didn't check the rendered pages in a browser. `npm run typecheck` and `npm test` both pass. No new assistant tool was added.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-07.

### Request

When a stored PDF file is opened in the file preview tab (route /f/:id, e.g. "temp_drivers_license_persinger.pdf"), the top-left header still shows the green logo with the title "Sheets" (underlined link back to home). The home page was already renamed to "FreeFlow Docs". Change the file preview page header branding from "Sheets" to "FreeFlow Docs" so it is consistent. Also check the other pages (spreadsheet, presentation and document editors, connectors, changes pages, and the browser tab titles) for any remaining visible "Sheets" app-name branding that refers to the whole app rather than to spreadsheets specifically, and rename those to "FreeFlow Docs" too. Do not rename things that genuinely mean spreadsheets (e.g. a "Spreadsheets" list heading or "New spreadsheet" actions). The link should still navigate back to the home page.

Files: client/index.html, client/src/pages/AuthPage.tsx, client/src/pages/ChangesPage.tsx, client/src/pages/ConnectorsPage.tsx, client/src/pages/DeckPage.tsx, client/src/pages/DocPage.tsx, client/src/pages/FilePage.tsx, client/src/pages/PasswordResetPages.tsx, client/src/pages/SpreadsheetPage.tsx, client/src/pages/VerifyEmailPage.tsx

Job: 33421e07-70a7-488d-a41c-5a23ae0e5d21

## 2026-10-07 — Import PDFs as stored PDF files, not converted docs

Importing a PDF (file picker or drag and drop) now only stores it as a PDF file in the user's files, with no text extraction and no new document. I added `POST /api/import/pdf?filename=…` in `server/app.ts`. It rejects anything that isn't a valid PDF with "This file is not a valid PDF." and keeps the 20 MB limit. After import the home page opens the file's preview tab (`/f/:id`), and the file shows in the list. I removed the PDF branch from `/api/docs/import`, so `importPdf` is unused on import, and Word, Excel and PowerPoint import are unchanged. I updated the server test to check the stored file, that no document is created, and that invalid content is rejected. Typecheck and all tests pass. I didn't add a new assistant tool.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-07.

### Request

Previously we made the home page "Import doc" button accept .pdf files and convert them to a new text document by extracting text (POST /api/docs/import, server/pdfImport.ts) while also saving the original PDF to the user's files. The user does not want conversion: PDFs should be left as PDFs. Change the behavior so that when a PDF is imported (file picker or drag and drop), the app only stores it as a PDF file in the user's files (same storage as generated PDFs, listed by list_files, previewable with a Download button in the file preview tab) and does NOT create a text document or extract text. Keep the 20 MB limit and reject invalid/non-PDF content with a clear error. After import, show the file in the home page list (or open its preview tab) the same way stored files appear today. Leave the text-extraction code unused on import; do not break other import formats. Example: importing "1685 13th st estimate.pdf" should result in a stored file "1685 13th st estimate.pdf" and no new document. Leave any doc already created from an earlier PDF import alone.

Files: client/src/api.ts, client/src/pages/HomePage.tsx, server/app.test.ts, server/app.ts

Job: 8b357cb3-0ab6-4f7b-8414-24a9dfc3dd65

## 2026-10-07 — Support importing PDF files in the Import doc button

"Import doc" on the home page now accepts `.pdf` files, from the file picker and from drag and drop. Typecheck and all tests pass; I didn't run the app in a browser, and the extractor has only been tried on PDFs built in the tests, not real-world ones.

- **What it does:** `POST /api/docs/import` detects a PDF, extracts its text, and creates a new document named after the filename without the extension. Lines are grouped into paragraphs by vertical gaps, and larger text becomes heading blocks. The original is also saved in the user's files as `<title>.pdf`.
- **Errors and limits:** the 20 MB limit applies. Files with no extractable text (scanned images), invalid files and password-protected PDFs return a clear 400 error. The other import formats are unchanged.
- **No library installed:** I couldn't install `pdf-parse` or `pdfjs-dist` here because `npm install` needs approval I didn't have. Instead I wrote a small extractor, `server/pdfImport.ts`, that uses `node:zlib` to read page content streams. It works on ordinary text PDFs. PDFs with custom font encodings, or text stored in object streams, may come out garbled or fail with the no-text error. Swapping in `unpdf` or `pdfjs-dist` for `readContent` would fix that.
- **New assistant tool:** none.

I added `server/pdfImport.test.ts` and an endpoint case in `server/app.test.ts`.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-07.

### Request

On the home page of the app (list of spreadsheets, presentations and documents), there is an "Import doc" button that imports a file as a new text document. Requested: it should also accept a PDF file (.pdf, application/pdf) in the file picker (and drag/drop if supported today), and create a new text document from it. Extract the PDF's text server-side (use an existing dependency if present, otherwise a lightweight PDF text-extraction library such as pdf-parse/pdfjs-dist), preserve paragraph breaks, and turn obvious headings into heading blocks where feasible. Title the new doc from the PDF filename without the extension. Show a clear error if the PDF has no extractable text (e.g. scanned images) or fails to parse, and enforce a sensible size limit. Keep existing import formats working unchanged. After import, open the new doc or show it in the list, matching how current imports behave. Also keep the original PDF stored in the user's files if that is easy within the existing file storage.

Files: client/src/importFile.ts, client/src/pages/HomePage.tsx, server/app.test.ts, server/app.ts, server/pdfImport.test.ts, server/pdfImport.ts

Job: 7a70c199-a0f3-431e-8aae-503567480321

## 2026-10-07 — Rename home to FreeFlow Docs; move links into overflow menu

The home header now says "FreeFlow Docs", and the browser tab title on the home page is set to "FreeFlow Docs" too. Export all, Trash, Connectors and Changes are gone from the header row. They now sit in a "⋯" button (aria-label "More") next to Assistant. The dropdown items use the same targets as before: the `/api/export.zip` link, the Trash modal, `/connectors` and `/changes`. The menu closes on outside click, Escape, or after you pick an item.

`npm run typecheck` and `npm test` both pass. I added no new test, because the repo has no component or DOM test setup. I haven't opened the page in a browser, so the dropdown styling is unchecked. The change is in `client/src/pages/HomePage.tsx` and `client/src/styles.css`; no new assistant tool was added.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-07.

### Request

On the app home page (list of spreadsheets, presentations and documents; served at docs.freeflow.im), the top header currently shows a green Sheets logo with the title "Sheets", a search box ("Search spreadsheets, pr..."), and text links "Export all", "Trash", "Connectors", "Changes", then an "Assistant" button and the user's email. Requested changes: (1) Rename the home page title/branding from "Sheets" to "FreeFlow Docs" (header title, and the browser tab title on the home page if it says Sheets). (2) Remove the "Export all", "Trash", "Connectors" and "Changes" links from the header row and put them in a "dot dot dot" (three-dot / kebab, vertical or horizontal ellipsis) overflow menu button placed in the header, e.g. next to the Assistant button. Clicking it opens a dropdown listing Export all, Trash, Connectors, Changes, each behaving exactly as the current links/buttons do (same routes/actions, e.g. /connectors). Close the menu on outside click or Escape; make it keyboard accessible with an aria-label such as "More". Keep the search box, Assistant button and user email as they are. Only the home page header is affected; the in-editor headers for sheets/decks/docs should not change.

Files: client/src/pages/HomePage.tsx, client/src/styles.css

Job: c19f6361-7a11-468a-accb-12d86cc3e04c

## 2026-10-07 — File chips in chat, stored PDF files with preview tab and download

Stored files are in, and `export_deck` now uploads its PDF and shows a file chip in the chat. `npm run typecheck` and `npm test` both pass. I didn't run the app, so the chip, the preview tab and the home list haven't been tried in a browser.

- **Server:** stored files with `GET/POST /api/files`, `/api/files/<id>` (inline), `/api/files/<id>/download`, `/api/files/<id>/meta` and `DELETE /api/files/<id>`. Only the owner can read a file.
- **Client:** a `/f/:id` page previews PDFs in an iframe and images in the page, with a Download button in the toolbar. Other types get an info page with just Download. Files also appear in the home list, newest first.
- **Chat chip:** it shows an icon, the filename and the page count, for example "BizTrip_Business_Risk_Review.pdf · 10 pages". Clicking it opens the preview tab, and its ↓ button downloads the file.
- **Chip after reload:** the chip only shows for the current chat session, because the transcript the server rebuilds on reload doesn't carry tool results. The file stays in the home list. Fixing it needs a change in `server/agent/agent.ts`, which I left alone.
- **Download:** `export_deck` no longer starts an automatic browser download; the chip and the tab's Download button replace it.
- **Context:** the assistant's context treats the file tab as the home page.
- **Tools:**
  - `export_deck(deck_id?, format?)` now uploads the PDF and returns `{file_id, filename, pages, url, download_url}`.
  - `list_files(query?)` lists stored files, newest first (at most 50): id, filename, type, size, created_at, urls.
  - `open_file(file_id)` opens that file's preview tab.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-07.

### Request

Context: the assistant now has an export_deck tool (client/src/deck/pdf.ts builds a PDF of a deck, one 960x540 page per slide) that triggers a browser download and returns {filename, pages, download_url (blob: URL)}. The user wants two improvements.

1) Chat file button: when a tool produces a file (starting with export_deck), render a file "chip"/button in the assistant chat message representing the file (icon by type, filename, size/page count). Clicking it downloads the file (re-download works any time, so the blob must not be a throwaway; persist it, see 2). export_deck should still not require the user to hunt for a blocked download: the chip is the primary affordance, and the automatic browser download may be kept or made optional.

2) Stored files with preview: add server-side storage for generated/uploaded files (like the existing stored /api/images/... addresses): store the PDF bytes, with id, filename, mime type, size, created_at, owner, and an /api/files/<id> URL (inline) plus /api/files/<id>/download (Content-Disposition: attachment). Add a "file" item type that can be opened in an app tab: for known previewable types (PDF first; images could follow) opening the file shows an in-app preview (e.g. embedded PDF viewer/iframe) in a tab, with a raw "Download" button in the tab toolbar. For unknown types, show a file info page with just the Download button. Clicking the chat chip should open the file in a tab (preview) and also offer download; the tab's Download button gives the raw file. Files should appear in the user's home list alongside sheets/decks/docs (list of files, most recent first).

Assistant tool changes: export_deck should upload the generated PDF to file storage and return {file_id, filename, pages, url, download_url}; the chat renders the chip from that result. Also add list_files and open_file tools (open_file opens the file's tab) so the assistant can open stored files for the user. Example: exporting "BizTrip: Business Risk Review" (10 slides) yields a chip "BizTrip_Business_Risk_Review.pdf · 10 pages"; clicking it opens a PDF preview tab with a Download button.

Files: client/src/agent/AgentPanel.tsx, client/src/agent/AgentProvider.tsx, client/src/agent/clientTools.test.ts, client/src/agent/clientTools.ts, client/src/agent/deckTools.test.ts, client/src/agent/deckTools.ts, client/src/agent/describe.ts, client/src/api.ts, client/src/components/FileChip.tsx, client/src/main.tsx, client/src/pages/FilePage.tsx, client/src/pages/HomePage.tsx, client/src/styles.css, server/agent/prompt.ts, server/agent/tools.ts, server/app.test.ts, server/app.ts, server/db.ts, server/files.ts, shared/agent/protocol.ts, shared/types.ts

Job: 985796be-376b-461d-a12b-76b74d534459

## 2026-10-07 — Add a tool to download a deck as PDF

I added an `export_deck` assistant tool. It renders every slide of a presentation with the same renderer as `render_slide` and present mode. It assembles them into one PDF with one 960×540 page per slide, in order, and starts a browser download. Typecheck and tests pass. The tests use a stand-in for the slide renderer, and I haven't run the real browser export, so the fonts, theme and images in an actual PDF are unchecked.

Inputs are `deck_id` (optional, defaults to the open presentation) and `format` (`"pdf"` only). The filename comes from the deck title, e.g. `BizTrip_Business_Risk_Review.pdf`. The tool returns the filename, page count and a `download_url`, which is a browser-local `blob:` link to use if the automatic download is blocked.

Slides are rasterised as images in the PDF, so the text isn't selectable. The PDF is built by a small new writer in `client/src/deck/pdf.ts`, and PPTX isn't included. I didn't add anything to `SYSTEM_PROMPT`.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-07.

### Request

The user wants to ask the chat assistant to download a presentation as a PDF (e.g. "download this deck as a pdf"). Today the assistant has no tool that exports or downloads files. Add a tool named export_deck with inputs: deck_id (string, optional, defaults to the open presentation) and format (enum: "pdf", default "pdf"). Behavior: render every slide of the deck exactly as render_slide / present mode draws them (960x540 pages, same fonts, theme, images), assemble them into a single PDF with one slide per page in order, and trigger a browser download in the user's app (filename based on the deck title, e.g. "BizTrip_Business_Risk_Review.pdf"). Return the filename, page count and a download URL in case the browser blocks the automatic download. Example: the open deck "BizTrip: Business Risk Review" (id 41c695f3-58ee-4fed-86bb-85385cf7abeb) with 10 slides should produce a 10-page PDF. Optionally also support PPTX later, but PDF is the requirement.

Files: client/src/agent/AgentProvider.tsx, client/src/agent/clientTools.ts, client/src/agent/deckTools.test.ts, client/src/agent/deckTools.ts, client/src/agent/describe.ts, client/src/deck/pdf.ts, server/agent/tools.ts, shared/agent/protocol.ts

Job: 7a9f088f-ebb7-4520-8630-f8f000049bba

## 2026-10-07 — Second click on selected slide text box enters edit mode with caret

A click without movement on an already-selected text or shape box now enters edit mode with the caret at the click point. I couldn't run it in a browser, so I haven't tried the "Salesforce" example. Typecheck and all 264 tests pass.

`DeckEditor.tsx` remembers on mouse-down that the box was already selected. On mouse-up with no movement, it starts editing and passes the click coordinates to the editor in `SlideView.tsx`. The editor places the caret with `caretPositionFromPoint`, falling back to `caretRangeFromPoint`.

The other behaviours you listed:
- **Drag:** a drag still moves the box.
- **Double-click:** it still enters edit mode through the existing handler, not the new path.
- **Links:** clicking a link in a selected box skips the new path, so the link menu still shows.

The new test in `linkMenu.test.ts` covers only the caret-lookup helper, `caretAt`, with a stubbed document. The mouse-down and mouse-up wiring is untested because the project has no DOM test environment.

No new assistant tool was added.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-07.

### Request

In the presentation editor (client/src/deck/SlideView.tsx and related), text boxes behave awkwardly: the first click selects the whole element (fine), but it then takes several more clicks before the text box enters text-edit mode. Desired behavior: when a text element is already selected, a single further click inside its text should immediately enter edit mode AND place the insertion caret at the clicked position in the text (use caretPositionFromPoint / caretRangeFromPoint of the click coordinates, then focus the editor and set the selection there). Double-click should still enter edit mode and select the word as usual. A drag on a selected element should still move it (only a click without movement enters edit mode). Clicking a link in a selected-but-not-editing box should keep showing the link menu added earlier. Example: slide 4 of deck "Supercog Ops Map", text box id muvwzwxj0w99: click once to select, click again on the word "Salesforce" -> caret appears inside that word and typing edits it. Please verify the behavior with a test if possible and report honestly if you could not run it in a browser.

Files: client/src/deck/DeckEditor.tsx, client/src/deck/SlideView.tsx, client/src/deck/linkMenu.test.ts

Job: 325cb987-87ee-4952-b4e7-0ac6a52e747c

## 2026-10-07 — Fix link popup not appearing on slide link click

A plain click on a link in a slide text box now opens the link menu in the editor, but I haven't checked it in a browser. Playwright and a browser aren't installed here, so there is no Playwright test and I didn't confirm that "Open link" opens a new tab. Typecheck and `npm test` pass, but the one test I added only checks that links render as `sl-link` anchors that open in a new tab; it doesn't click anything.

In `client/src/deck/SlideView.tsx`, `SlideView` now handles clicks on links itself. In the editor (not present mode or thumbnails), a plain click on a link in a text box that isn't being edited shows the existing menu (URL, Open link, Edit, Remove link) under the link. The menu hides on Escape, on a click elsewhere, or when the edited box changes.

The existing caret-in-link behaviour is unchanged, so entering edit mode with the caret in a link should still show the menu. No new assistant tool.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-07.

### Request

Follow-up to the earlier "Link popover in slide editor" change in client/src/deck/SlideView.tsx. The user reports that on slide 4 of deck "Supercog Ops Map" (id e1bdbda5-6778-42b4-8b14-642c7f4f078f), text box id muvwzwxj0w99 contains real hyperlinks (e.g. https://llmonster.atlassian.net/ ) which show underlined and give a hand cursor, but clicking on them shows NO link menu. Expected: in the editor (not present mode), a single click on a link in a slide text box, whether or not the box is already in text-edit mode, shows the floating menu under the link with the URL and actions "Open link" (new tab, noopener), "Edit", "Remove link". Currently the popover appears to require the caret to be inside the link in an active edit session; make it also appear on a plain click on a link in a selected, non-editing text box (and on first click when the box is not yet selected), and on entering edit mode with the caret in a link. Hide it on Escape, click elsewhere, or when the caret leaves the link. Please actually verify in a browser (e.g. with a Playwright test) that clicking the link on a slide opens the popup, and that clicking Open link opens the URL in a new tab.

Files: client/src/deck/SlideView.tsx, client/src/deck/linkMenu.test.ts

Job: ab57ed70-3f3d-42e5-a4ac-21908eb4dd53

## 2026-10-07 — Link popover in slide editor

Clicking or placing the caret inside a link while editing a slide text box now shows a small floating menu under the link. It shows the URL with "Open link" (new tab, noopener), "Edit" (prompts for URL and label) and "Remove link" (keeps the text). It hides when the caret leaves the link, the selection becomes a range, or you press Escape. Typecheck and tests pass, but the tests cover only the URL helpers; I didn't try the popover in a browser, including on slide 4 of "Supercog Ops Map".

Present mode already opened links in a new tab, so I left it alone. Edited link URLs are now saved when the text box commits. The change is in `client/src/deck/SlideView.tsx`, with the helper tests in `client/src/deck/linkMenu.test.ts`. No new assistant tool was added.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-07.

### Request

In the presentation editor, text boxes can contain hyperlinks (created via "[label](https://...)" in body/text). Currently clicking into a link while editing a slide text box does nothing special. Add the same behavior the text document editor and spreadsheet have (if present): when the user clicks or places the caret inside a link in a slide text box (edit mode), show a small floating hyperlink menu next to the link showing the URL, with actions "Open link" (opens URL in a new browser tab, rel noopener), "Edit" (change URL/label) and "Remove link". The menu should disappear when the caret leaves the link, on Escape, or when selection changes to a non-link. In present mode, clicking a link should simply open it in a new tab. Example: slide 4 of the deck "Supercog Ops Map" contains a text box with a link; clicking into it should show the popover with its URL and an Open button.

Files: client/src/deck/SlideView.tsx, client/src/deck/linkMenu.test.ts

Job: c9f25ca3-1316-48c0-9229-61cb73e405b9

## 2026-10-06 — Proper line/arrow/connector tool in the slide editor

The slide editor now has a proper line tool and a new `line` element. It covers the toolbar menu, the line formatting controls, connectors that snap to shapes, the data model, PowerPoint import/export and the assistant. `npm run typecheck` and `npm test` pass. I haven't run the editor in a browser, so the drawing, dragging and snapping interactions are untested beyond the unit tests.

- **Editor:**
  - **Line menu:** Line, Arrow, Elbow connector and Curved connector. Click-drag to draw; shift snaps to 15°.
  - **Selected line:** two endpoint handles, plus a mid handle on elbows only.
  - **Connecting:** dragging an endpoint near a shape shows its four side-midpoint connection points and snaps to them.
  - **Formatting:** the toolbar sets color, weight, dash, and start and end arrowheads (none, arrow, open, triangle, circle, diamond).
  - **Following:** connected lines follow when a shape moves or resizes, and elbows re-route. Dragging only the line detaches it. Arrowheads render in the editor, present mode, thumbnails and `render_slide`.
- **Model:** a line is stored as a box plus `flipH`/`flipV`, with `kind`, stroke color/width, dash, arrowheads and optional start/end connections. Old horizontal, vertical and diagonal line shapes are converted when a deck loads, and `shape: "line"` input from the assistant is converted too.
- **PowerPoint:** import maps lines, straight, bent and curved connectors, head/tail ends, dash, flips and connection ids to the new model. Export writes `bentConnector3` for elbows, `curvedConnector3` for curves and `line` for straight lines, with flips, dash and arrowheads.
- **Not done:**
  - Export doesn't write connection ids, because pptxgenjs can't name the shapes a connector attaches to.
  - Vertical-first elbows export with horizontal-first routing.
  - Curved connectors have no mid handle.
  - I didn't check the acceptance example on the real "Supercog Ops Map" deck. A test builds the same elbow, bottom of one box to top of another, and checks that it follows when the box moves.

**Assistant:** no new tool. `edit_elements` now creates and edits lines with `type: "line"`:
- `x1`, `y1`, `x2`, `y2`: the endpoints.
- `kind`: `straight`, `elbow` or `curved`.
- `stroke`, `stroke_width`, `dash` (`solid`, `dash`, `dot`).
- `start_arrow`, `end_arrow`: `none`, `arrow`, `open`, `triangle`, `circle` or `diamond`.
- `connect_start`, `connect_end`: `{element_id, site: top|right|bottom|left}`, or `null` to detach.
- The old `arrow` input still works. `read_deck` reports all of these fields for lines.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-06.

### Request

Goal: add a proper line tool to the slide editor like Google Slides, plus matching assistant support.

Problems today (seen on slide 2 of deck "Supercog Ops Map", id c346ac44-a2cb-438f-ae1e-2b0bd3fdfa1d, a redrawn architecture diagram):
- Lines are a "shape: line" whose direction is only horizontal (h=0), vertical (w=0) or a bounding-box diagonal. There are no true endpoints, so you cannot draw a line from one point to another, flip it, or drag its ends.
- Arrowheads set via edit_elements `arrow` ("start"/"end"/"both") were silently not rendered on freshly created lines at first and appeared later; behaviour was inconsistent. Arrowheads should always render for lines in the editor, present mode, render_slide and thumbnails.
- Elbow routes (e.g. down, left, down into a box) had to be faked with 3 separate line segments plus text glyphs (▼ ▶) as arrowheads.

Requested:
1. Toolbar line tool (like Google Slides' Line menu): Line, Arrow, Elbow connector, Curved connector. Click-drag on the canvas to draw from point A to point B (shift = snap to 15 degree angles). Selected line shows two endpoint handles (and a mid handle for elbow/curve) rather than an 8-handle bounding box; endpoints can be dragged freely, and the line may point in any direction (store x1,y1,x2,y2 or box+flipH/flipV).
2. Line formatting in the toolbar/side panel: stroke color, weight, dash style (solid, dash, dot), start and end arrowheads (none, arrow, open arrow, triangle, circle, diamond).
3. Connectors that snap to shapes: dragging an endpoint near a shape's edge midpoints shows connection points; once connected, the line follows when the shape is moved/resized. Elbow connectors re-route automatically.
4. Data model: line elements with points (x1,y1,x2,y2), kind (straight|elbow|curved), strokeColor, strokeWidth, dash, startArrow, endArrow, optional startConnection/endConnection {elementId, site}. Migrate existing horizontal/vertical/diagonal line shapes without visual change.
5. PPTX import/export: map connectors (straightConnector1, bentConnector2-5, curvedConnector2-5, line) with headEnd/tailEnd, dash, flips, and connection ids (stCxn/endCxn) to this model and back.
6. Assistant tool edit_elements: support creating/editing lines with x1,y1,x2,y2, kind (straight|elbow|curved), stroke, stroke_width, dash, start_arrow/end_arrow (arrowhead style), and connect_start/connect_end {element id, site: top|right|bottom|left}. read_deck should report these fields. Keep the old `arrow` input working. The render_slide output must show the arrowheads.
Acceptance example: on slide 2, one elbow connector from the bottom of the '1.2 Fetch Rolling Window' box to the top of the '2. In-Memory Cache' box, with an arrowhead at the end, replaces the three separate line segments and the ▼ text glyph, and follows if the boxes are moved.

Files: client/src/agent/deckTools.test.ts, client/src/agent/deckTools.ts, client/src/deck/DeckEditor.tsx, client/src/deck/DeckToolbar.tsx, client/src/deck/SlideView.tsx, client/src/deck/controller.ts, client/src/deck/renderSlide.ts, client/src/deck/store.ts, client/src/styles.css, server/agent/prompt.ts, server/agent/tools.ts, server/pptxImport.test.ts, server/pptxImport.ts, server/sheets.ts, shared/deck.ts, shared/lines.test.ts, shared/lines.ts, shared/pptxExport.ts

Job: 94d872f8-2d83-4cc3-b6af-316987e9d5b2
## 2026-10-05 — Arc shape: bounding box should fit the arc, not the full ellipse

Arcs now use a tight box around the visible stroke (path bounding box plus half the stroke width), and typecheck and all 177 tests pass. I haven't run the app, so the editor's endpoint-drag handles are untested.

- **Model:** the arc's ellipse is derived from the tight box, the angles and the stroke width, so resizing the box scales the arc. A new `tight` flag marks arcs in this form. Existing full-ellipse arcs are converted on load, and also when read, rendered or exported, so they look the same.
- **Rendering, editor and PPTX:** the editor and present-mode rendering use the derived ellipse. A selected arc shows two endpoint handles instead of the eight box handles. Dragging an endpoint rotates it about the fixed center, so the arc can no longer be resized by dragging its box; resizing works through the tool or by changing the box values. PPTX import converts to the tight box, and export converts back to the full ellipse box plus angle adjustments.
- **`edit_elements` / `read_deck`:** for arcs, `x/y/w/h` are the box around the visible stroke, and `read_deck` reports the same. I added optional `cx`, `cy`, `radius` (or `rx`/`ry`) inputs that create an arc from its center, radius and angles, with the box computed. Changing only the angles or stroke of an existing arc keeps its ellipse.
- **Backward compatibility:** I did not add a way to create an arc by giving the full ellipse box. When an assistant passes `x/y/w/h` with angles, they are taken as the tight box, so the old full-ellipse form would make a much larger arc than intended. Those callers should use `cx/cy/radius` instead.

No new tool was added.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-05.

### Request

Background: the new "arc" shape (shape: "arc", start_angle, end_angle in degrees clockwise from 3 o'clock) currently uses the full bounding box of the underlying ellipse as the element's x/y/w/h, even when only a short arc is drawn. So selecting a short arc shows a huge box (e.g. 223x223 for a 35-degree arc), which is confusing to move/resize, and the selection handles don't relate to the visible arc.

Requested change: make the element's box tightly bound the visible arc stroke (the bounding box of the arc path from start_angle to end_angle, plus half the stroke width), and keep the underlying ellipse geometry implicit/derived. Resizing the box should scale the arc (the ellipse radius/center are recomputed so the arc still spans the same angles). Ideally the selected arc shows just two adjustment handles at its endpoints that can be dragged to change start_angle and end_angle (dragging an endpoint rotates it around the ellipse center); the center and radii stay fixed while dragging the endpoints.
Details:
- Rendering (editor, present mode, render_slide, thumbnails): draw the arc path inside the tight box by computing the ellipse implied by the box + angles.
- Data model: keep start_angle/end_angle; store enough to reconstruct the ellipse (e.g. internal ellipse center/radii, or derive from box+angles so the box fully determines it). Existing arcs stored with the full-ellipse box must be migrated/handled so they render identically (convert to the tight box on load).
- PPTX import: OOXML arc has the full ellipse box with adj1/adj2; convert to the tight box on import, and on export convert back to the full ellipse box with adj values so PowerPoint renders it identically.
- edit_elements / read_deck: x,y,w,h report the tight box. For backward compatibility an assistant should still be able to create an arc by giving the full ellipse box plus angles; document the semantic in the tool description (x/y/w/h = bounding box of the arc itself) and, if feasible, add optional inputs to create an arc from center, radius and angles.
Example: slide 3 of deck cd1049a6-e261-4f30-a8ea-9844582a4c00 has four arcs with box x=180,y=187,w=223,h=223 and angles 310-345, 20-55, 125-160, 195-230; each should end up with a small box around just its own stroke, with two endpoint handles.

Files: client/src/agent/deckTools.test.ts, client/src/agent/deckTools.ts, client/src/deck/DeckEditor.tsx, client/src/deck/SlideView.tsx, client/src/deck/controller.ts, client/src/deck/store.ts, server/agent/tools.ts, server/pptxImport.ts, shared/deck.test.ts, shared/deck.ts, shared/pptxExport.ts, shared/shapes.ts

Job: 2780a844-b313-4b1d-8db6-b0326046fecd

## 2026-10-05 — Support "arc" shapes in PPT import and editor

Typecheck and all 175 tests now pass. The one failure, `google sign-in > is off unless configured` in `server/app.test.ts`, wasn't caused by the arc change. The test builds the app with no `google` option, so the app read Google credentials from the environment here. I made the test clear `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` before building the app, so it no longer depends on the machine's environment. I couldn't read the environment variables directly to confirm they were set, so that cause is inferred from the code and the passing run. No new assistant tool; the arc support from before is unchanged: `edit_elements` takes `shape: "arc"`, `start_angle` and `end_angle`.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-05.

### Request

Problem: When importing a PPTX, shapes of type "arc" (DrawingML preset geometry "arc", with adj1/adj2 start/end angles) are converted to plain rectangles, and the import banner says: 'Imported with some changes: Shapes of type "arc" were drawn as rectangles. (4x)'. Example: deck "biztrip_data_story_slides (1)" (id cd1049a6-e261-4f30-a8ea-9844582a4c00), slide 3 had four arcs forming a circular loop around the 'TRAVEL GRAPH' circle (each at x=180,y=187,w=223,h=223); they rendered as four stacked square outlines.

Requested change:
1. Add a shape kind "arc" to the slide shape model (alongside rect, rounded, ellipse...), rendered in the editor, present mode and render_slide as an open stroke-only path along the ellipse inscribed in the shape's box, from a start angle to an end angle (degrees, clockwise from 3 o'clock, as in OOXML). No fill. Honor stroke color and stroke_width.
2. Add optional numeric shape properties start_angle (default 270) and end_angle (default 0), mapped from OOXML adj1/adj2 (60000ths of a degree) on import.
3. PPTX import: map prstGeom "arc" (ideally also "blockArc") to this shape, preserving angles, line color/width, rotation and flips; remove 'arc' from the unsupported list that triggers the warning banner. Export, if present, should write prstGeom arc.
4. edit_elements tool: add "arc" to the shape enum, plus start_angle and end_angle number inputs; read_deck should report them.
Acceptance: re-importing the PPTX shows four proper circular arcs on slide 3 with no 'arc' warning.

Files: client/src/agent/deckTools.test.ts, client/src/agent/deckTools.ts, client/src/deck/ShapeIcon.tsx, client/src/deck/SlideView.tsx, server/agent/tools.ts, server/app.test.ts, server/pptxImport.test.ts, server/pptxImport.ts, shared/deck.ts, shared/pptxExport.ts, shared/shapes.ts

Job: beff67d3-aa14-4d33-b074-11d3acfaa66b

## 2026-10-05 — Make the slide thumbnail tray and the Assistant panel resizable

I added drag handles to the slide thumbnail tray and to the Assistant panel, and the Assistant handle works in both the Slides and spreadsheet views. You can drag a handle, double-click it to reset, or focus it and use the Left/Right arrow keys to resize in 16px steps. The tray stays between 120 and 400px (default 200), its thumbnails scale with it at 16:9, and the slide canvas or sheet grid shrinks to fit. The Assistant panel stays between 280px and the smaller of 800px or half the window (default 380), and widths are saved in localStorage under `ui.slideTrayWidth` and `ui.assistantPanelWidth`. Typecheck and tests pass, including new tests for the size limits and saving in `client/src/panelSize.test.ts`, but I haven't tried the dragging in a browser, and there is no new assistant tool. One limit: the middle stays at least 400px wide in most cases, but in a narrow window with both panels wide it can still drop below that.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-05.

### Request

What the user asked for: in the presentation (Slides) editor, both side panels should be adjustable in width:
1. The left tray of slide thumbnails.
2. The Assistant chat panel on the right. This panel is shared with the spreadsheet view, so make it resizable there too.

Today both panels have fixed widths.

Desired behavior:
- Each panel gets a vertical drag handle on its inner edge: the right edge of the thumbnail tray, the left edge of the Assistant panel. The handle is a thin hit area of about 6px that shows a col-resize cursor on hover and a subtle highlight line on hover and while dragging.
- Dragging resizes the panel live, and the slide canvas / sheet grid in the middle reflows to fill the remaining space. The slide canvas should rescale to fit, keeping its 16:9 aspect ratio.
- Sensible limits. Thumbnail tray: min about 120px, max about 400px, default the current width. Thumbnails scale with the tray width and keep 16:9. Assistant panel: min about 280px, max about 50% of the viewport or 800px, default the current width. Also make sure the center area never drops below about 400px.
- Double-clicking a handle resets that panel to its default width.
- Persist each width per user in localStorage (e.g. keys "ui.slideTrayWidth" and "ui.assistantPanelWidth") so it survives reloads and switching between documents.
- Avoid text selection and iframe/canvas pointer capture issues while dragging: use pointer events with setPointerCapture, and set user-select: none on the body during the drag.
- Keyboard accessibility: the handle is focusable (role="separator", aria-orientation="vertical", aria-valuenow/min/max), and the Left/Right arrow keys resize in 16px steps.

Example: in deck bc8596c9-dccc-41a7-806a-68d9b2516ddb ("BizTrip AI Q3 2026 Investor Share Deck Sept 11"), the user should be able to drag the thumbnail tray narrower and the Assistant panel wider to read long replies, and the slide canvas in the middle shrinks to fit.

Please add tests for the clamping and persistence logic if the codebase has a pattern for UI unit tests.

Files: client/src/agent/AgentPanel.tsx, client/src/components/ResizeHandle.tsx, client/src/deck/ThumbnailStrip.tsx, client/src/pages/DeckPage.tsx, client/src/panelSize.test.ts, client/src/panelSize.ts, client/src/styles.css

Job: 3328b6da-054a-4d6d-8281-d680756a47b8

## 2026-10-05 — Add a tool to render a slide as an image so the assistant can check its work

Typecheck and all 153 tests now pass. The one failing test was picking up this machine's `AGENT_MODEL` setting, so I set it to empty in the test config (`vite.config.ts`) and the test now checks the default model again.

The new assistant tool, **render_slide**, takes a PNG of a slide using the app's own slide renderer, with the same fonts, theme, images and text wrapping. Its inputs are `slide` (required, 1-based), `scale` (0.5–2, default 1 = 960×540) and `deck_id` (defaults to the open presentation, including unsaved edits). It returns the stored /api/images/... address, the pixel size, and an `overflow` list of text boxes and shape labels whose text is bigger than their box. Two limits: the picture comes in the message right after the tool results rather than inside them, and the image-making step is covered by unit tests but hasn't been tried in a real browser. Shape labels now follow the `size`, `font`, `bold` and `color` set through edit_elements instead of always showing at 18pt, and the assistant is told to render and check a slide after building or changing it.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-05.

### Request

What the user asked for: the assistant should be able to take a screenshot of a slide to visually check its own edits. Today the assistant only has read_deck, which returns element geometry and text but not what actually renders. That caused a real failure: on deck bc8596c9-dccc-41a7-806a-68d9b2516ddb, slide 16 (a roadmap slide built from about 80 shapes and text boxes), labels set via the shape "text" property ignored the requested "size" (9pt) and rendered at a much larger default. Text wrapped and overlapped badly, and the assistant had no way to see it until the user sent a screenshot.

Proposed tool: render_slide
- Inputs: slide (integer, 1-based, required); optional scale (number, default 1 = 960x540 px; allow 0.5 to 2); optional deck_id (string, defaults to the open presentation).
- Behavior: render the slide on the server exactly as the editor/presenter shows it: the same fonts (Poppins, Inter, etc.), theme, background, images, shapes with their labels, text wrapping, line height and valign. Produce a PNG. Use the same rendering code path as the client if possible, e.g. headless browser rendering of the slide view route, so the image matches what the user sees. Don't build a separate approximate renderer.
- Returns: the PNG as an image content block the model can view directly, i.e. an image in the tool result rather than just a URL. Also return a stored /api/images/... address, plus the slide number and pixel dimensions.
- Optional but valuable: also return an "overflow" list of text elements whose rendered text is taller or wider than their box, with id, box h and rendered height. Overlaps can then be caught even without looking closely.
- Errors: clear messages if no presentation is open or the slide number is out of range.

Related bug worth fixing in the same change, if it's simple: edit_elements accepts size/font/bold/color for shape elements that have a "text" label, but the shape label rendering seems to ignore "size" (and maybe font), so labels render far too large. Either honor those properties for shape labels, or document that they aren't supported.

Also update the system prompt / tool guidance: after building or significantly changing a slide, call render_slide and check the result before reporting back to the user.

Example: render_slide({slide: 16}) on the deck above should return a 960x540 PNG of the roadmap slide (timeline track, quarter columns, item tags), which the assistant then inspects for overlapping or overflowing text.

Files: client/src/agent/AgentProvider.tsx, client/src/agent/clientTools.ts, client/src/agent/deckTools.test.ts, client/src/agent/deckTools.ts, client/src/agent/describe.ts, client/src/deck/SlideView.tsx, client/src/deck/fonts.ts, client/src/deck/renderSlide.ts, server/agent/prompt.ts, server/agent/tools.ts, shared/agent/protocol.ts, shared/deck.ts, shared/pptxExport.ts, vite.config.ts

Job: 48c50fe9-ce3b-4453-94cd-630981cd4698

## 2026-10-05 — Drag a column to a new position

You can now reorder columns by dragging: select one column or a block of adjacent columns by its header, then drag the header. A drop line shows where they will land, Escape cancels, and one undo reverses the whole move. Everything travels with the columns (values, formatting, width, filter settings, images, links), formulas on any tab are updated to keep pointing at the same data, and the moved columns stay selected; typecheck and all tests pass, though I haven't tried the drag in a browser. I also added a new assistant tool, `move_columns(from_column, to_column?, before_column, tab?)`, which places a column or block (from `from_column` through `to_column`, which defaults to `from_column`) immediately left of `before_column` on the given tab (the active tab by default) and returns the new range. For example, `move_columns(from_column="F", before_column="E")` swaps the two balance columns. A range formula like `SUM(A:B)` drops a column that is moved out of it and widens if one is moved into it, and the frozen-column count does not change.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-05.

### Request

The user wants to reorder columns in a spreadsheet by dragging. Today the only ways to reorder are manual cut/paste or insert/delete columns. 

UI: In the grid, the user clicks a column header letter to select the column (or a contiguous multi-column selection), then presses and drags that header; a drop indicator line shows the target column boundary; on release the selected column(s) move there. Dragging should work on the selected columns only (drag starting on an unselected header just selects it as today). Escape cancels the drag. Undo (Cmd/Ctrl+Z) must reverse the whole move in one step.

Behavior: moving column(s) shifts the columns in between by the width of the moved block. Everything travels with the column: values, formulas, formatting, column width, filter state, and images/links. Formulas elsewhere in the workbook (including on other tabs) that reference moved or shifted cells must be updated so they keep pointing at the same data (same as how insert/delete columns rewrite references). Filter range, frozen columns and the selection should follow sensibly (selection ends up on the moved columns in their new position).

Also add an assistant tool move_columns with inputs: from_column (string, column letter, e.g. "F"), to_column (optional string, last column of a block when moving several, defaults to from_column), before_column (string, the column letter the block should be placed in front of; the block ends up immediately left of it), tab (optional string, defaults to active tab). Returns the new range of the moved columns. Example: on the 'Accounts' tab of 'Brex Card Transactions' (columns id, name, status, primary, current_balance, available_balance, currency), move_columns(from_column="F", before_column="E") swaps available_balance in front of current_balance.

Files: client/src/agent/clientTools.test.ts, client/src/agent/clientTools.ts, client/src/agent/describe.ts, client/src/grid/Grid.tsx, client/src/grid/render.ts, client/src/state/controller.ts, client/src/state/ops.test.ts, client/src/state/ops.ts, server/agent/tools.ts, shared/agent/protocol.ts, shared/formula/adjust.ts

Job: 88c2ef97-a49a-4d6c-a263-1b31d04db093

## 2026-10-04 — Add Connectors framework with Brex connector

I've added the Connectors framework with Brex as the first connector, and three new assistant tools. Typecheck and all tests pass, but I couldn't run the client build here (it needed approval), so the new page has been type-checked but not built or opened in a browser.

Users connect Brex on a new Connectors page, reachable from the home page and from File > Data connectors… in a sheet. They paste a read-only Brex user token, which is tested before saving and stored encrypted; afterwards the app shows only "Connected" and the last four characters. The OAuth sign-in plumbing for future connectors is also in place.

The new tools:
- **`list_connections()`** returns the user's connections (id, connector, name, status) and each connector's datasets with their parameters. Brex has `card_transactions`, `cash_transactions`, `cash_accounts`, `cards`, `users`, `expenses` and `budgets`. Date-based datasets accept a start date, `last_days` (e.g. 30) or `end_date`, and every dataset accepts `limit` (default 5000 rows, up to 50,000).
- **`fetch_connector_data(connection_id, dataset, params?, preview_rows?)`** returns a preview (20 rows by default), the total row count, whether the data was cut off at the row limit, and a `result_handle`. It doesn't write to the sheet.
- **`ingest_connector_data(connection_id, dataset, params?, result_handle?, tab?, start_cell = "A1", mode = "replace" | "append")`** writes a header and all rows into the open sheet in one undoable step, creating the tab if needed. Numbers and dates go in as real values and existing formatting is kept. It returns the rows and range written and whether the data was cut off. Pass `result_handle` from an earlier preview to write that result without fetching again.

The assistant never sees credentials and is told to send users to the Connectors page rather than accept keys in chat. Saving the ingest settings for a later "Refresh" was optional and is not built. How to add a connector is documented in `docs/connectors.md`, linked from the README.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-04.

### Request

User request: add a "Connector" feature to the Sheets app so a user can connect dynamic external data sources and pull their data into a spreadsheet. The interactive agent (the assistant with sheet tools) must be able to use connectors when the user says e.g. "ingest Brex card transactions from the last 30 days into this sheet". The first connector is Brex.

1. Connector framework (generic, extensible)
- Define a connector interface/registry in the codebase: id, display name, icon, auth type(s), config fields, and a list of "datasets" (named, parameterised queries) each with: id, description, parameter schema (e.g. start_date, end_date, limit), and a fetch function that returns a tabular result (header row + rows of primitive values).
- Auth types supported by the framework: (a) API key / token (user enters one or more secret fields in the UI), and (b) OAuth 2.0 authorization-code flow (UI "Connect" button -> provider consent -> callback route in the app -> tokens stored, refresh handled automatically). Brex ships with API key first; the OAuth plumbing (callback route, state/CSRF param, token refresh) should be built generically so future connectors (e.g. Google, Stripe, QuickBooks) can use it. 
- Credentials are stored server-side per user, encrypted at rest, never returned to the browser after saving (UI shows only "Connected" + masked suffix) and never exposed to the agent or written into cells. Agent tools must reference connections by id only.

2. UI
- A "Connectors" page reachable from the home page (and a menu entry inside an open sheet). It lists available connectors (Brex to start) and the user's configured connections with status (connected / error / needs reauth), last used time, and Disconnect / Edit / Test connection actions.
- Setup dialog per connector driven by the connector's config schema: for Brex, a password-style field for the Brex User Token (API key) with a short help text on how to create one in Brex dashboard (Developer > User Tokens) and the scopes needed (read-only: transactions, cards, users, accounts, expenses, budgets). A "Test connection" button calls a cheap Brex endpoint (e.g. GET /v2/users/me or /v2/accounts/cash) and shows success/failure before saving. Allow a user-chosen connection name (e.g. "Brex - Production").

3. Brex connector
- Base URL https://platform.brex.com, auth header "Authorization: Bearer <token>". Handle cursor-based pagination (next_cursor) and 429 rate limits with retry/backoff; cap rows per ingest (default 5000) and report truncation.
- Datasets: 
  - card_transactions: GET /v2/transactions/card/primary (params: posted_at_start, limit/cursor) -> columns: id, initiated_at, posted_at, description, merchant, amount (decimal, USD, convert from minor units/cents), currency, card_id, user/expense id where available, status.
  - cash_transactions: GET /v2/transactions/cash/{cash_account_id} (param account id; if omitted, iterate over accounts from /v2/accounts/cash).
  - cash_accounts: GET /v2/accounts/cash -> id, name, status, current balance, available balance.
  - cards: GET /v2/cards -> id, last four, card name, status, owner user id, card type.
  - users: GET /v2/users -> id, name, email, status, department/location where present.
  - expenses: GET /v2/expenses/card (with expand for merchant/budget/user) -> id, date, merchant, amount, category, memo, status, budget, user.
  - budgets: GET /v2/budgets -> id, name, status, amount, period.
  Each dataset should be easy to add to later.

4. Agent tools (exposed to the interactive assistant, alongside the existing sheet tools)
- list_connections(): returns the user's configured connections (id, connector type, name, status) and for each connector type the available datasets with descriptions and parameter schemas. No secrets.
- fetch_connector_data(connection_id: string, dataset: string, params?: object, preview_rows?: integer): runs the query server-side and returns a preview (header + first N rows, default 20) plus total row count and a result handle, without writing to the sheet.
- ingest_connector_data(connection_id: string, dataset: string, params?: object, tab?: string, start_cell?: string default "A1", mode: "replace" | "append" default "replace"): fetches the data and writes header + rows into the open spreadsheet (creating the tab if it does not exist), writing real numbers and ISO dates (not strings) and keeping existing formatting; returns rows written, range written, and whether truncated. Writing should be done in bulk, not cell by cell, so thousands of rows are fast.
- If no connection exists for the requested source, the agent should tell the user to set one up on the Connectors page (optionally with a link) rather than asking for a key in chat. The agent must never ask for or accept API keys in the chat.
- Optionally store the ingest definition (connection, dataset, params, target tab/range) in sheet metadata so a "Refresh" action can re-run it later; this is a nice-to-have and can be a follow-up.

5. Example: with the Brex connection "Brex - Production" configured, the user opens a blank sheet and says "Pull my Brex card transactions since 2025-01-01 into a tab called Brex Transactions". The agent calls list_connections, then ingest_connector_data(connection_id, "card_transactions", {posted_at_start:"2025-01-01"}, tab:"Brex Transactions"), and replies with a one-line summary such as "Wrote 842 rows to 'Brex Transactions'!A1:I843."

6. Quality: errors from Brex (401 invalid token, 403 missing scope, 429, 5xx) must map to clear messages in the UI and in tool results. Add tests for pagination, amount conversion, and credential redaction. Add a short README/docs section on how to add a new connector.

Files: README.md, client/src/agent/AgentProvider.tsx, client/src/agent/clientTools.test.ts, client/src/agent/clientTools.ts, client/src/agent/describe.ts, client/src/api.ts, client/src/commands.ts, client/src/main.tsx, client/src/pages/ConnectorsPage.tsx, client/src/pages/HomePage.tsx, client/src/pages/SpreadsheetPage.tsx, client/src/styles.css, docs/connectors.md, server/agent/prompt.ts, server/agent/tools.ts, server/app.ts, server/connectors.test.ts, server/connectors/brex.ts, server/connectors/secrets.ts, server/connectors/service.ts, server/connectors/types.ts, server/db.ts, shared/agent/protocol.ts, shared/connectors.ts

Job: 5591e071-c7ed-4851-a4d7-a268757a2924

## 2026-10-04 — Add word wrap cell style

I added a word-wrap cell style, and `format_range` now takes a `wrap` boolean: `true` wraps text onto several lines within the cell width, `false` puts it back on one line, where it can spill into empty cells to the right. `read_range` with `include_formats` reports wrapped cells as `wrap: true`. There's also a "Wrap text" toolbar button and a Format-menu item that toggle wrap for the selected range. Rows don't grow to fit wrapped text: text taller than the row starts at the top and is cut off at the bottom, so you'd need to resize the row to see it all. Typecheck and tests pass, including new tests for the tool and the line-breaking.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-04.

### Request

The user wants word wrapping as a cell style in the spreadsheet app. Today format_range supports align, bold, italic, underline, strikethrough, colors and number formats, but no wrap option. Please: (1) add a word-wrap cell style to the app's cell format model and render it (wrapped text, row grows or text wraps within the cell width), with a toolbar/menu control to toggle it for the selected range; (2) add a boolean `wrap` property to the format_range tool (true = wrap text, false = no wrap), and make read_range include_formats report it. Example: in the 'AI startups list' sheet, Sheet1 columns E:F (investors and descriptions, ~350px wide) and I (notes) hold long text; format_range(range="E2:F32", wrap=true) should wrap the text within those cells. The user currently has F1:F1000 selected.

Files: client/src/agent/clientTools.test.ts, client/src/agent/clientTools.ts, client/src/commands.ts, client/src/components/Toolbar.tsx, client/src/grid/render.test.ts, client/src/grid/render.ts, client/src/state/controller.ts, server/agent/tools.ts, shared/types.ts

Job: f89bf1f5-2526-4ea8-a93a-20348cb2ed3b

## 2026-10-03 — Add clickable hyperlink support in cells (open in new tab)

I added clickable links to cells, and typecheck and all tests pass. Cells whose whole text is an http(s) URL (like the album links in D2:D33) and `=HYPERLINK(url, [link_label])` formulas now show as blue, underlined links. Clicking the link text (or Cmd/Ctrl+click while editing) opens it in a new tab; only http(s) and mailto links open, and "n/a (original)" stays plain text. New assistant tool: `set_cell_link(range, url, label?, tab?)` turns the cells into links showing `label` (or the URL) by writing a HYPERLINK formula, so links survive sorting, copy/paste and saving, and `read_range` now lists link cells under `links` with their URLs. I haven't tried it in the running app. One thing to know: a plain click on a link's text opens it, so to edit a link cell, double-click beside the text or press Enter.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-03.

### Request

Add general hyperlink support to cell contents in the spreadsheet app.

Requirements:
1. Rendering/interaction: cells containing a link are displayed as links (blue, underlined) and clicking one (or Cmd/Ctrl+click while editing) opens the URL in a new browser tab with target="_blank" and rel="noopener noreferrer". Only allow http(s) and mailto URLs.
2. Auto-detect: plain-text cell values that are a full http(s) URL (e.g. "https://en.wikipedia.org/wiki/Eat_a_Peach") should render as clickable links without changing the stored value.
3. Formula: support =HYPERLINK(url, [link_label]) like Google Sheets. It shows link_label (or the url if omitted) and opens url in a new tab on click. Add HYPERLINK to the supported function list.
4. Assistant tool: add set_cell_link(range: string, url: string, label?: string, tab?: string) which makes the cell(s) display label (or the url) as a hyperlink, so the assistant can create links without formulas. Also have read_range report link cells with their url.
5. Links must survive sorting, copy/paste, and saving.

Concrete example: on tab "WC Farm Mkt March" of "Higher Ground Master Set List", D2:D33 contain plain-text Wikipedia album URLs (e.g. D2 = https://en.wikipedia.org/wiki/Eat_a_Peach). After this change these should be clickable and open in a new tab; D18:D19 contain "n/a (original)" and should stay plain text.

Files: client/src/agent/clientTools.test.ts, client/src/agent/clientTools.ts, client/src/agent/describe.ts, client/src/grid/Grid.tsx, client/src/grid/render.ts, client/src/state/ops.test.ts, client/src/state/store.ts, server/agent/tools.ts, shared/agent/protocol.ts, shared/agent/sheetRead.ts, shared/formula/engine.test.ts, shared/formula/engine.ts, shared/formula/functions.ts, shared/links.ts

Job: 6750fa6b-07a1-4621-91de-bd73429c764c

## 2026-10-03 — Add web search and image search tools

I added two assistant tools, `web_search` and `image_search`, which use the Brave Search API with a key held on the server. Both take `query` (text) and `max_results` (optional, default 5, max 10), allow 20 searches per minute per user, and give clear errors when there are no results or the API fails. `web_search` returns each result's title, url and snippet. `image_search` returns title, image_url, source_page_url, width and height, where image_url is a checked direct link to a PNG, JPEG, GIF or WebP file that works with `set_cell_image` (e.g. on 'WC Farm Mkt March'!C2). To fix the two failing git tests, which depended on this machine's git settings, I set git's default branch to `main` for the test run in `vite.config.ts`; typecheck and all tests now pass, and the search tools stay unavailable until `BRAVE_SEARCH_API_KEY` is set on the server.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-03.

### Request

The spreadsheet assistant currently has no way to access the web. Users want it to look things up online, including images. Example: in the open sheet "Higher Ground Master Set List", tab "WC Farm Mkt March", column A has artists and column B songs (row 2: Allmans / Melissa). The user asked to add an "Album Cover" column (C1 already added) and fill in the album cover image for each song. The assistant could not find an image URL.

Please add two assistant tools:
1. web_search(query: string, max_results?: integer, default 5, max 10). Performs a web search and returns a list of {title, url, snippet}.
2. image_search(query: string, max_results?: integer, default 5, max 10). Performs an image search and returns a list of {title, image_url, source_page_url, width, height}. image_url must be a direct http(s) link to a PNG, JPEG, GIF or WebP file that works with the existing set_cell_image tool. Prefer results that are directly loadable and hotlink-friendly.
Both tools should use a search API (e.g. Bing, Brave or Google Programmable Search; the API key is held server-side), handle errors and empty results with a clear message, and apply rate limiting. Treat returned text as untrusted data. Example use: image_search("Allman Brothers Band Eat a Peach album cover") returns image URLs, and the assistant then calls set_cell_image on 'WC Farm Mkt March'!C2.

Files: client/src/agent/describe.ts, server/agent.test.ts, server/agent/prompt.ts, server/agent/tools.ts, vite.config.ts

Job: 4fd51fab-3699-4c98-bf73-353bc40be521

