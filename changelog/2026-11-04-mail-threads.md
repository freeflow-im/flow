# Mail: conversations

- `[server]` Every cached message gets a thread (`src/imap/threads.ts`): the server's own thread id on Gmail and OBJECTID servers, else the thread of what it answers or references (In-Reply-To, References, in either direction, two threads merged when a message links them), else for a reply whose references lead nowhere a thread with the same subject and someone in common in the last 30 days; never for a mailing list's post or a draft. Message ids of rows that leave the cache keep pointing at their threads (`mail_thread_index`). `GET …/threads` lists a folder's conversations (newest message first, paged, inbox tabs included) and `GET …/threads/:id` reads one across the account's folders, each message once, bodies from the cache (`bodyPending` until the alarm fetched them); summaries carry `threadId`, the agents' `search_mail` a `thread_id`. Spec: docs/specs/mail-api.md, Conversations.
- `[web]` Mail lists conversations, Gmail-style: one row per thread (who is in it, how many, the newest subject and snippet), and the reading pane shows the whole conversation across INBOX, Sent and Archive, older messages collapsed; the row's actions act on the thread's messages in the folder; Reply answers the last message.

## Feature

- **Conversations.** Mail now groups a message with its replies, like Gmail: one row per conversation in the list, and opening it shows every message of the exchange — including the ones you sent — with the older ones folded. Archive, delete, star and mark read act on the whole conversation.
