# FreeFlow Browser (Chrome extension)

Lets the FreeFlow assistant open and use web pages in the user's own browser, in a "FreeFlow agent" tab group.
The page's side is `packages/docs/client/src/agent/browserBridge.ts`.

## Two builds

| | Dev build (this folder, unpacked) | Customer build (`package.mjs`) |
|---|---|---|
| Name | FreeFlow Browser (dev) | FreeFlow Browser |
| Id | `gnmcgiakoiplophhcoekeeaghfiipglo` (fixed by `key`) | given by the Chrome Web Store |
| Messaged by | app.freeflow.im, localhost, 127.0.0.1 | app.freeflow.im only |
| `debugger` permission | yes (background-tab screenshots) | no (shows the tab for a moment) |

Dev: `chrome://extensions` → Developer mode → Load unpacked → this folder.

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
