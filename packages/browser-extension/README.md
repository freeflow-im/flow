# FreeFlow Browser (Chrome extension)

Two things (design: `docs/specs/browser-extension.md`):

- **A side panel, per tab.** The toolbar icon opens Chrome's side panel with the person's assistant, for that tab only
  (it hides on other tabs). `panel.html?tab=<id>` frames the suite's `/home/browser` page (`packages/home/src/browser/`),
  signed in with the person's FreeFlow session. Opening the panel on a tab lets the agent use that tab from the panel
  (every tool but close; its first tool there asks for the site, as anywhere). Each message carries the panel's tab, which `background.js` reads
  for it (`page`, only for the panel's frame and its key). Stop is in the panel's footer and on the icon's right-click
  menu.
- **Web tools.** The assistant opens and uses pages in its own tabs, in a "FreeFlow agent" tab group. The page's side is
  `packages/docs/client/src/agent/browserBridge.ts`.
- **Sites the assistant may use** (`sites.js`). Before the assistant uses a site that is not on the list, the extension
  asks (a card in the panel, else `ask.html` in a small window): Always, This session or Don't allow. A
  `declarativeNetRequest` session rule blocks other sites' pages in the agent's tabs. The panel's **Settings** tab lists,
  adds and removes sites. Tests: `pnpm --filter @flow/browser-extension test`.

## Two builds

| | Dev build (this folder, unpacked) | Customer build (`package.mjs`) |
|---|---|---|
| Name | FreeFlow Browser (dev) | FreeFlow Browser |
| Id | `gnmcgiakoiplophhcoekeeaghfiipglo` (fixed by `key`) | given by the Chrome Web Store |
| Messaged by | app.freeflow.im, localhost, 127.0.0.1 | app.freeflow.im only |
| `debugger` permission | yes (background-tab screenshots) | no (shows the tab for a moment) |

Dev: `chrome://extensions` → Developer mode → Load unpacked → this folder. The dev build's panel opens production by
default; to use a local suite (`pnpm dev:suite`), open **Suite address (dev build)** at the bottom of the panel and
enter `http://localhost:8787` (or your port). The store build always opens production.

## Releasing to the Chrome Web Store (unlisted)

1. Bump `version` in `manifest.json` in the PR that changes the extension (the store needs a higher version on every upload).
2. `node packages/browser-extension/package.mjs` → `packages/browser-extension/dist/freeflow-browser-<version>.zip`.
   To test it first, load `dist/freeflow-browser` unpacked (it gets a random id, so the web app will not find it
   until the store id is in `browserBridge.ts`).
3. Upload the zip in the [developer dashboard](https://chrome.google.com/webstore/devconsole) → the item → Package → Upload new package, then Submit for review.

### First upload only

- Create the item with the zip, set **Visibility: Unlisted**, and fill in the listing from `STORE_LISTING.md`.
- Copy the item id the store gives it into `BROWSER_EXTENSION_STORE_ID` in `browserBridge.ts` and merge that, so the
  web app finds the store build.
