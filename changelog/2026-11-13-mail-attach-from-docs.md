# Mail: attach from Docs, threads read everywhere; Home after choosing an org; Admin → Changelog; local test account

- `[web]` The composer's paperclip offers Upload from computer and From Docs…: search Docs by name (My files and
  Organization files, recent files first) and attach one or more. Documents go as .docx/.xlsx/.pptx/.md exports.
- `[web]` Fix: opening a conversation (or marking it read) now marks its unread messages read in every folder they
  are in. The row counts unread messages account-wide, so one in another folder (e.g. archived) kept it bold.
- `[web]` The Mail mock serves a small sample Docs library for From Docs….
- `[web]` Choosing, creating or joining an organization in Chat's chooser opens Home on it, not Chat.
- `[web]` Admin → Changelog: every `changelog/` entry in full (newest first, search, platform filters) and the archive
  logs, from `changelog.json` made at build time by `scripts/build-changelog.mjs`. Owners and admins only.
- `[server]` Mail to reserved test domains (`.test`, `.example`, …) is logged, never sent.
- `[qa]` `dev:suite` sends real mail with `EMAIL_API_TOKEN` set, takes shared settings from `~/.config/flow/dev.vars`,
  and makes a test account (`dev@flow.test`, organization "Dev") in every checkout.

## Feature

- **Attach from Docs in Mail.** When writing an email, click the paperclip and choose From Docs… to search your
  files and attach them directly, without downloading and uploading them again. Documents, spreadsheets and
  presentations are attached as Word, Excel and PowerPoint files.
- **Opened conversations stay read.** Opening a conversation now marks all of it read, even messages that were
  filed in another folder, so it no longer stays bold in the list.
- **Start on Home.** After you create, join or choose an organization, you land on its Home page instead of Chat.
- **Changelog in Admin.** Owners and admins can read every change made to FreeFlow, in full, under Admin → Changelog,
  with search and a filter by platform.
