# Mail: mute a conversation

- `[server]` Muted threads per account (`mail_muted_threads`, `POST …/threads/:id/mute {muted}`): muting moves the thread's INBOX mail to Archive (else All Mail), later mail of the thread is moved there as it is cached, and INBOX's thread list and tab badges leave muted threads out; a mute survives a thread merge.
- `[web]` Mute thread / Unmute thread in the conversation's ⋮ menu and each message's ⋮ menu, `m` with a conversation open (toast with Undo), and a "Muted" note with Unmute on a muted conversation.

## Feature

- **Mute a conversation.** Press `m` with a conversation open, or choose Mute thread from its ⋮ menu, and it leaves your inbox. New replies skip the inbox too, as they do in Gmail. Open it from Archive to unmute it.
