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
  → `{ messages: MessageSummary[], next: number | null, sorting?: true }` newest first. `before` pages older (uids < before). `q` = IMAP SEARCH TEXT/OR FROM/SUBJECT in that folder.
  `&category=<Category>` (INBOX, tabs on) lists one tab: Primary is everything not in an *enabled* tab, and a tab that is off is
  empty. It is ignored while `q` is given (a search covers the whole folder, as Gmail's does) and when the account's tabs are off.
  A tab's page may come back short, even empty, with `sorting: true` and `next` while older mail is still being sorted
  into tabs: ask for the same page again shortly. See Inbox tabs below.
- `POST /v1/mail/accounts/:id/messages/category` body `{ folder: 'INBOX', uids: number[], category: Category }` ("Move to tab")
  → `{ ok: true, senders: string[], previous: { address: string, category: Category | null }[] }`. The tab is kept for each
  message's sender, so their later mail goes there too; `previous` is what each sender had, for undo.
- `POST /v1/mail/accounts/:id/senders/category` body `{ senders: { address: string, category: Category | null }[] }` → `{ ok: true }`
  sets the tab chosen for senders, or forgets it (`null`, back to the automatic one): how a move is undone.
- `GET  /v1/mail/accounts/:id/messages/:uid?folder=` → `{ message: MessageDetail }` (does NOT mark it seen; the client PATCHes seen)
- `GET  /v1/mail/accounts/:id/messages/:uid/attachments/:index?folder=` → the bytes, with Content-Type and
  `Content-Disposition: attachment; filename*=…` (`?inline=1` → `inline`, used for cid: images). `index` is the
  attachment's `index` in MessageDetail; see "Opening a message" for what it maps to.
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

- **Gmail** (`imap.gmail.com`, or the server announces `X-GM-EXT-1`): Gmail's own categories, asked of Gmail once per
  message and cached (below): `UID <min>:<max> X-GM-RAW "category:<tab>"` for each of the four categories over a batch of
  new UIDs (`gmailCategorySearches`), and one envelope FETCH of those UIDs for the sender, subject and date. A message in
  none of them is Primary. Gmail's labels are never changed: the user's choices ("Move to tab") are ours.
- **Other servers**: `src/imap/categorize.ts` classifies a message from its From and a few headers (`CATEGORY_HEADERS`:
  List-Id, List-Unsubscribe, List-Post, Precedence, Auto-Submitted, Feedback-ID, X-Mailer, the ESPs' X-Campaign/X-MC-/X-SG-/
  X-SES- headers, X-GitHub-Reason, X-Google-Group-Id, Return-Path, ...) and gives a reason with each answer. In order: the
  user's choice for the sender; Social (a social network's domain); Updates for GitHub (as Gmail does); Forums (List-Post,
  Google Groups, Mailman, Discourse, groups.io); Promotions (a marketing sender's headers or bounce domain, a campaign
  Feedback-ID, or List-Unsubscribe with nothing transactional about it); Updates (auto-generated, no-reply/notifications
  senders, transactional services, trackers, receipts); else Primary.
