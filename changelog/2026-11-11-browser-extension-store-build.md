# FreeFlow Browser: customer build for the Chrome Web Store

- `[web]` `package.mjs` builds the store zip from the dev extension: no `key`, no localhost origins, no `debugger`
  (screenshots show the tab for a moment instead). Icons added; the unpacked build is now "FreeFlow Browser (dev)".
- `[web]` `browserBridge.ts` asks the store id, then the dev id (store id filled in after the first upload).
- `[web]` Privacy policy has a section on the extension, for the store listing.

## Feature

- **FreeFlow Browser for Chrome.** Your assistant can open and use web pages in its own tab group in Chrome. The
  extension is coming to the Chrome Web Store.
