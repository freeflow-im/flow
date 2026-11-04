# Mail: the composer's address fields no longer autofill

- `[web]` The To, Cc and Bcc fields asked the browser for email autofill (`autocomplete="email"`), so Chrome or a password manager could drop a saved address into the focused To field as the composer opened, and it became a recipient chip on blur. The fields now opt out of autofill (and tell 1Password and LastPass to leave them alone).

## Feature

- **A new message starts with an empty To field.** It no longer appears with an address your browser remembered.
