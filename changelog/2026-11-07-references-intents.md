# References and intents: one way to name, open, create and share across apps (platform phase 6.4)

- `[server]` `GET /v1/references?refs=&workspace=` resolves references for the caller: the Org object answers Chat's kinds and the share index, then the resolver each manifest kind declares (Docs' `/api/places/:id`, Calendar's `describe` RPC); what the caller may not see is `{ ref, denied: true }`.
- `[server]` One address table in `@flow/shared/addresses` (`addressOf`, `referenceOf`, share and create addresses) replaces `urlOf`, `chatAddress`, `calendarAddress` and `docs/addresses.ts`; own-origin FreeFlow addresses are no longer fetched for link previews.
- `[server]` `GET /v1/messages/:id` for a reader of the message's channel (what `?open=message:<id>` opens).
- `[web]` The suite bar's `intent.open/create/share` replace the hand-built `/?open=` and `/calendar/?new=` URLs in the Docs, Mail and Calendar bars and Mail's Create event.
- `[web]` Chat handles `?open=artifact|channel|message:<id>` and `?share=<ref>` (a new artifact Share dialog); Docs and Calendar open their Share dialogs for `?share=<ref>`.
- `[web]` FreeFlow addresses in messages, and share notices, render as chips resolved for the reader with one batched call per message list.

## Feature

- **FreeFlow links show what they are.** A link to a file, an artifact, a channel, a message, a calendar or an event in a Chat message shows its name and kind, with Open, and a link to something you cannot see says only what kind of thing it is.
- **Shared links open where they belong.** A shared artifact's link opens it beside the conversation, and a message's link scrolls to it.
- **Share from any link.** If you may share what a link points to, its Share button opens that app's Share dialog, including a new one for artifacts in Chat.
