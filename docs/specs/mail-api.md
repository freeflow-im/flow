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
  categoryReason?: string;                     // with category, when known: why it is there ("Gmail category:updates",
                                               // "Gmail: no category", "sender moved to primary", or the header rule's reason)
  attachments?: { index: number; filename: string; mimeType: string; size: number }[];
                                               // (2026-11-04) the list row's attachment chips: see "Attachments in the list"
}
interface MessageDetail extends Omit<MessageSummary, 'attachments'> {
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
  `&raw=1` (2026-11-03): on a Gmail account (`X-GM-EXT-1`), `q` is Gmail's own search syntax, sent as `X-GM-RAW`
  (`from:ann has:attachment newer_than:7d`); a query Gmail refuses is `bad_request`; elsewhere `raw` changes nothing.
  `&unread=1` keeps only unread messages (it also takes a tab's list through the search, so `category` is then ignored).
  A plain page (no `q`, `unread` or `category`) is read from the prefetch cache (below, 2026-11-04): the first page after one
  `UID SEARCH` for new mail, older pages outright.
  `&category=<Category>` (INBOX, tabs on) lists one tab: Primary is everything not in an *enabled* tab, and a tab that is off is
  empty. It is ignored while `q` is given (a search covers the whole folder, as Gmail's does) and when the account's tabs are off.
  A tab's page may come back short, even empty, with `sorting: true` and `next` while older mail is still being sorted
  into tabs: ask for the same page again shortly. See Inbox tabs below.
- `POST /v1/mail/accounts/:id/messages/category` body `{ folder: 'INBOX', uids: number[], category: Category }` ("Move to tab")
  → `{ ok: true, senders: string[], previous: { address: string, category: Category | null }[] }`. The tab is kept for each
  message's sender, so their later mail goes there too; `previous` is what each sender had, for undo.
- `POST /v1/mail/accounts/:id/senders/category` body `{ senders: { address: string, category: Category | null }[] }` → `{ ok: true }`
  sets the tab chosen for senders, or forgets it (`null`, back to the automatic one): how a move is undone.
- `GET  /v1/mail/accounts/:id/debug/tabs?folder=INBOX&uids=1,2,3` → `{ folder, sync, log, counts, messages? }`: how the inbox
  tabs were sorted lately, for the account's owner (the object is theirs). `log` is the last 10 sorting runs and the last 10
  re-checks (and repairs) since the object woke, in memory: `{ at, kind: 'sort' | 'recheck' | 'repair', checked, errors,
  ... }` with `categorized`/`primary`/`skipped`/`confirmed` for a sort and `promoted`/`moved`/`demoted`/`confirmed`/`gone`
  for a re-check. `sync` is the folder's `mail_sync` row, `counts` the cached rows per `(category, reason)`, and `messages`
  `{ uid, category, reason }` for the UIDs asked about.
- `GET  /v1/mail/accounts/:id/debug/cache` → `{ folders: [{ folder, kind, validity, high, low, modseq, syncedAt, openedAt, error, errorAt, rows }],
  log, lastActiveAt, nextAlarmAt }` (each folder also with `bodies` and `bodyBytes`): how the prefetch cache stands for the account
  (below), and the last 20 alarm runs since the object woke (`{ at, ms, folders: ['inbox: 3 new, 0 flags, 0 gone, 100 older',
  'bodies: 25 bodies'], errors }`), for the account's owner.
- `GET  /v1/mail/accounts/:id/messages/:uid?folder=` → `{ message: MessageDetail }` (does NOT mark it seen; the client PATCHes seen)
- `GET  /v1/mail/accounts/:id/messages/:uid/attachments/:index?folder=` → the bytes, with Content-Type and
  `Content-Disposition: attachment; filename*=…` (`?inline=1` → `inline`, used for cid: images). `index` is the
  attachment's `index` in MessageDetail; see "Opening a message" for what it maps to.
- `PATCH /v1/mail/accounts/:id/messages` body `{ folder, uids: number[], seen?: boolean, flagged?: boolean }` → `{ ok: true }`
- `POST /v1/mail/accounts/:id/messages/move` body `{ folder, uids: number[], to: string }` → `{ ok: true }`
- `POST /v1/mail/accounts/:id/messages/delete` body `{ folder, uids: number[], trashOnly?: boolean }` → moves to Trash (or expunges if already in Trash) → `{ ok: true }`.
  With `trashOnly: true` it never expunges: an account with no Trash folder, or messages already in Trash, are `409 conflict` and nothing changes.
- `POST /v1/mail/accounts/:id/send` body
  `{ to: Address[], cc?: Address[], bcc?: Address[], subject: string, html: string, text?: string, inReplyTo?: string, references?: string[], attachments?: { filename: string; contentType: string; contentBase64: string }[] }`
  → sends over SMTP as the account (From = displayName <email>), appends a copy to the Sent folder (skip if the provider auto-saves, e.g. Gmail),
  sets \Answered on the replied message when inReplyTo matches; → `{ ok: true, messageId: string }`. Max 20 MB total.
  Two optional fields (2026-11-03): `attachFrom: { folder, uid }` attaches that message's attachments (not its inline
  pictures), as a forward does, read in the Mail object instead of sent by the client; `replacesDraft: { folder, uid }`
  deletes that draft once the message is sent (Mail's Edit draft, and `send_mail` with a draft).

### Drafts (2026-11-03)

- `POST /v1/mail/accounts/:id/drafts` body: the same as `send` (no recipient required) → `201 { ok: true, folder, uid: number | null, messageId }`.
  The message is built as `send` builds it (MailComposer, Bcc kept) and appended to the account's Drafts folder (by its special
  use; `Drafts` is made when there is none) with `\Draft` and `\Seen`. `uid` is the server's APPENDUID, else found by the
  Message-ID; `null` only when neither works. `replacesDraft` deletes the draft it replaces once the new one is saved.
- `DELETE /v1/mail/accounts/:id/drafts/:uid?folder=` → `{ ok: true }`: removes a draft for good (`\Deleted` and expunge of that
  UID only). Refused (`bad_request`) for any folder that is not the account's Drafts folder.
- `POST /v1/mail/accounts/:id/drafts/:uid/send?folder=` → `{ ok: true, messageId }`: sends a saved draft as it is (its
  recipients, bodies, threading and attachments, as `send` does, Sent copy included), then deletes it. Drafts folder only.
- A draft is read like any message (`GET .../messages/:uid?folder=Drafts`). Mail shows **Edit draft** on a message in Drafts:
  Compose opens prefilled from it (`lib/compose.ts` `fromDraft`, its attachments carried over as a forward's are) and sends
  with `replacesDraft`, so the draft leaves Drafts once sent. Closing Compose leaves the saved draft as it was.

### The Mail tools for agents

Agents use Mail through the MCP endpoint (`docs/specs/web-mcp.md`, Mail tools) and the Docs assistant, both over this API in
the caller's own Mail object (`src/imap/mailTools.ts`). Message ids there are `<accountId>:<folder>:<uid>`.
Mail's own Assistant panel is that Docs assistant, with the open message as its context (`docs/specs/web-mcp.md`, The
assistant in Mail); it drafts and never sends.

## Inbox tabs

Gmail's Primary, Promotions, Social, Updates and Forums, for INBOX only. Each tab but Primary is switched on per account
(`tabs`); mail is sorted into the enabled ones by itself and the rest stays in Primary.

- **Gmail** (`imap.gmail.com`, or the server announces `X-GM-EXT-1`): Gmail's own categories, asked of Gmail once per
  message and cached (below): `UID <min>:<max> X-GM-RAW "category:<tab>"` for each of the four categories over a batch of
  at most 250 new UIDs (`sortBatch` in `src/imap/gmailTabs.ts`), and one envelope FETCH of those UIDs for the sender,
  subject and date. A message in none of them is Primary (reason `Gmail: no category`). Gmail's labels are never changed:
  the user's choices ("Move to tab") are ours.
- **Never Primary by absence alone.** A search that fails, or that Gmail refuses (imapflow answers `false`, which is not an
  empty answer), is an error: a new batch is then not stored at all (it stays unsorted, and the cache's reach stops above
  it, so it is asked about again; a first list with nothing sorted answers 503 `unavailable`), and a re-check changes
  nothing. A batch of over 50 where the four searches return nothing at all is asked about again by UID (`UID 5,9,12:14
  X-GM-RAW ...`, 100 UIDs a command) before it is stored as Primary.
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
  newest first) and the summaries of just those UIDs taken from the prefetch cache (`pageSummaries`; the rest fetched). A UID the
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
  newest 2000 cached messages only, `UID SEARCH <floor>:*` (their UID range) forgets the rows of mail that left INBOX (a
  refused search forgets nothing), and on Gmail `recheckRows` (`gmailTabs.ts`) takes Gmail's current categories (re-sorting
  done on gmail.com or by Gmail itself): the four X-GM-RAW searches over explicit ranges of at most 250 cached messages
  each (`UID <min>:<max>` between real cached UIDs, never `<floor>:*`). A row changes tab only when a search returns it
  under another category. A row in Promotions, Social, Updates or Forums the range searches leave out is asked about again
  by its own UID (100 to a command, all four categories), and goes to Primary only when none returns it then. Any failed
  or refused search, or a category with 20 or more cached rows of which none came back, makes the whole pass change
  nothing (logged, and in the debug route). Older rows are left as they are. It runs on the sorter connection, so it never
  holds up a list.
