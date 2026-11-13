# Markdown: `<img>` tags, and pasted pictures written as them

- `[web]` `[desktop]` The Markdown preview draws `<img>` tags (only src, alt, width, height, title; other raw HTML
  is still not drawn). Editing in the preview keeps a tag a tag and `![]()` as `![]()`.
- `[web]` `[desktop]` A pasted or dropped picture is written as `<img src alt width>`, its width the size it had on
  screen (a 2× screenshot shows at its real size).

## Feature

- **Picture sizes in Markdown.** `<img src="…" width="300">` now shows as a picture in Markdown documents, so you
  can set how big a picture appears. Pasted screenshots are added this way, at the size they were on your screen.
