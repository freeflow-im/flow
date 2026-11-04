# Mail: attachment chips in the message list

- `[server]` List summaries carry `attachments` (index, name, type, size) from the BODYSTRUCTURE the list already fetches; indexes are the opened message's (`listedAttachments`, body.ts).
- `[web]` Mail list rows show Gmail-style chips (file icon and name, "+N") that open the attachment preview without opening the message.

## Feature

- **Attachments right in your inbox.** Messages with files show them as chips under the subject, with an icon for PDFs, Word, Excel, PowerPoint and pictures. Click one to preview it straight away, without opening the message.