- **The cache** (both kinds of server): `mail_categories` in the Mail object's SQLite, keyed `(account_id, folder,
  uid_validity, uid)`, with the category (Gmail's, or the headers'), the sender, From name, subject and arrival time (for the
  list's summaries come from the server). The user's choices (`mail_category_overrides`, per sender) and which tabs are on are applied
  when reading, in SQL (`effectiveSql`: the sender's chosen tab, else the stored one, Primary for a tab that is off), so a
  "Move to tab" or its undo changes every cached row at once and nothing is sorted again. A new UIDVALIDITY drops the rows.
- **How far it reaches**: `mail_sync (account_id, folder) → uid_validity, high, low, checked_at`. Every UID of INBOX from
  `low` to `high` has its row; `high` is the high-water mark.
- **A tab's list never sorts a large batch before answering.** It asks only for UIDs above `high` (`UID SEARCH <high+1>:*`,
  usually a handful) and sorts at most 100 of them, the newest (the first time, the newest 100, found from UIDNEXT down
  with a widening `UID SEARCH <from>:<top>` window, never a search of the whole folder). More new mail than that: `low`
  moves up to what was sorted and the rest is the sorter's. Then the page is read from SQLite (`uid < before`, `uid >= low`,
  newest first) and the summaries of just those UIDs fetched in one FETCH (with the snippets' partial FETCHes). A UID the
  server no longer returns (moved by another mail app) is dropped from the cache.
- **Short pages** (`tabPage` in `categorize.ts`): when the cache ends before the page is full and older mail is not sorted
  yet (`low > 1`), the page comes back with what there is, `sorting: true` and `next` (where the cache ends). The client
  shows it at once with a "Sorting older mail…" row and asks for the same page again every 2 s until it is full or
  `sorting` is gone; only then does it go on to `next`. A client that carries on with `before=next` instead also gets
  every message once.
- **The sorter** (`sortSoon`): whenever a page comes back short, or fewer than two more pages of the tab are cached below
  it, a background run (`ctx.waitUntil`, never awaited by the request) extends the cache below `low`, 300 messages a step,
  each step under the sorter connection's lock by itself, until the tab has enough cached for the next two pages, the whole
  folder is cached, or 3000 messages were sorted in that run (the next page that needs more starts another). One run per
  account at a time; a newer request's target replaces the running one's. A step only lowers `low` from the value it read,
  so new mail sorted past a gap meanwhile is never skipped.
- **The background re-check**, at most every 10 minutes per account, started by a tab's list (`ctx.waitUntil`): over the
  newest 2000 cached messages only, `UID SEARCH <floor>:*` (their UID range) forgets the rows of mail that left INBOX, and
  on Gmail one `UID <floor>:* X-GM-RAW "category:<tab>"` search per category takes Gmail's current categories (re-sorting
  done on gmail.com or by Gmail itself). Older rows are left as they are. It runs on the sorter connection, so it never
  holds up a list.
- A list of the whole INBOX with tabs on (a search) carries each message's tab: other servers sort it from the headers fetched
  with the page, Gmail from the cache (sorting any UID it does not have).

The tabs have no counts: each is its name and icon (the open one blue, with the underline). The inbox's own unread count in
the left panel comes from `/folders`. In the list, rows can be dragged (mouse or trackpad only; touch screens and the
keyboard use the menus) onto a tab, which is the same "Move to tab" as the menu, or onto a folder, which is the same move as
"Move to"; dragging a checked row drags all the checked rows, and a drop on the open tab or folder does nothing.

Polling: the client re-reads folders + the open list every 60 s while the tab is visible, and both on window focus. (Push
over the websocket is a later phase.) After marking read or unread, flagging, moving or deleting, the client changes the
folder's unread count in its own cache at once (`packages/mail/src/lib/counts.ts`) and re-reads folders once, quietly, 4 s
after the last such change and once none is still on its way (so a burst of j/k is one refresh). Opening a message reads
the next (older) one ahead; it is marked read once it is on screen.

## Opening a message

`GET .../messages/:uid` never downloads the whole message: one FETCH of the summary, BODYSTRUCTURE and a few headers (From,
Reply-To, Bcc, In-Reply-To, References), then one FETCH of just the text/plain and text/html parts (`BODY[1.1]`, …;
`BODY[TEXT]` for a message that is not multipart), with any inline (cid:) picture up to 2 MB and any other part up to 64 KB,
8 MB in all. `src/imap/body.ts` rebuilds a minimal message of the same multipart tree holding those text parts as the server
holds them, and postal-mime parses it as it parsed the whole message before (charsets, quoted-printable/base64,
format=flowed, HTML made from text and the other way round). A text part over 10 MB is `413`.

- **Attachment indexes**: `planBody` walks BODYSTRUCTURE in order, as postal-mime walks the message: every leaf that is not an
  inline text/plain or text/html body, and is not empty, is the next attachment, `index` 0, 1, … Each index maps to its
  BODYSTRUCTURE part number, so `attachments/:index` FETCHes that one part (one round trip, decoded here) unless it came with
  the bodies. The order does not depend on what was fetched, so an index stays the same for a message.
- **Sizes**: an attachment fetched with the bodies has its exact size; a larger one's is its encoded size, less the base64
  overhead for base64 (within about 1%).
- **The exception**: a message with an inline `message/rfc822` part (a forwarded message postal-mime folds into the message's
  own text and attachments) is still downloaded and parsed whole, up to 50 MB, and its indexes are postal-mime's.
- The last three messages opened are kept with the parts fetched with them, so a message's inline pictures do not each
  fetch again.

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
  `PATCH` that changes the password or servers). While awake it keeps up to three ImapFlow connections per account
  (over `cloudflare:sockets`, which does both TLS and STARTTLS), each opened when first needed: **interactive** (opening a
  message and its attachments, flags, moves, deletes, the IMAP side of sending, a tab move's sender lookup), **background**
  (lists, folders, and the new mail a tab's list sorts) and **sorter** (sorting older mail into tabs and the re-check).
  Locks are per connection (imapflow's `getMailboxLock`), so a slow list never holds up opening a message, and sorting
  never holds up a list. Each is reused, reconnects once if it had dropped, and logs out after 60 s idle. Three is well
  within Gmail's limit of about 15 IMAP connections per account. The folder list is cached in memory for 5 minutes (Trash and Sent lookups).
- **Timing logs**: one line per request, `[mail] <METHOD> <route> <status> <ms>ms (lock wait <ms>, imap <ms>)`: the route with
  its ids replaced (`/v1/mail/accounts/:id/messages/:uid`), the total time, the time spent waiting for a connection and a
  folder's lock, and the time talking IMAP. Never an address, subject, folder or id, so `wrangler tail` shows where the time
  goes. The Mail object returns its two numbers in an `x-mail-timing` header and `routes/mail.ts` logs the line (and drops
  the header): logged inside the object, the line reached `wrangler tail` late or never, because a Durable Object request's
  tail event stays open while the object holds an open socket or a `waitUntil` job (it is sent when the next request
  arrives, the socket closes or the job ends). The background runs log `[mail] sort: …` and `[mail] recheck: …` lines in the
  object, which arrive late for that reason.
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
- Tests: `src/imap/*.test.ts` (ports, hosts, presets, the FETCH-to-summary mapping, snippets, the tab rules, the Gmail UID-range
  searches and the tab SQL, opening by parts against postal-mime reading the whole message) and `test/e2e-mail.mjs` against
  GreenMail (its header says how to run it). Under `MAIL_ALLOW_INSECURE=1` only, three request headers help it:
  `x-mail-test-slow-ms` pauses each step of the sorter inside its lock (to show lists and opening a message are not held
  up), `x-mail-test-classify-cap` lowers the sorting budgets (100 new per request, 300 per step), and `x-mail-test-recheck: 1`
  starts the re-check now. The background work a request starts keeps its hooks.
