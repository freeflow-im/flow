# FreeFlow Mail — v1 API contract (server ⇄ client)

Users connect EXISTING mail accounts (Fastmail, iCloud, Outlook/Office 365, Yahoo, Gmail with an app password, company IMAP).
No hosted mailboxes. All routes are on the edge Worker (`packages/edge`), session-authenticated exactly like the other
`/v1/*` routes (Bearer token or the `sid` cookie). Every account belongs to one user (not shared with the org).
JSON everywhere unless noted. Errors: `{ "error": { "code": string, "message": string } }` with a 4xx/5xx status;
codes used: `auth_failed` (mail server refused the login), `connect_failed` (could not reach / TLS failed),
`not_found`, `bad_request`, `rate_limited`, `server_error`.

## Types

```ts
type Security = 'tls' | 'starttls' | 'none'; // 'none' only allowed when the Worker's MAIL_ALLOW_INSECURE=1 (local dev)
interface ServerSettings { host: string; port: number; security: Security; username?: string } // username defaults to email
interface MailAccount {
  id: string; email: string; displayName: string;
  imap: ServerSettings; smtp: ServerSettings;
  status: 'ok' | 'auth_failed' | 'connect_failed'; statusMessage?: string;
  tabs: TabCategory[];                         // inbox tabs that are on besides Primary; [] (the default) = tabs off
}
type Category = 'primary' | 'promotions' | 'social' | 'updates' | 'forums';
type TabCategory = Exclude<Category, 'primary'>;
interface MailFolder {
  path: string; name: string; delimiter: string;
  specialUse: 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged' | null;
  unread: number; total: number;
}
interface Address { name: string; address: string }
interface MessageSummary {
  uid: number; folder: string;
  messageId: string | null;
  from: Address | null; to: Address[]; cc: Address[];
  subject: string; snippet: string;            // snippet: first ~160 chars of text, may be '' if not cheaply available
  date: string;                                // ISO
  seen: boolean; flagged: boolean; answered: boolean;
  hasAttachments: boolean; size: number;
  category?: Category;                         // INBOX only, and only when the account has tabs on
}
interface TabCount {
  id: Category; unread: number;
  new: number;                                 // unread that arrived after the tab's `since` (all unread without one)
  latest: { from: Address | null; subject: string } | null;
}
interface MessageDetail extends MessageSummary {
  replyTo: Address[]; bcc: Address[];
  inReplyTo: string | null; references: string[];
  html: string | null;                         // raw HTML from the message; THE CLIENT SANITIZES (DOMPurify + sandboxed iframe)
  text: string | null;
  attachments: { index: number; filename: string; mimeType: string; size: number; contentId: string | null; inline: boolean }[];
}
```

## Routes

- `GET  /v1/mail/providers?email=` → `{ imap: ServerSettings, smtp: ServerSettings, name: string, appPasswordUrl?: string } | null`
  Presets by domain (gmail.com/googlemail.com, icloud.com/me.com/mac.com, outlook.com/hotmail.com/live.com, office365 via MX not needed, yahoo.com, fastmail.com/fastmail.fm). Also try MX lookup for custom domains if cheap (optional).
- `GET  /v1/mail/accounts` → `{ accounts: MailAccount[] }`
- `POST /v1/mail/accounts` body `{ email, displayName, password, imap: ServerSettings, smtp: ServerSettings }`
  → verifies IMAP login AND SMTP login before saving; `201 { account: MailAccount }` or 4xx with `auth_failed`/`connect_failed`.
- `PATCH /v1/mail/accounts/:id` body: any of `{ displayName, password, imap, smtp, tabs }` (re-verifies when credentials/servers change;
  never for `displayName` or `tabs` alone) → `{ account }`. `tabs` is stored once each, in the order promotions, social, updates, forums.
