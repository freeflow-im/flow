# Search (2026-11-13)

One search for the suite: the words inside documents, chat messages and email, with filters for kind, author, time and
attributes such as `has:attachment`. The same engine serves the search box in the apps and a tool for the agents. This
spec is the plan; the rulings of §8 are in `decision_log.md`.

## 1. What a person and an agent can do

- **A person** types words in a search box and sees the documents, messages and emails that contain them, best match
  first, each with a short snippet where the words are highlighted. They can narrow the search with filters in the
  text (`from:ann type:doc after:2026-10-01`) or with the controls beside the box.
- **An agent** calls one `search` tool with the same query and filters as structured fields, and gets back the same
  results: id, kind, title, snippet, author, time and a link to open it.
- Nobody sees a result they could not open. A search never shows the title or a snippet of a private file, a channel the
  person is not in, or another person's mail.

## 2. The approach: index the data where it lives

Every app's data already lives in a Durable Object with its own SQLite database: chat in the Org object (one for each
organization), documents in the Docs object (one for each organization), mail in the Mail object (one for each account).
Each of these objects gets its own **SQLite FTS5** index over its own data. A search goes to the objects that hold the
person's data, and the results are merged.

A separate index for each user was considered and rejected (§8.1). It would copy every shared item once for each person
who can see it, and every edit, delete and permission change would have to reach every copy. A missed update would
show content to someone who lost access, with no visible error.

So the access check stays where it already is, at read time:

| Source | Index lives in | Who can see a hit |
|---|---|---|
| Documents | Docs object, one per organization | The Docs access check (`server/access.ts` `roleOf`): owner, organization files, grants |
| Chat | Org object, one per organization | `channel_id IN` the channels the person is a member of |
| Mail | Mail object, one per account | The account's owner only (the object is private already) |

### 2.1 Why FTS5

- It is built into SQLite, so it runs inside each Durable Object, in `node:sqlite` (the AWS origin and the desktop app),
  and in local `pnpm dev:suite`. There is no search service to run, and no copy of the data to keep in step.
- The index is updated in the same transaction as the data, so a search never shows a stale or deleted item.
- It ranks with BM25, supports phrases (`"q4 plan"`), prefixes (`plan*`), AND / OR / NOT, per-column search, and
  `snippet()` for highlighted excerpts.
- Measured on 2026-11-13 in a workerd Durable Object (wrangler 4.156): 5,000 documents of 300 words indexed in 263 ms;
  a rare word with a prefix answered in under 1 ms, the top 50 hits for a common word in 3 ms; 26 MB of storage in all.
  `porter`, `unicode61`, `trigram`, external content tables and `prefix=` indexes all work there.
  Through the whole local suite (`packages/edge/test/e2e-search.mjs`), a search over 200 documents answers in 3–7 ms,
  HTTP included.

What FTS5 does not do: typo tolerance, and meaning ("pricing decision" does not find "we agreed to charge $20"). The
second matters most to agents; §7 adds embeddings for it later.

### 2.2 The shape of one index

Each source keeps a plain table of the searchable text and an FTS5 table over it (external content, so the text is
stored once):

```sql
CREATE TABLE search_docs (rowid INTEGER PRIMARY KEY, object_kind TEXT, object_id TEXT, rev TEXT, title TEXT, body TEXT,
  UNIQUE (object_kind, object_id));
CREATE VIRTUAL TABLE search_fts USING fts5(title, body, content='search_docs', content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2', prefix='2 3');
-- triggers on search_docs keep search_fts in step (insert, delete, update)
```

- The filter columns (owner, organization, folder, time, channel, sender) are **not** copied into the index. A search
  joins the hits to the source table, so a move, a share or a change of owner needs no reindexing.
- `rev` is the source row's revision (`updated_at` for a document), after the version of the text extraction (`2:`), so a
  change to how words are taken reindexes everything. A row whose `rev` differs from its source, or a
  source row with no index row, is stale: a background pass reindexes it. This repairs anything a missed hook left behind.
