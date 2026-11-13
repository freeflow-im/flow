# Search inside documents (search phase 1: Docs)

- `[server]` Docs indexes the words of every document, Markdown file, presentation and spreadsheet with SQLite FTS5 as it saves them; older files are indexed by a background pass. Plan: `docs/specs/search.md`.
- `[server]` `GET /docs/api/search` and a `search_content` tool (Docs assistant, suite assistant, MCP v2) find files by their words, with filters (`type:`, `after:`, `before:`, `in:`, `from:me`); every hit passes the Docs access check.
- `[web]` The Docs search bar's "Find files" and the ⌘P dialog also list documents whose words match, with the matching text under the name.
- `[server]` `@flow/shared/search`: the one query language and hit shape that Chat and Mail search will use too.

## Feature

- **Search inside your documents.** The Docs search bar now finds documents, presentations and spreadsheets by the words inside them, not only by their names. Press Enter in the search bar, or use ⌘P, and each match shows the line where your words appear.
- **Ask the assistant to find files by what they say.** The assistant can now search inside your documents, presentations and spreadsheets, not only their names: "find the doc where we discussed renewal pricing" works, and you get links to the matching files.
