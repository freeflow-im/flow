# FreeFlow Mail: the client at /mail

- `[web]` New `packages/mail`: a Vite/React/Tailwind mail client (from shadcn/ui's Mail example) on the edge Worker's `/v1/mail` API — accounts, folders, list with infinite scroll, reading pane, compose/reply/forward with TipTap, bulk actions, keyboard shortcuts, 60 s polling.
- `[web]` Message HTML is cleaned with DOMPurify and shown in a sandboxed iframe without scripts, under a CSP; remote images wait for "Show images", `cid:` images use the attachment.
- `[web]` The suite bar's Mail tab is live in Chat and Docs; on a phone the bar's tabs and organization name shrink to fit three apps.
- `[server]` The edge Worker serves `/mail` (sign-in redirect when signed out) and its hashed `/mail/assets/`; the server image builds the client and deploy-edge copies it out.
- `[qa]` `pnpm --filter @flow/mail dev:mock` runs it against a sample mailbox with no server.

## Feature

- **Mail in FreeFlow.** Connect the mail you already have — Gmail, iCloud, Outlook, Yahoo, Fastmail or any IMAP server — and read, search, organise and send it from the new Mail tab, beside your chats and documents. Images from senders stay hidden until you choose to show them.