- **The repair** of rows wrongly cached as `Gmail: no category` (before 2026-11-03 an incomplete or refused search was
  read as "no category"): adding `mail_sync.repair_below` set, once, `checked_at = 0` (re-check on the next list) and
  `repair_below = high + 1` for every folder with such rows. Each re-check then also asks about up to 1000 older such rows
  below its floor (newest first, positive answers only: a row only ever leaves Primary), and moves `repair_below` down past
  them, to 0 when none are left.
- A list of the whole INBOX with tabs on (a search) carries each message's tab: other servers sort it from the headers fetched
  with the page, Gmail from the cache (sorting any UID it does not have).

The tabs have no counts: each is its name and icon (the open one blue, with the underline). The inbox's own unread count in
the left panel comes from `/folders`. In the list, rows can be dragged (mouse or trackpad only; touch screens and the
keyboard use the menus) onto a tab, which is the same "Move to tab" as the menu, or onto a folder, which is the same move as
"Move to"; dragging a checked row drags all the checked rows, and a drop on the open tab or folder does nothing.
A row's menu also has "Why is this in <Tab>?", which says `categoryReason` in plain words in the toast (`reasonText` in
`lib/tabs.ts`): "Gmail puts this in Updates", "You moved mail from this sender to Primary", "Gmail gives this no category,
so it is in Primary", "Sorted by its headers: newsletter (List-Id, List-Unsubscribe)".

