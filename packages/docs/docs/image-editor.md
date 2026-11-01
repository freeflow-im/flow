# Image editor

Status: the fork and phases 1 to 3 are built (editing an image file in the app and in the plugin, the
assistant in the app, and the assistant over the MCP). Of phase 4, pictures on slides and in
documents are built; those in spreadsheet cells are not. Decisions still open are listed at the end.

A full image editor for pictures stored as files, built so the same editor later edits pictures inside
documents, spreadsheets and presentations, and so the assistant (in the app and over the MCP plugin) edits
with the same engine the user does.

## Decisions made

- **Editor**: a fork of `@ascentsparksoftware/react-image-editor` (MIT, Fabric.js v7, React 19), at
  `freeflow-community/react-image-editor`. Its
  `EditorEngine` class does the editing; `<ImageEditor>` is the UI around it.
- **Why a fork**: npm only has 1.0.0, which exports cropped pictures at screen resolution. The fix (1.1.0) is
  in git only, so we build from git either way. The fork also adds what the assistant needs (below).
- **Agent edits run in the browser**, on the same engine, through a tool proxy. There is no server-side image
  engine and no browser-side agent.
- **Background removal** uses `@imgly/background-removal` (AGPL-3.0, accepted), loaded on demand.
- **First surface**: image files (`FilePage`). Embedded pictures come after.

## The fork

