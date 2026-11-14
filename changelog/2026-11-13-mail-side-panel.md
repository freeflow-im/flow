# Mail side panel: Calendar and Docs beside the mail

- `[web]` `[desktop]` Mail has a side panel (`@flow/suite-bar` `SidePanel`): a pill on the right edge opens Calendar or Docs in a tab, in the Mail tab and in Home > Mail (docs/specs/side-panel.md).
- `[web]` App manifests gain `panel` and `sidePanels`; `/calendar/panel` (one day) and `/docs/panel` (Recents and file search) are the panel pages.
- `[web]` Mail's anchored assistant is the side panel's last tab instead of its own column; floating, it floats over the mail, not the panel. The draft survives floating and anchoring.

## Feature

- **Calendar and Docs beside your mail.** Click the small tab on the right edge of Mail to see today's calendar or your recent files next to your inbox. Click an event or a file to open it. Anchor the assistant and it joins them as a tab.
