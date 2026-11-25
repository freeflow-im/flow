# Docs: File › Send as email

- `[web]` `[desktop]` Every Docs editor's File menu (in the suite) has Send as email: Mail's composer opens in a drawer on the right with the file added, and the file's title as the subject.
- `[web]` Mail's composer (`/mail/compose`, and `/mail/?mailto=`) takes Docs files to add (`docs=`, `createAddress('mail', { docs })`). They are added as a dropped file is, so link or attachment follows the recipients.
- `[web]` The compose drawer moved from Calendar into `@flow/suite-bar` (`ComposeDrawer`), shared by Calendar and Docs.

## Feature

- **Email a file straight from Docs.** In any document, spreadsheet, presentation or file, choose File › Send as email. A new email opens beside the file with the file attached, ready to address and send.