`freeflow-community/react-image-editor`, branch `freeflow/agent-api`, forked from upstream 1.1.0. The
changes are additive (new options default to upstream's behaviour) so rebasing stays cheap.

1. **A handle on the mounted editor.** `<ImageEditor onReady={(handle) => ...}>` gives `{ engine,
   refresh(), exportBlob() }`. The assistant calls the engine and then `refresh()` so the panels, history
   and layer list follow.
2. **Exports at the picture's own size.** Upstream exports an uncropped picture as the editing surface at
   its on-screen size (a 1600 px photo in a 900 px editor saves at about 500 px, with a margin). The new
   `exportBounds="image"` exports the picture's bounds at its real resolution. We always set it; without it
   Save would shrink every file.
3. **Size limits as options.** `maxImportDim` (upstream fixes 4096 px: larger pictures are shrunk on
   opening) and `maxExportPixels` (upstream fixes 4096²).
4. **Positioned operations**: `cropTo(rect)`, `addShapeAt(kind, style, { box } | { from, to })`,
   `addTextBox(text, style, { x, y, width })`, `addImageAt(src, { x, y, width?, height? }, { opacity })` (a picture
   on top, as a layer: the assistant's `overlay`), `redactRect(rect, mode)`, `setOutputWidth(width)`,
   `getOutputSize()`.
5. **Output-pixel coordinates.** Those methods take pixels of the picture as it would export right now
   (after any crop or rotation), converted to the engine's scene in `engine/output-space.ts`. That is the
   picture the model was shown, so they are the only coordinates it can know.
6. **One undo step per call.** `engine.batch(label, fn)` records a single history entry for everything
   done inside it.

Known limits, the same as upstream's interactive tools: a crop and an output width are not history steps
(undo does not restore them; `clearCropRegion()` and `setOutputWidth(null)` do), and the export never
scales a picture up.

The package sits in a subfolder of a workspace repository, which npm cannot install from a git address. See
"Open" for how the app gets it.

## Shared pieces (ours)

| Piece | Where | What |
|---|---|---|
| Operation vocabulary | `shared/imageOps.ts` | Zod schemas for the operations and their validation. No engine types. |
| Editor host | `client/src/image/ImageEditorHost.tsx` | Loads the fork and Fabric with a dynamic `import()`; takes `{ source: Blob, name, onSave(blob), onClose }`. Knows nothing about where the picture came from. |
| Active editor | `client/src/image/activeEditor.ts` | The engine of the open editor, if any, and a function that makes a hidden one for a picture. |
| Agent tools | `client/src/agent/imageTools.ts` | The only code that calls the engine for the assistant: turns operations into engine calls. |

Each surface supplies two things to the host: how to load its picture and what saving means. That is the
whole of what "usable from any document type" requires.

Operations (`shared/imageOps.ts`): `crop`, `rotate`, `flip`, `resize`, `adjust` (brightness, contrast,
saturation, vibrance, hue, blur), `look` (black and white, sepia, invert, sharpen, tint), `text`, `shape`,
`redact`, `remove_background`, `frame`, `background`.

## Phase 1: editing an image file

- `FilePage` gets an **Edit** button for PNG, JPEG and WebP, as it has for web pages (`HtmlEditor`). It
  swaps the preview for `ImageEditorHost` in `advanced` mode.
- Animated GIFs are not editable (the editor would flatten them); the button is disabled with a reason.
- **Save** replaces the file's bytes and keeps the version before, as text files do (`FileStore.update`,
  one step back with `/api/files/:id/revert`). Decided. **Save a copy** makes `name-edited.png` beside it and leaves
  the original.
- The saved picture keeps the file's type (PNG, JPEG or WebP); the server refuses any other.
- Server:
  - `PUT /api/files/:id` accepts image bytes for image files (same type as the file, size limit, no change
    of type). Today it refuses anything but text.
  - `GET /api/files/:id` served pictures as `immutable` for a year. Pictures that can be rewritten are now
    `no-cache` with an `ETag` (a 304 when unchanged), and the file page asks for a saved picture by a new
    address, so a copy cached before this change is not shown.
- Desktop app: `LocalFileStore` writes the real file in the folder, so Save rewrites it on disk.
- The plugin's `FileViewer` gets the same Edit button; it saves through one new app-only tool
  (`save_image_file`).

## Phase 2: the assistant in the app

Two tools, both browser tools (`CLIENT_TOOLS`), following "How to add an assistant tool" in `CLAUDE.md`:

- `view_image` exists. Its result gains the picture's pixel width and height, which the model needs for
  coordinates.
- `transform_image` is new: `{ file_id, operations: [...], save: 'copy' | 'replace' }` (copy is the default).
  The operations are applied by `client/src/image/imageOps.ts`.
  - Turning or flipping a picture that is already cropped or drawn on: the engine turns the photo alone,
    under its crop and its layers. A hidden engine flattens the picture first; in the open editor, whose
    layers must stay editable, the operation is refused with a message saying so.
  - Editor open on that file: the operations run on its engine as one undo step, the user sees them, and
    nothing is saved until the user saves (`save` is ignored and the result says so).
  - Otherwise: a hidden engine loads the file, applies the operations, exports, and saves as `save` says.
  - Either way the result picture is attached after the tool results (as `render_slide` does) so the model
    checks its own work.
- `edit_image` (the prompt-based edit through OpenAI) stays as it is. The prompt says when to use which:
  `transform_image` for exact edits, `edit_image` to redraw.
- `save: 'replace'` on a file asks the user first (`confirmationFor`).

## Phase 3: the assistant over the MCP

Built. MCP tools run on the server with no browser, so the plugin's app does the editing:

1. The model calls `transform_image`. The plugin server queues a job for the user and waits
   (`FileService.runImageJob`).
2. The app asks for `app_state` every few seconds while it is showing; the answer carries the jobs no app
   has taken yet.
3. The app does the job with the same code as the app's assistant (`plugin/web/imageJobs.ts`): in the
   editor when the picture is open in it, else with an engine off screen, saving the result through the
   upload route (`/plugin/import`, with `replace=<id>` to save over the file).
4. It answers with the app-only `image_job_result`, with a reduced copy of the result, and the MCP call
   returns that to the model as a picture.

- Model-facing tools: `view_image` (the picture and its size in pixels; a picture over 4 MB is reduced by
  the app, when it is showing) and `transform_image`. App-only: `image_job_result`.
- No app showing: nothing takes the job, and after 25 seconds the tool fails with "call open_file with this
  picture, then try again". A job an app took has 90 seconds.
- The plugin's viewer has the same Edit button as the file page (`ImageFileEditor`, with the plugin's own
  reading and writing in `plugin/web/imageStore.ts`).