Polling: the client re-reads folders + the open list every 60 s while the tab is visible, and both on window focus. (Push
over the websocket is a later phase.) After marking read or unread, flagging, moving or deleting, the client changes the
folder's unread count in its own cache at once (`packages/mail/src/lib/counts.ts`) and re-reads folders once, quietly, 4 s
after the last such change and once none is still on its way (so a burst of j/k is one refresh). Opening a message reads
the next (older) one ahead; it is marked read once it is on screen.

## The prefetch cache (2026-11-04)

The newest messages of each account's main folders are kept in the Mail object's SQLite (`mail_messages`, `mail_cache_folders`
and `mail_state`; the tables and the pure rules in `src/imap/cache.ts`, the IMAP in `object.ts`), so a folder's list is read
from it and the server is asked only for what is new.

- **Which folders**: INBOX, Sent, Drafts and Archive or All Mail, by their special use (on Gmail `[Gmail]/All Mail`, the only
  place archived mail lives), and any folder listed in the last 7 days (`kind: 'recent'`, forgotten after).
- **A row** holds the summary as `GET …/messages` returns it (JSON), the flags as last known (columns, written through by
  `PATCH`), the raw From/Reply-To/Bcc/In-Reply-To/References/List-Id header block and the body plan (to open the message by
  its parts later), the server's own message and thread ids where it has them (Gmail's X-GM-MSGID/X-GM-THRID, OBJECTID's
  EMAILID/THREADID: `email_id`, and `thread_id` as `s:<id>`), and the body once fetched (below; a list never reads it).
