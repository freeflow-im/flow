# Mail: a search result opens its whole conversation

- [server] Search and unread lists (`GET …/messages?q=`) now carry `threadId` for cached messages, as the spec said. Without it the client opened each match as a single message, so replies in Sent were missing.
- [qa] `cache.test.ts` covers `MailCache.threadIds`; `e2e-mail.mjs` checks that a search's rows carry the thread id.

## Feature

Opening a message from a Mail search now shows the full conversation, including your own replies.