- Titles count five times as much as the body in the ranking (`bm25(search_fts, 5.0, 1.0)`).

## 3. One query language

The text of the search box, and the `query` of the agents' tool, is parsed by one parser (`@flow/shared/search`):

```
from:ann type:doc has:attachment after:2026-10-01 before:2026-11-01 in:#sales "q4 plan" budget -draft
```

| Part | Meaning |
|---|---|
| `word` | the word (or a word it stems to: "planning" finds "plan") |
| `word*` | a word starting with this |
| `"two words"` | the exact phrase |
| `-word` | without this word |
| `a OR b` | either word |
| `type:` | `doc`, `sheet`, `deck`, `markdown`, `file`, `message`, `email` (more than one: `type:doc,sheet`) |
| `from:` | author: `me`, a user id, or a name or address (resolved per source) |
| `after:` / `before:` | a date (`2026-10-01`) or a relative one (`7d`, `3m`) |
| `in:` | a folder (Docs), a channel (Chat) or a mail folder (Mail) |
| `has:` | `attachment`, `link` |
| `is:` | `unread`, `starred`, `shared`, `private` |

The parser returns words and filters as data. Each source turns the words into an FTS5 `MATCH` expression; every word
is quoted there, so text from the box is never read as FTS5 syntax. A source ignores a filter that does not apply to it
(`has:attachment` for documents). The agents' tool takes the filters as fields too, and the fields win over the text.

## 4. Results and merging

Every source returns rows of one shape:

```ts
interface SearchHit {
  source: 'docs' | 'chat' | 'mail';
  kind: 'doc' | 'sheet' | 'deck' | 'markdown' | 'file' | 'message' | 'email';
  id: string;
  title: string;        // a document's title, a channel's name, an email's subject
  snippet: string;      // the matching text with the words marked by \u0002 … \u0003
  author?: string;      // user id or email address
  at: string;           // ISO time of the last change (document) or of sending (message, email)
  container?: string;   // folder, channel or mail folder
  url: string;          // its page inside its app (/doc/<id>); the router adds the app's prefix
  rank: number;         // the source's own rank: lower is better, not comparable across sources
}
```

The search router (§6, phase 4) asks each source for its top hits in parallel and merges them with **reciprocal rank
fusion**: a hit's score is the sum over sources of `1 / (60 + its position)`, with a small boost for recent items. BM25
scores from different indexes are not comparable, positions are.

## 5. Docs (phase 1, this PR)

- **What is indexed**: every document in `sheets`: documents (ProseMirror text), Markdown (its text), presentations (the
  text of text boxes, tables and speaker notes), spreadsheets and CSV files (cell values, not formulas; tab names). Titles
  of all of them. Stored files (PDFs, uploads) are indexed by name in a later phase, and by their text with the PDF work.
- **When**: `SheetStore` indexes a document as it writes it (`insert` and `write`, every kind) and updates the title on
  `rename`. A trigger on `sheets` removes the index row when the document is deleted, whatever deleted it. The text is
  taken from the document object being saved, so indexing reads nothing extra.
- **Backfill**: when the Docs object starts (`buildApp`), and again at each search, a background pass indexes the stale or
  missing documents (§2.2), 50 at a time, reading their files, until none are left. Nothing waits for it. If the object
  stops partway, the next start or search goes on from where it was, since the check reads the index as it is.