- **How far it reaches**: `mail_cache_folders (account_id, folder) → uid_validity, high, low, modseq, kind, synced_at, opened_at,
  error, error_at`. Every UID of the folder in [low, high] has a row, less what the server no longer has; at most CACHE_ROWS
  (1000) per folder, the newest. A new UIDVALIDITY drops the folder's rows.
- **A plain page** (`GET …/messages` with no `q`, `unread` or `category`; `cachedList`): the first page (no `before`) first asks
  the server for new mail (`UID SEARCH <high+1>:*`, at most NEW_CAP = 200 of them fetched, the newest; a folder seen for the
  first time gets its newest 200 from UIDNEXT down), so it is never stale; then the page is read from SQLite. The page's flags
  are checked against the server in one `UID FETCH <set> (FLAGS)` (mail read or starred by another mail app shows at once),
  which also drops a message that has left the folder. An older page (`before`) comes from SQLite outright; where the cache ends
  before a page is full, the rest is fetched from the server as before and cached on the way (`low` moves down to it), so
  scrolling never waits for the alarm. The timing line ends with `cache=hit|fill|live`. With tabs on, each message's tab
  comes from `mail_categories` as for a fetched page (a cached message not sorted yet is sorted then).
- **The alarm** (`alarm()`, `runCache`): every 30 s while the person is active (a request in the last 3 minutes), every 5 minutes
  idle under an hour, every 30 under a day, then not at all until the next request; set after every request and every run
  (`armAlarm`, cache.ts `nextAlarmAt`), and never for a person with no accounts. One run (ALARM_BUDGET_MS = 20 s) takes the
  accounts in turn, starting after the one the last run ended with, on each account's **cache** connection (logged out right
  after when the person is away, so the object can sleep). Per folder (`syncFolder`, under the folder's lock on that
  connection): new mail as above; the flags of every cached message in one FLAGS fetch (CONDSTORE: only those changed since the
  stored HIGHESTMODSEQ, and `UID SEARCH <low>:*` for what left), a row written through after the fetch began keeping what it
  has; older mail below `low`, BACKFILL_STEP = 100 a step (`uidsBelow`, the widening UID window, never the whole folder) until
  the folder holds CACHE_ROWS or the budget is spent; then the oldest rows past CACHE_ROWS go. A folder whose sync fails is
  left alone for 10 minutes (`error`, `error_at`); an account whose server refuses it is skipped (its `status` says so). An
  alarm run logs `[mail] cache: <n> folders <ms>ms (…)`.
- **Bodies** (`body_state`: 0 pending, 1 cached, 2 too large, 3 not openable by its parts, 4 evicted). Each alarm run, after
  the folders, fetches the bodies of cached messages not fetched yet (`prefetchBodies`): the folder looked at last first,
  unread and then newest first within it, BODY_BATCH = 25 messages or BODY_BATCH_BYTES = 4 MB a run, within the budget.
  Rows whose text parts sit in the same sections are fetched in one `UID FETCH <set> (BODY.PEEK[…])`; each is then parsed as
  an opened message is (`minimalMessage` from the stored header block and plan, postal-mime, `toDetail`) and kept: the
  detail (JSON), `html` and `text`. HTML over BODY_MAX_HTML = 1 MB or text over BODY_MAX_TEXT = 256 KB is not kept (2), nor
  a message `planBody` says must be read whole (3); either opens from the server as before. A folder's bodies past
  BODY_BUDGET_PER_FOLDER = 150 MB lose the oldest (4; the row stays). On a server with message ids (Gmail's X-GM-MSGID,
  OBJECTID) a body is kept once per message: a copy in another folder stands in, and the queue skips it.
  `GET …/messages/:uid` answers from the cache when the body is there (the flags from the row; the timing line says
  `cache=hit`, else `live`); a message opened from the server whose row is pending or evicted is kept then too. An
  attachment of a cached message is fetched by the stored plan, in one FETCH, with no BODYSTRUCTURE round trip.