- `DELETE /v1/mail/accounts/:id` → `{ ok: true }` (forgets the credentials and any cache)
- `GET  /v1/mail/accounts/:id/folders` → `{ folders: MailFolder[] }` (INBOX first, then special-use folders, then the rest alphabetically)
- `GET  /v1/mail/accounts/:id/messages?folder=INBOX&limit=50&before=<uid>&q=<text>`
  → `{ messages: MessageSummary[], next: number | null }` newest first. `before` pages older (uids < before). `q` = IMAP SEARCH TEXT/OR FROM/SUBJECT in that folder.
  `&category=<Category>` (INBOX, tabs on) lists one tab: Primary is everything not in an *enabled* tab, and a tab that is off is
  empty. It is ignored while `q` is given (a search covers the whole folder, as Gmail's does) and when the account's tabs are off.
  A tab's page may come back short, even empty, with `next` set: see Inbox tabs below.
- `GET  /v1/mail/accounts/:id/categories?folder=INBOX&since=promotions:<ms>,social:<ms>` → `{ categories: TabCount[] }` for Primary
  plus the enabled tabs, in the bar's order. `since` is when the user last opened each tab (ms since the epoch), for `new`.
  Another folder is `bad_request`.
- `POST /v1/mail/accounts/:id/messages/category` body `{ folder: 'INBOX', uids: number[], category: Category }` ("Move to tab")
  → `{ ok: true, senders: string[], previous: { address: string, category: Category | null }[] }`. The tab is kept for each
  message's sender, so their later mail goes there too; `previous` is what each sender had, for undo.
- `POST /v1/mail/accounts/:id/senders/category` body `{ senders: { address: string, category: Category | null }[] }` → `{ ok: true }`
  sets the tab chosen for senders, or forgets it (`null`, back to the automatic one): how a move is undone.
- `GET  /v1/mail/accounts/:id/messages/:uid?folder=` → `{ message: MessageDetail }` (does NOT mark it seen; the client PATCHes seen)
- `GET  /v1/mail/accounts/:id/messages/:uid/attachments/:index?folder=` → the bytes, with Content-Type and
  `Content-Disposition: attachment; filename*=…` (`?inline=1` → `inline`, used for cid: images).
- `PATCH /v1/mail/accounts/:id/messages` body `{ folder, uids: number[], seen?: boolean, flagged?: boolean }` → `{ ok: true }`
- `POST /v1/mail/accounts/:id/messages/move` body `{ folder, uids: number[], to: string }` → `{ ok: true }`
- `POST /v1/mail/accounts/:id/messages/delete` body `{ folder, uids: number[] }` → moves to Trash (or expunges if already in Trash) → `{ ok: true }`
- `POST /v1/mail/accounts/:id/send` body
  `{ to: Address[], cc?: Address[], bcc?: Address[], subject: string, html: string, text?: string, inReplyTo?: string, references?: string[], attachments?: { filename: string; contentType: string; contentBase64: string }[] }`
  → sends over SMTP as the account (From = displayName <email>), appends a copy to the Sent folder (skip if the provider auto-saves, e.g. Gmail),
  sets \Answered on the replied message when inReplyTo matches; → `{ ok: true, messageId: string }`. Max 20 MB total.

## Inbox tabs

Gmail's Primary, Promotions, Social, Updates and Forums, for INBOX only. Each tab but Primary is switched on per account
(`tabs`); mail is sorted into the enabled ones by itself and the rest stays in Primary.

- **Gmail** (`imap.gmail.com`, or the server announces `X-GM-EXT-1`): Gmail's own categories, by `X-GM-RAW` searches in INBOX
  (`category:promotions` and so on; Primary is INBOX less the enabled ones). Gmail's labels are never changed: the user's
  choices are ours, folded into the query (`-from:` for a sender moved away, `OR (from:…)` for one moved in) by `gmailQuery`.
- **Other servers**: `src/imap/categorize.ts` classifies a message from its From and a few headers (`CATEGORY_HEADERS`:
  List-Id, List-Unsubscribe, List-Post, Precedence, Auto-Submitted, Feedback-ID, X-Mailer, the ESPs' X-Campaign/X-MC-/X-SG-/
  X-SES- headers, X-GitHub-Reason, X-Google-Group-Id, Return-Path, ...) and gives a reason with each answer. In order: the
  user's choice for the sender; Social (a social network's domain); Updates for GitHub (as Gmail does); Forums (List-Post,
  Google Groups, Mailman, Discourse, groups.io); Promotions (a marketing sender's headers or bounce domain, a campaign
  Feedback-ID, or List-Unsubscribe with nothing transactional about it); Updates (auto-generated, no-reply/notifications
  senders, transactional services, trackers, receipts); else Primary.
