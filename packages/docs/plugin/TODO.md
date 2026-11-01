# Docs in ChatGPT: road to the app store

What stands between the proof of concept (see [README.md](README.md)) and a listing in the ChatGPT app
store. Roughly in priority order; the first three change the outcome the most.

## 1. Open in the full app

From the library (home page) and from every open document, presentation and spreadsheet, one click opens
the same file in the full app on **freeflow.im**: `/doc/<id>`, `/d/<id>` or `/s/<id>` under `APP_URL`
(the plugin already knows it as `publicUrl`). Links must open in a new browser tab through the host
(ChatGPT's iframe cannot navigate the top window), and the user lands signed in: the full app shares the
plugin's accounts, so a browser that already signed in through OAuth has a session; otherwise the app's
sign-in page should return to the requested file after sign-in.

- [x] "Open in Freeflow" on each library tile and in each editor's toolbar
- [x] host helper to open an external link (`plugin/web/host.ts`)
- [x] `returnTo` on the app's sign-in page (already there: the sign-in page returns to the requested file)

## 2. Onboarding for new users

A store user arrives with no account. The OAuth sign-in page assumes one exists.

- [ ] Lead with "Continue with Google" in the OAuth popup
- [ ] Password sign-up inside the OAuth flow, including the email verification link finishing the flow
- [ ] Empty library state: templates or a one-click sample document, so the first prompt has something to act on

## 3. Per-conversation open-file state

The open file, cursor block, selection, current slide and active tab live per account on the server
(`FileService.setOpen`). Two ChatGPT threads, or phone and desktop, overwrite each other: "make this
shorter" in one thread acts on the other thread's selection.

- [ ] Key the open-file and cursor state by widget instance or conversation
- [ ] `set_open_file` and `app_state` carry that key; model tools default to the calling conversation's file

## 4. Concurrent edits

A stale save reloads the server's version, so up to ~1 s of typing is lost when the model saves while the
user types.

- [ ] Show "updating" while a model edit is in flight and hold local keystrokes until the reload lands
- [ ] Or rebase the pending ProseMirror steps onto the server version (documents first; decks and sheets later)

## 5. Production-only path

- [ ] Deploy only the in-app mount (`PLUGIN_ENABLED=1` on the hosted app); the tunnel and standalone server stay for local testing
- [x] Refuse to start in production when `PLUGIN_USER_EMAIL` is set (it disables auth for every request)
- [x] Replace the placeholder URL in `mcp.json`

## 6. CSP and hosting under review conditions

The bundle is inlined because developer mode runs with CSP off and hosted scripts were unreliable. After
review the declared `resourceDomains` are enforced.

- [ ] Test the app with CSP enforced before submitting
- [ ] Consider serving the bundle from the public origin with a content-hash URL
- [x] Derive the `ui://` resource URI from the bundle hash instead of bumping `app-v9` by hand

## 7. Mobile and theme

ChatGPT renders apps on phones and in dark mode.

- [ ] Document editor usable at phone width
- [ ] Read the host theme (light/dark) and follow it
- [ ] Decks and sheets: a read-mostly view on small screens

## 8. Scale hygiene

- [ ] Make the 2.5 s `app_state` poll cheap (revision-only) and slower when the tab is idle
- [ ] Per-user rate limits on tool calls, uploads and imports
- [ ] Structured logging of tool calls with latency; error reporting

## 9. Store metadata and policy

The submission itself (the package, what is ready, what is not, and the review's test cases) is in
[SUBMISSION.md](SUBMISSION.md).

- [ ] Privacy policy, terms of service, support contact
- [ ] Icon assets, screenshots, a short demo; the name is "Universal Docs"
- [x] Fix descriptions that still say "documents and presentations" (`list_files`, `delete_file`, `plugin.json`)
- [ ] Golden prompts, verified against the real deployment: open a file by name, edit the selection,
      create from an attached .docx, delete with confirmation

## 10. Data lifecycle

- [ ] Account deletion that also revokes OAuth tokens
- [x] Data export (see section 11: per-file export routes and `GET /api/export.zip`)

## 11. Storage, backups and export

Today every document, presentation and spreadsheet is one JSON file in `sheets/` on the single
data volume, with metadata in `app.db` and images in `images/`. That is
the only copy. Use **Cloudflare R2** (S3-compatible; same Cloudflare account as email) to keep a second one.

Write-through first, R2 as primary later:

- [x] `S3ObjectStore` in `server/blob.ts` over the S3 client (`R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
      `CLOUDFLARE_ACCOUNT_ID` already exists); off when unset, so local development is unchanged
- [x] Every save also puts `users/<ownerId>/<kind>/<id>/<rev>.json` (revision-keyed, so R2 holds a history
      and a stale save never overwrites a newer object); `latest` pointer or a list by prefix finds the newest.
      Still to do: a lifecycle rule (or a purge step) that expires old revisions of live files
- [x] Images are put on upload (`users/<ownerId>/images/<id>`), branch bases alongside their branch
- [x] A save never fails because R2 is down: queue the put, retry with backoff, and log; a reconcile job
      (nightly, and `npm run r2:reconcile`) lists the volume and uploads anything missing
- [x] Daily `VACUUM INTO` snapshot of `app.db` and `plugin.db` to `backups/<date>/`, kept 30 days
- [x] `npm run r2 -- restore <dir>` rebuilds a data directory from R2 (newest revision of every file, images,
      latest DB snapshot); covered by a test against the in-memory store
- [ ] Run a restore once against the real bucket and a fresh volume
- [x] Soft delete: `delete_file` and the app's delete keep the R2 objects 30 days; "Trash" with Restore on the home page
- [ ] Later: R2 as the primary store for file bodies with the volume as cache, once the volume fills or a
      second replica is wanted

Export, one file at a time and all at once:

- [x] `GET /api/files/<id>/export?format=…` on the server: JSON for every kind; Markdown for documents,
      PPTX for presentations, CSV and XLSX for spreadsheets
- [ ] HTML export on the server (the editor's in-browser HTML download needs a DOM) and Word export (needs a
      `.docx` writer)
- [x] `GET /api/export.zip`: every file of the account as native JSON plus a readable format, with an
      `images/` folder. "Export all" on the home page
- [ ] The plugin's library and editors link to the per-file export and to "Export all" (the ChatGPT iframe
      has no app session, so the export routes would answer 401 unless the browser is signed in to the
      app; needs a sign-in redirect on those routes first)