- **Inbox tabs' pages** (`tabList`) take their summaries from the cache (`pageSummaries`): the cached rows, their flags
  checked in one FLAGS fetch (a message the server no longer has is dropped), and only the rest fetched and cached.
  Searches and `unread=1` are not from the cache.
- **Write-through**: `PATCH` flags update the rows at once; a reply sent here marks the cached original answered; a move or delete through us, a draft deleted, and a message the
  server no longer returns remove them (`left`); `DELETE` of the account drops everything of it. Mail arriving in a cached
  folder by a move or a send is picked up by that folder's next first page or alarm run. IMAP IDLE is a later change.
- Tests: `src/imap/cache.test.ts` (the cadence, the flag diff, the walk down, the tables on node:sqlite) and `test/e2e-mail.mjs`
  ("The prefetch cache", and the plain list of the cold 320-message INBOX). Under `MAIL_ALLOW_INSECURE=1`, `x-mail-test-alarm: 1`
  runs one alarm pass before the request is answered, and `x-mail-test-classify-cap` lowers NEW_CAP and BACKFILL_STEP too.

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
- **Attachments in the list** (2026-11-04): every list (a folder, a search, an inbox tab) already FETCHes BODYSTRUCTURE with
  the summaries (for `hasAttachments` and the snippet's part), so `MessageSummary.attachments` costs no round trip and no bytes
  of any part. `listedAttachments` (body.ts) is `planBody`'s attachments, with the same `index` as the opened message and
  `attachments/:index`, less those the body shows by cid: (inline, with a Content-ID; the reading pane leaves those out
  when the HTML refers to them, which the list cannot see); `size` is the estimate above. The field is left out when there
  are none, and for the exception below (an inline `message/rfc822`), whose indexes are postal-mime's and not known without
  reading the message whole; `hasAttachments` still says, and the row shows a paperclip. Tests: `body.test.ts` ("the
  attachments a list row shows": list indexes = the opened message's = postal-mime's, for a message with cid: pictures, an
  inline photo and real files) and `test/e2e-mail.mjs` ("list attachments", the folder, search and tab lists).
- The last three messages opened are kept with the parts fetched with them, so a message's inline pictures do not each
  fetch again.

## Attachment previews

The reading pane's attachment chips open a full-window overlay (`packages/mail/src/components/AttachmentPreview.tsx`); each chip
keeps a small download link. A list row's chips (`components/AttachmentChips.tsx`, from `MessageSummary.attachments`: the file's
icon, `components/FileIcon.tsx`, and its name, up to three and then "+N") open the same overlay without opening the message;
the click and Enter/Space are the chip's, not the row's. How many chips show is by the list's width (a CSS container query on
the list): the dense full-width rows show one to three under the subject; the stacked rows one to three under the snippet, and
none below 240px, where the row's paperclip stands in for them. The overlay's top bar has the name, size and type, Download, Save to Docs (then Open in Docs) and
Close; ← / → (buttons and keys) step through the message's attachments, leaving out pictures already shown in the body; Esc closes.
`lib/preview.ts` picks the viewer, by the name's extension first and then the MIME type:

- pictures (png, jpeg, gif, webp, bmp, avif; an SVG from a blob of its own type, always as an `<img>`), video and audio: the
  browser, from `attachments/:index`;
- PDF, Word (.docx), Excel (.xlsx, .xls), PowerPoint (.pptx), CSV and Markdown: Docs' read-only views, in a frame of
  `/workspace/preview/<id>?workspace=`, from a preview Docs makes (below);
