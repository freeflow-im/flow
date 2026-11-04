# @flow/mail — FreeFlow Mail

The suite's mail client, served at `/mail`. People connect the mail accounts they already have (Gmail with an app
password, iCloud, Outlook, Yahoo, Fastmail, any IMAP/SMTP server) and read, search, organise and send mail beside Chat
and Docs. The client only talks to the edge Worker's `/v1/mail/*` API (`packages/edge/src/routes/mail.ts`); the
Worker holds the credentials and speaks IMAP and SMTP.

## Architecture

- **Vite + React 19 + Tailwind v4**, built for the base path `/mail/`. The layout started from shadcn/ui's Mail example
  (MIT, see `LICENSE-shadcn.md`); `src/components/ui/` holds the few shadcn primitives it uses, on Radix.
- `src/api.ts` — the API contract as typed functions (`mailApi`), and the types the server returns. A 401 sends the
  browser to the suite's sign-in (`/?next=/mail…`).
- `src/hooks/mail.ts` — react-query: accounts, folders and the open folder's messages (infinite, paged with `before=`)
  are polled every 60 s while the tab is visible and on window focus. An inbox tab's page that comes back short with
  `sorting` is asked for again every 2 s until it is full. Flag, move and delete update the cached lists at once and roll
  back on failure.
- `src/App.tsx` — the layout: the suite bar (`MailSuiteBar.tsx`, with `@flow/suite-bar`), the resizable folder panel
  (`Sidebar.tsx`), the list (`MessageList.tsx`) and the reading pane (`MessageView.tsx`, `MessageBody.tsx`), side by
  side from 900px, one at a time below, with the folders behind a button under 760px. It also owns the keyboard
  (j/k, Enter, e, #, r, a, f, c, u, /, Esc).
- `src/components/Compose.tsx` — compose, reply, reply all, forward: address chips (`AddressField.tsx`), TipTap
  StarterKit with Link (`Editor.tsx`, loaded on first use), attachments as base64 up to 20 MB in all.
- `src/components/AccountForms.tsx` — adding an account (email → `/v1/mail/providers` → name and password, Advanced
  for the servers) and changing or removing one.
- `src/components/InboxTabs.tsx` — Gmail's inbox tabs above the INBOX list for an account with tabs on (the server
  sorts the mail: docs/specs/mail-api.md, Inbox tabs), each its icon and name, without counts. The tab is in the
  address (`&tab=`). "Move to tab" is in the dense list's row menu, the bulk actions and the message's Move menu, and
  with a mouse a row (or the checked rows) drags onto a tab or a folder (`src/lib/dnd.ts`); it moves the sender's mail,
  with Undo.
- `src/components/AssistantPanel.tsx` — the suite bar's Assistant: a resizable panel on the right (over the mail under
  1100px), open or closed per browser. It is Docs' assistant (`hooks/assistant.ts` talks to `/api/agent*` in the selected
  organization's Docs, chat `mail`), told what is open (`lib/assistant.ts` `mailContext`), and it drafts but never sends:
  a draft it made has **Open draft** (Compose). Docs' protocol, stream reader, tool labels and reply Markdown come from
  Docs' sources (`src/lib/docsAgent.ts`); docs/specs/web-mcp.md, The assistant in Mail.
- `src/lib/` — the pure parts, with tests: `sanitize.ts` (HTML), `addresses.ts` (chips), `compose.ts` (reply and
  forward prefill), `folders.ts` (folder order and tree), `tabs.ts` (inbox tabs), `dnd.ts` (dragging rows), `format.ts`.

## Running it

Against the mock (no server; sample data in `mock/data.ts`, served by a Vite middleware, `mock/plugin.ts`):

```sh
pnpm --filter @flow/mail dev:mock          # http://localhost:5185/mail/
MAIL_MOCK=empty pnpm --filter @flow/mail dev   # starts with no account: the "Connect your mail" screen
```

In the mock's Add account flow the password `wrong` answers `auth_failed`, a server host containing `bad` answers
`connect_failed`, and `stale` connects an account whose password then stops working (the re-enter banner).

Against a real API: `pnpm --filter @flow/mail dev` proxies `/v1` to `MAIL_API` (default `http://127.0.0.1:8787`, the
edge Worker's `wrangler dev`). Sign in on that origin first so the `sid` cookie is set.

Checks: `pnpm --filter @flow/mail typecheck` and `pnpm --filter @flow/mail test`.

## Deploying

`pnpm --filter @flow/mail build` writes `dist/`. Production builds it in the server's image
(`packages/server/deploy/aws/Dockerfile`), and `deploy-edge.yml` copies `packages/mail/dist` out of that image like
the other clients; `packages/edge/scripts/assemble.mjs` files it under `public/mail` with its page as
`_pages/mail.html`, which `src/routes/pages.ts` serves for `/mail` and `/mail/*` (a stranger is sent to sign in).

## Security: rendering a message

A message's HTML is written by its sender and is never put in the page as it is:

1. **DOMPurify** (`src/lib/sanitize.ts`, its own instance) removes scripts, event handlers, forms and inputs, frames,
   objects and embeds, `<base>`, `<meta>`, `<link>`, SVG and MathML, `srcset`, and URLs other than http(s), mailto,
   tel, cid and data.
2. **Remote content waits.** Remote images, `background` attributes and CSS `url()`s (inline and in `<style>`) are
   removed until the reader presses "Show images" (they would tell the sender when and where the message was read).
   `cid:` images point at the message's own attachment with `?inline=1`.
3. **A sandboxed iframe.** The cleaned HTML is shown with `<iframe srcdoc sandbox="allow-popups
   allow-popups-to-escape-sandbox allow-same-origin">`: no `allow-scripts`, so nothing in it can run even if it got
   past step 1. `allow-same-origin` is there only so the page can measure the document's height; it is safe only
   because scripts are off. Links open in a new tab (`<base target="_blank">`, `rel="noopener noreferrer"`).
4. **A Content Security Policy** in the document (`default-src 'none'; script-src 'none'; img-src` this origin,
   `data:` and, once allowed, `https:`) is the last line: a remote image that slipped past step 2 is still refused.

Plain-text messages are rendered by React (escaped), with web and email addresses made links. Quoted text in a reply
or forward goes through the same cleaning (with remote images off) before it enters the editor.
