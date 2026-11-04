# Mail: address completion in the composer

- `[server]` `mail_contacts`: the people written to and heard from, counted as the prefetch cache caches messages (and built from what is cached already on the first ask); `GET …/accounts/:id/contacts?q=` answers those whose address or a word of whose name starts with the text, the most written to first.
- `[web]` The composer's To, Cc and Bcc fields offer matching contacts under the box as you type: ↑/↓, Enter, Tab or a click take one, Esc dismisses. The fields no longer take the browser's autofill (folded in from #699).

## Feature

- **Addresses complete as you type.** Start typing a name or address in To, Cc or Bcc and Mail suggests the people you write to and hear from, most-used first; press Enter or Tab, or click, to take one.
