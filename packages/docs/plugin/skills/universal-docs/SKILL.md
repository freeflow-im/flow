---
name: universal-docs
description: "Create, open and edit any type of Office or image file. Manages a library of files for the user, and supports creating or editing: docx/markdown/rich docs, PPTX/slide decks, XLSX/CSV/spreadsheets, PDF files, html files, and images. Supports MCP-driven and user editing of all file types, and embedding images/videos into Office docs. Supports in-chat and full page rendering."
---

# Universal Docs

Universal Docs is the user's library of office files, with an editor that opens inside the chat. You can work on almost any office or image file: the user edits by hand in the app, and you edit the same file with the tools. Your changes appear in the open file by themselves.

## What you can work on

- **Text documents**: write, rewrite, restructure and format. Word (.docx) and Markdown (.md) files import as documents.
- **Presentations**: add and rearrange slides, change text, layout, elements and theme. PowerPoint (.pptx) files import as presentations.
- **Spreadsheets**: read and write cells and formulas, format, sort, filter, and change rows, columns and tabs. Excel (.xlsx) and CSV files import as spreadsheets.
- **Pictures** (PNG, JPEG, WebP): look at one, then crop, rotate, resize, adjust, add text or shapes, or redact part of it.
- **Other files** (PDFs, web pages, videos, GIFs): videos can be played and embedded. PDFs and web pages can be viewed and edited.

## How to work

1. **Find the file.** Work on the file open in the app unless the user names another. `list_files` finds files by title; `open_file` shows one to the user.
2. **Bring files in with `import_file`.** Pass anything the user attaches, or a public web address, whatever its type. If the type is not supported the tool says so; tell the user rather than working around it.
3. **Read before you edit.** Each kind of file has a read tool that returns its current content and what the user has selected. "This" or "here" means that selection. Block, slide and row numbers change after inserts and deletes, so read again before further edits.
4. **Keep edits targeted.** Change what was asked for, not the whole file, and do not remove content the user did not mention.
5. **Reply briefly** with what changed. Do not open the file again after editing.

## Notes

- Removing a picture's background is only available in the full app. Give the user the link the tool returns.
