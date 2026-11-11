# Docs: thumbnails load a few at a time

- `[web]` `[desktop]` The file list's thumbnail view loads at most three cards at once (newest first, a card that scrolls away is dropped) and pdf.js fetches only the parts of a PDF its first page needs. Why: a browser allows about six connections to a host, and in the desktop app each window keeps one or two open for its event streams, so a page of forty previews, PDFs and videos at once left the small preview requests waiting and the cards blank.

## Feature

- **File thumbnails show up again.** In the desktop app's folder view, thumbnails filled in slowly or stayed blank when a folder had many PDFs and videos. They now load a few at a time, visible ones first.
