# Mail: quoted earlier messages fold behind ⋯

- `[web]` A message's quoted earlier messages (Gmail, Apple Mail, Outlook, Thunderbird, Yahoo markers, and the plain "On … wrote:" line + blockquote, or ">" lines in plain text) are found by `lib/quote.ts` and hidden behind a ⋯ pill in the message read, as Gmail does; a click shows them, another hides them.
- `[web]` A reply's quote stays out of the composer behind the same ⋯ until clicked (it still goes with the message as sent), so the Send button sits right under what is written instead of under the whole thread. A forward shows what it forwards.

## Feature

- **Shorter conversations.** The earlier messages quoted at the bottom of an email are tucked behind a small ⋯ button, both when you read a message and when you reply, so you see what was written and the Send button without scrolling past the whole thread. Click ⋯ to see them.
