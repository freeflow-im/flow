# Scratchpad opens at once

- `[web]` `[desktop]` The suite bar loads the scratchpad's frame, hidden, a moment after each page loads, so the first click opens on a ready board; the preload only finds the board and never makes one.
- `[server]` `POST /api/whiteboards/scratchpad` returns the board's content too (one request instead of two) and takes `make: false` to find without making.

## Feature

- **The scratchpad opens straight away.** Clicking the scratchpad button now shows your Global Scratchpad at once, instead of after a wait.
