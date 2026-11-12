# The assistant finds and reads your files from any app

- `[server]` New server tools `search_files` (the user's stored files: PDFs, uploads, saved attachments) and `read_stored_file` (a file's text, a PDF's included, read without making anything), so the assistant can find and read files from Mail, Calendar, Home and Admin, not only on Docs' page (where `list_files` and `read_file` are browser tools). Mail's guidance says so; `pdfText` reads a PDF without creating a Markdown document.

## Feature

- Ask your assistant about a PDF or other file from Mail or Calendar ("summarize my spending in my October statement"): it finds and reads it, no link needed.
