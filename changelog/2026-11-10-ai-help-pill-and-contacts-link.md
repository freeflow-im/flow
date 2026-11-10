# A smaller "AI Help" pill, and Contacts under Mail's folders

- `[web]` `[desktop]` The floating assistant's launcher pill (Docs, Mail, Calendar) is 112×40 and reads "AI Help"; the ⌘K badge is gone from it (the shortcut still works, and is still named in the button's accessible label and the Minimize tooltip).
- `[web]` Contacts leaves the suite bar's tabs (its manifest has no `tab`; ⌘5 is free) and is a link under the special folders in Mail's folder panel, where contacts are used. The Contacts app itself is unchanged, and its own suite bar shows no active tab.
- `[server]` The kernel's "join an organization to use …" message names an app without a tab by its capitalized name.

## Feature

- **A smaller "AI Help" button.** The floating assistant button in the corner of the page is now a compact "AI Help" pill.
- **Contacts moved into Mail.** Contacts is no longer a tab at the top. Open it from the Contacts entry under Inbox, Sent, Archive and Trash in Mail's folder list.
