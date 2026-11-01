---
name: mcp-docs
description: "Use the MCP Docs desktop app (its mcp-docs MCP server) to open, read, create and edit Word, PowerPoint and Excel files, Markdown, CSV, PDFs and pictures in the folder open in the app, which shows each file as you change it. Use it when the user asks to work on a document, presentation, spreadsheet, PDF or picture, to show them a file, or to connect to MCP Docs; also when an mcp-docs tool fails to connect."
---

# MCP Docs

MCP Docs is a desktop app (macOS) that edits the office files in a folder on this Mac: Word documents,
PowerPoint presentations, Excel spreadsheets, Markdown and CSV files, PDFs, pictures and videos. The person
opens a folder in the app; its files are the library, and its subfolders are the library's folders. The app
is also an MCP server for agents on the same machine, `mcp-docs` in this plugin (for Claude Code and Codex), so you and the person work on
the same files: what you open is shown in the app's window, and your edits appear there as you make them,
undoable like the person's own.

## Connecting

The server is the app itself, at `http://127.0.0.1:39217/mcp`. It only answers while the app is running.

- **Tools missing or failing to connect:** the app is probably not running. Start it with
  `open -a "MCP Docs"`, then retry the tool, or ask the person to reconnect `mcp-docs` (`/mcp` in Claude Code).
  In Codex, check it with `codex mcp list`.
- **Not installed** (`open -a` says it cannot find the app): ask the person to run `npx @freeflow-im/mcp-docs`, which
  installs the latest app and this plugin.
- **Signing in:** the first time, the agent signs in with OAuth: `/mcp` in Claude Code, `codex mcp login mcp-docs`
  in Codex. The app shows a dialog asking the person to allow the agent; nothing is entered in the browser. If a
  tool says the token was refused, have them sign in again the same way.
- **Port in use:** if another copy of the app holds the port, the app says so in File › Connect an Agent.
  Quit the other copy and start the app again.
- The person can see and disconnect connected agents in File › Connect an Agent (MCP)… in the app.

## The open folder

The tools work on the one folder open in the app, not on the whole disk. Folder paths in the tools
(`"Reports/2026"`) are relative to it, and `""` is its top. To open a file you know the path of, anywhere on
this computer, use `open_path`: a file in the open folder opens as `open_file` opens it; a file elsewhere opens
in a new tab of the app on its own folder, which the tools then work on. A file outside the open folder can
also be copied into it with `upload_file` (imported like any other).

The files are real files on disk, written back in their own format when changed: a document stays a
`.docx`, a presentation a `.pptx`, a spreadsheet an `.xlsx`. Use the tools rather than editing these files
on disk: the tools keep the formatting, show the change in the app, and are undoable there.

## How to work

1. **Find the file.** Work on the file open in the app unless the person names another: the tools act on it
   when no id is given. `search_files` finds files by name in every folder; `list_files` lists one folder.
2. **Show it.** `open_file` opens a file in the app's window so the person sees what you are doing. Open
   the file before a run of edits; do not open it again after each one.
3. **Read before you edit.** `read_doc` (documents, Markdown, and the text of PDFs), `read_deck`
   (presentations) and `get_sheet_overview` / `read_range` (spreadsheets) return the current content and
   what the person has selected; "this" or "here" means that selection. Block, slide and row numbers change
   after inserts and deletes, so read again before further edits.
4. **Keep edits targeted.** Change the blocks, slides, elements or cells that need changing rather than
   rewriting the file, and leave alone what the person did not mention. Write document content as Markdown,
   and spreadsheet formulas (starting with `=`) rather than computed numbers.
5. **New files:** `create_doc`, `create_deck`, `create_sheet`, and `create_folder` for folders. `import_file`
   brings in a file from a public web address.
6. **Reply briefly** with what changed.

## What can be done

- **Documents** (Word, Markdown): write, rewrite, restructure and format text, tables, pictures and videos.
- **Presentations** (PowerPoint): add, change, move and delete slides and their elements; set the theme.
  `render_slide` shows you a slide as the app draws it, to check your work; `export_deck` saves a PDF of it.
- **Spreadsheets** (Excel, CSV): read and write cells and formulas, format, sort, filter, freeze, and change
  rows, columns and tabs. A CSV file holds only plain values: formatting or more tabs need it converted,
  which the tool will say; ask the person first.
- **PDFs:** read their text with `read_doc`, or make an editable Markdown copy with `convert_pdf_to_markdown`.
- **Making a PDF:** `export_pdf` makes a PDF of a document, presentation, Markdown file or web page, next to it, as the app prints it.
- **Pictures** (PNG, JPEG, WebP): look at one with `view_image`; crop, rotate, resize, adjust, annotate,
  redact or remove the background (`remove_background`) with `transform_image`, which saves a new file
  unless you ask to replace the original. The app's window does the editing, so it must be open.
  To put one picture on top of another (a logo, a signature, a screenshot), upload it with `upload_file` if
  it is on your computer, then pass its id in `transform_image`'s `overlays`. With no `save`, the picture
  opens in the app's image editor with the overlay as a layer the person can still move and resize, and
  they save it there; tell them so.

Some things an Office file cannot hold (a picture inside a spreadsheet cell, a gradient, a video in a Word
document). When a tool refuses one of those, tell the person: the app can keep the file in its own format
instead, which they choose in the app.
