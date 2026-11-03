# FreeFlow Mail's server: your own mail accounts over IMAP and SMTP

- `[server]` A `/v1/mail/*` API on the Cloudflare Worker (docs/specs/mail-api.md): connect an existing mail account (provider
  presets for Gmail, iCloud, Outlook.com, Yahoo and Fastmail), list folders and messages, read a message and its attachments,
  mark, move, delete and send. Each person's accounts are in their own Mail Durable Object, passwords sealed with FLOW_DATA_KEY.
- `[server]` Only encrypted connections on the standard ports (IMAP 993/143, SMTP 465/587) and no local or private hosts; a
  login is checked against both servers before an account is saved, and sign-in attempts are rate limited per person.
- `[qa]` `packages/edge/test/e2e-mail.mjs` runs the whole API against a GreenMail server under `wrangler dev`.

## Feature

- **Bring your own mail.** The groundwork for reading and sending mail from your existing accounts in FreeFlow: Gmail
  (with an app password), iCloud, Outlook.com, Yahoo, Fastmail or your company's mail server.