- **Access**: the query first narrows to rows the person could reach (their own, and their organizations' rows), then
  checks each hit with `roleOf`, the one access check Docs has. A hit the person cannot open is dropped before it is
  returned, title and snippet included.
- **API**: `GET /api/search?q=&type=&limit=` on the Docs app, answering `{ hits: SearchHit[] }`.
- **Tool**: `search_content` for the assistant, MCP clients and the suite's tool registry: the words inside documents,
  with `type`, `after` and `before`. `search_files` stays the search by name.
- **UI**: the Docs search bar's "Find files" (Enter in the suite bar) and the ⌘P dialog run the name search and this one
  together, in the root shown, and list each document once, with its snippet under the name.
- **The desktop app** (a folder of real files) does not index: its files change outside the app. Its search stays by name.

## 5a. Chat (phase 2, done 2026-11-13)

- **What is indexed**: every message but system lines ("joined the channel"): its body with `<@id>` as `@Name`, and the
  names of its files, so "q3-forecast.xlsx" finds the message that carries it. Thread replies too.
- **When**: `indexMessage` after a send and an edit; SQL triggers drop a message when it is deleted (tombstone or
  permanent, channel deletions included). The Org object indexes stale or missing messages in batches of 200 between
  requests, from the start and at each assistant search (`rev` = `MESSAGE_TEXT_VERSION:` and the last change).
- **Access**: `requireChannelAccess` in the query: a member of the organization, in a channel they are in or one that is
  not private (public channels they have not joined included, Scott 2026-11-13; direct messages are always private).
- **Filters**: `from:` (me, a user id, an address, a display name), `in:#channel` (name or id), `after:`/`before:`,
  `has:attachment`, `has:link`, `type:message`; best match or newest first.
- **API**: `GET /v1/workspaces/:id/search?q=&sort=recent&limit=&prefix=1` answers `{ hits }` (`MessageSearchHit`: the shared
  shape plus channel, kind, thread and author name).
- **Tools**: the assistant's `search_messages` (the sponsor's reach, never direct messages; `read_messages` now also
  reads a public channel the sponsor has not joined, so a hit can be read around); the bridge's `search_history` uses the
  server search across channels, or one with `channelId`, and falls back to its old scan against an older server.
- **UI**: web Chat's suite bar search opens a Search view (best match or newest); a row opens its message, in its thread
  when it is a reply. ⌘F still finds in the conversation shown. macOS and iOS: later (Parity).

## 6. Phases

1. **Docs** (this PR): the shared query parser, the Docs index, `/api/search`, the `search_content` tool.
2. **Chat** (done, §5a): the same in the Org object, over decrypted message bodies (§8.2), filtered by membership; a
   `search_messages` tool, and `search_history` moved onto it.
3. **Mail**: index the Mail object's cache (subject, sender, text), and send the same query to the IMAP server's own search
   (and Gmail's `X-GM-RAW`) for mail older than the cache, merging the two.
4. **The router and the suite search box**: `GET /api/search` in the Worker sends the query to the person's Docs object,
   Org object and Mail objects in the selected organization, merges (§4), and serves one `search` tool to the agents and
   the bridge. A search box in the suite bar shows the merged results.
5. **Stored files**: PDF text (the OCR object already extracts it) and text files.

## 7. Later

- **Meaning, for agents**: embeddings in Cloudflare Vectorize, one namespace per organization, with the same access
  filter applied to the hits, and merged with FTS5 by the same rank fusion.
- **Typo tolerance**: a `trigram` index over titles only, used when the main index finds nothing.
- **Size**: a Durable Object's database holds 10 GB. Text and its index are small next to that, but an organization's
  chat over years should be watched (`databaseSize`).

## 8. Rulings

1. **No index for each user** (2026-11-13). The data is indexed once, where it lives, and filtered by the person's access
   when they search (§2).
2. **Chat's index holds the message text in plain text** (Scott, 2026-11-13). Message bodies stay AES-GCM encrypted in
   `messages`; the search table beside them holds their words in plain text, as the Mail cache already holds mail. A blind
   index (hashed words) was offered and declined: it loses stemming, prefixes and snippets for a small gain, since the data
   key lives in the same deployment as the database.
3. **FTS5, not a search service** (2026-11-13). Typesense, Meilisearch, OpenSearch and Algolia search better, but each is a
   service to run and secure and a copy of the data to keep in step with every permission change.