- text and code (.txt, .json, .log, .eml, …) up to 2 MB: monospace text; HTML: its source, or the page in an `<iframe sandbox="">`
  with a CSP that loads nothing;
- anything else: "No preview available" and Download.

`POST /api/previews/mail` body `{ account, folder, uid, index, workspace? }` (`packages/edge/src/routes/previews.ts`) →
`{ preview: { id, kind, filename, size, expiresAt, saved? }, workspace }`. The Worker authenticates the caller, picks the Docs
object of `workspace` (Mail sends the organization selected in the suite bar; none → the caller's first), and asks it for the
caller's live preview of `mail:<account>:<folder>:<uid>:<index>`. Only if there is none does it read the bytes from the caller's
Mail object (`attachments/:index`, the route above) and post them to Docs' `POST /api/previews`, both as the caller. Over 25 MB is
`413`; Mail's errors pass through. Docs' errors are `{ error: "message" }`. Save to Docs is `POST /api/previews/:id/save?workspace=`
→ `{ saved: { kind, id, title, url } }`: a file at the top of My files in that organization. How previews are kept and expire is in
`packages/docs/docs/architecture.md` (Previews). Tests: `src/routes/previews.test.ts` and `test/e2e-preview.mjs`.

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
  `PATCH` that changes the password or servers). While awake it keeps up to four ImapFlow connections per account
  (over `cloudflare:sockets`, which does both TLS and STARTTLS), each opened when first needed: **interactive** (opening a
  message and its attachments, moves, deletes, the IMAP side of sending, a tab move's sender lookup), **background**
  (lists, folders, flags such as read and starred, and the new mail a tab's list sorts), **sorter** (sorting older mail into tabs and the re-check)
  and **cache** (the alarm's: keeping the prefetch cache, so it never waits on the sorter).
  Locks are per connection (imapflow's `getMailboxLock`), so a slow list never holds up opening a message, and sorting
  never holds up a list. Each is reused, reconnects once if it had dropped, and logs out after 60 s idle. Four is well
  within Gmail's limit of about 15 IMAP connections per account. The folder list is cached in memory for 5 minutes (Trash and Sent lookups).
- **Timing logs**: one line per request, `[mail] <METHOD> <route> <status> <ms>ms (lock wait <ms>, imap <ms>)`: the route with
  its ids replaced (`/v1/mail/accounts/:id/messages/:uid`), the total time, the time spent waiting for a connection and a
  folder's lock, and the time talking IMAP. Never an address, subject, folder or id, so `wrangler tail` shows where the time
  goes. The Mail object returns its two numbers in an `x-mail-timing` header and `routes/mail.ts` logs the line (and drops
  the header, except under `MAIL_ALLOW_INSECURE=1`, where the e2e reads it): logged inside the object, the line reached `wrangler tail` late or never, because a Durable Object request's
  tail event stays open while the object holds an open socket or a `waitUntil` job (it is sent when the next request
  arrives, the socket closes or the job ends). The background runs log `[mail] sort: …`, `[mail] recheck: …` and `[mail] cache: …` lines in the
  object, which arrive late for that reason. A plain list's line ends with `cache=hit|fill|live` (the prefetch cache).
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
- Tests: `src/imap/*.test.ts` (ports, hosts, presets, the FETCH-to-summary mapping, snippets, the tab rules, the tab SQL,
  the Gmail searches against a fake server in `gmailTabs.test.ts`: partial and refused answers, confirmation, chunking, opening by parts against postal-mime reading the whole message) and `test/e2e-mail.mjs` against
  GreenMail (its header says how to run it). Under `MAIL_ALLOW_INSECURE=1` only, three request headers help it:
  `x-mail-test-slow-ms` pauses each step of the sorter inside its lock (to show lists and opening a message are not held
  up), `x-mail-test-classify-cap` lowers the sorting budgets (100 new per request, 300 per step), `x-mail-test-recheck: 1`
  starts the re-check now, and `x-mail-test-alarm: 1` runs one alarm pass of the prefetch cache before the request is answered.
  The background work a request starts keeps its hooks.
