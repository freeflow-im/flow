# FreeFlow Browser: a side panel to ask your assistant about the page you are on

- `[web]` The extension's toolbar icon opens Chrome's side panel: the suite's new `/home/browser` page in a frame, signed in with the FreeFlow session (framed only by the extension's two ids).
- `[server]` `[web]` Each message from the panel carries the page in front (`webPage`: address, title, selection, up to 20,000 characters of text), quoted to the model as data.
- `[web]` The agent may read and screenshot the person's tab from the panel only; clicks, typing and navigation stay in its own tabs (the extension enforces it). Stop moves to the panel and the icon's right-click menu. Extension 0.2.0.

## Feature

- **Ask your assistant about any web page.** Click the FreeFlow icon in Chrome to open a side panel with your assistant. Ask "Summarize this page" or "What are the key points?" and it answers from the page you are looking at. Take the page off a message with ✕ when your question is about something else.
