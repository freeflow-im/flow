# Docs assistant: folder tools

- `[server]` The Docs assistant gets `list_folder`, `create_folder`, `move_file` (many files per call) and `delete_folder` (empty folders only; in an organization, only the folder's maker can delete it). They run in-process, and over HTTP in the suite.

## Feature

- **The assistant can organize your files.** Ask it to sort files into folders and it can create the folders, move documents, spreadsheets, presentations and stored files into them, and delete folders that are empty.