- The editor and Fabric are inlined into the app's one script (2.9 MB to 4.4 MB; 1.33 MB gzipped): scripts
  loaded from our server were not reliable inside ChatGPT. Background removal is left out of the plugin: its
  model is a 24 MB file fetched from another origin, which the app's content policy does not allow.
- Saving over a file is not asked about first here, as it is in the app: an MCP host asks per tool, not per
  call. The version before is kept.
- The queue is in memory, which holds while the server is one process.

## Phase 4: pictures inside documents, spreadsheets and presentations

Presentations and documents are built; spreadsheets are not. The editor and the tools do not change: each
surface adds an entry point and a save.

| Surface | Entry | Save | Built |
|---|---|---|---|
| Presentation | Selected image element: "Edit image" in the toolbar, or a double-click | Upload, then `DeckController.replacePicture` | Yes |
| Document | Selected image block: "Edit image" in the toolbar, or a double-click | Upload, then `DocController.replaceImage` | Yes |
| Spreadsheet | Cell with an image | Upload, then set `img` in a `Tx` | No |

- `ImageEditDialog` (`client/src/image`) is the editor over the page for an embedded picture: it reads the
  picture from its address and hands the edited one to the page. While it is open the page leaves the
  keyboard alone (`imageDialogOpen`): a Backspace there deletes a layer of the picture, not the element.
- An embedded picture is never rewritten: a save uploads a new stored image and the old one stays, so undo
  on the page restores it. It may change type (a JPEG whose background was removed becomes a PNG).
- On a slide (`withEditedPicture` in `shared/deck.ts`): a picture that kept its shape only changes address.
  One that was cropped or turned loses the element's own crop and its box takes the new shape, at the same
  width and centre, made smaller if it would be taller than the slide.
- Slides also have a crop of their own, for the commonest edit, without opening the editor: "Crop" in the
  toolbar puts a frame on the picture (`CropOverlay`, geometry in `shared/deckCrop.ts`). It changes the
  element's `crop` and box, not the picture, so the picture can be cropped wider again later.
- In a document (`editedImageWidth` in `shared/doc.ts`): a picture with no width of its own keeps none; one
  that kept its shape keeps its width; one that was cropped or turned is shown at the same scale as before.
  The block is found again by its picture if the document changed while the editor was open.
- The assistant: `transform_image` takes `image` (a stored `/api/images/...` address) in place of
  `file_id`, stores the result anew and returns its address, which the model puts in place with the tools it
  has (`edit_elements`, `set_cell_image`, `insert_image`). Not in the plugin, whose `transform_image` edits
  stored files only.
- The plugin's document and presentation editors have the same Edit image (and slides the same Crop). The
  picture is read from `/plugin/img/<id>`, which answers any origin, and the edited one goes to the upload
  route with `image=1` (`storePicture` in `plugin/web/imageStore.ts`). There is no background removal there.
- A picture at another site's address can be edited only if that site allows it to be read; otherwise the
  dialog says so. A GIF is not edited.

## Testing

- `shared/imageOps.ts` and the coordinate maths: vitest.
- `imageTools.ts`: vitest against a fake engine (Fabric needs a real canvas, which vitest does not have).
- Engine changes: in the fork, with its own unit specs and Playwright suite.
- Server: `PUT` of image bytes, revert, cache headers.
- MCP: the job queue (pick-up, result, timeout, no widget) in `plugin/server/mcp.test.ts`.

## Open

Decided: the app installs the fork from a built tarball in `vendor/` (`npm pack` in the fork's
`packages/react-image-editor` after `npm run build`, then `npm install ./vendor/<file>.tgz`). Pictures open
at up to 8192 px on the long side and save with up to 64 megapixels (`client/src/image/limits.ts`); a larger
one is scaled down on opening, with a notice.

1. **Layers after saving.** A saved picture is flat; reopening it does not bring back text and shapes as
   objects. The engine can save its scene as JSON (`exportScene`), which could be kept beside the file. Not
   in phase 1.
2. **Offering the fork's changes upstream.**
3. **Faster pick-up of MCP jobs** than the poll interval, if the delay is noticeable.