- The answer is cached in the Mail object's SQLite, `mail_categories` keyed `(account_id, folder, uid_validity, uid)` with the
  sender, From name, subject and arrival time (for the counts' `latest` and `new`). It stores the headers' category; the
  user's choices (`mail_category_overrides`, per sender) and which tabs are on apply when reading, so neither re-classifies.
  A list page of INBOX fetches the headers with its summaries and classifies what is new; the counts classify the unread
  that are not cached yet, then the newest 50, and forget cached UIDs that have left the folder.
- A tab's list walks INBOX newest first, classifying uncached UIDs in batches of 100, until it has `limit` messages, the
  folder ends, or 300 headers have been fetched in that request; `next` is then one above the first UID not looked at, so
  the client carries on with `before=next`.

Polling: the client re-reads folders + the open list every 60 s while the tab is visible, and on window focus. (Push over the
websocket is a later phase.)

## Local dev fixture

A GreenMail server runs in Docker as `flow-greenmail`: SMTP on 127.0.0.1:3025, IMAP on 127.0.0.1:3143, plain (no TLS), any
user/password logs in (accounts are created on first use, e.g. ann@test.local / any password). Use host `127.0.0.1`, not
`localhost` (nodemailer resolves names over DNS inside workerd and `localhost` fails). Do NOT stop or restart that container.
Proven in a spike: imapflow 2.10.0, nodemailer 7 and postal-mime 2 all work inside workerd with `nodejs_compat`
(IMAP list/fetch/download/flags/append, SMTP send with attachments, TLS to imap.gmail.com:993 and imap.fastmail.com:993).
Bundle cost ≈ 600 KiB gzip.

## The server (packages/edge)

- `src/routes/mail.ts` authenticates the caller (Bearer or `sid`, through the Directory) and forwards every `/v1/mail/*`
  request to that person's **Mail** Durable Object (`MAIL`, class `Mail`, `idFromName(userId)`, migration `v4`). It answers
  `GET /v1/mail/providers` itself, from the preset table in `src/imap/rules.ts`.
- `src/imap/object.ts` is the Mail object. Its SQLite holds `accounts` (servers as JSON, the password sealed with
  FLOW_DATA_KEY through `org/crypto` `encryptBlob`, never returned or logged, and the `status` the client shows) and
  `rate_limit_windows` (the Directory's fixed window: 10 account verifications per person per 15 minutes, on `POST` and on a
  `PATCH` that changes the password or servers). While awake it keeps one ImapFlow connection per account (over
  `cloudflare:sockets`, which does both TLS and STARTTLS), reuses it, holds a mailbox lock per operation, reconnects once if
  it had dropped, and logs out after 60 s idle. The folder list is cached in memory for 5 minutes (Trash and Sent lookups);
  the last three parsed messages are kept so a message's inline images do not each download it again.
- SMTP is nodemailer. The copy in Sent is the same message (Bcc kept) appended with `\Seen`, skipped for Gmail; a `Sent`
  folder is created when the account has none. `\Answered` is set on the INBOX message whose Message-ID is `inReplyTo`.
- Only IMAP 993 (tls) / 143 (starttls) and SMTP 465 (tls) / 587 (starttls), and no host that is `localhost` or an IP literal
  in a private range. `MAIL_ALLOW_INSECURE=1` (given with `--var` to `wrangler dev`, never in `wrangler.toml`) lifts all of
  it, for GreenMail.
- Errors: a refused login is `auth_failed` and an unreachable server `connect_failed`, both **422** so the client never takes
  them for its own session expiring; a missing folder, message or attachment is `not_found`; a refused body is `bad_request`.
- `attachments/:index?inline=1` is only inline for an image type; every attachment is served with
  `Content-Security-Policy: sandbox` and `nosniff`, since it comes from the app's own origin. `contentId` is given without
  its angle brackets, as a `cid:` URL names it.
- Tests: `src/imap/*.test.ts` (ports, hosts, presets, the FETCH-to-summary mapping, snippets, the tab rules) and `test/e2e-mail.mjs` against
  GreenMail (its header says how to run it).
