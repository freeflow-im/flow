# Mail: the Assistant panel

- `[web]` Mail's Assistant button opens the Docs assistant in a resizable right-hand panel (overlay under 1100px) instead of jumping to Docs; its own `mail` chat, in the selected organization's Docs.
- `[server]` A `page: 'mail'` context (open message, checked messages, folder, search) for the assistant, the `open_mail_message` browser tool, and the results of `create_mail_draft` / `save_mail_attachment_to_docs` in `tool_end` and the transcript.
- `[web]` Docs' turn-stream reader moved to `client/src/agent/stream.ts`, shared with Mail.

## Feature

- **Ask the assistant from Mail.** The Assistant button in Mail opens a chat beside your email. Ask it to summarize the message you are reading, draft a reply, find what someone sent you last week, or save an attachment to Docs. Drafts it writes open in Compose with one click; it never sends email for you.
