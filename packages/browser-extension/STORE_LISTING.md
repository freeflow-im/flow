# Chrome Web Store listing — FreeFlow Browser

Text to paste into the developer dashboard. Keep it true to `background.js`.

## Store listing

- **Name:** FreeFlow Browser (from the manifest)
- **Summary (≤132 chars):** Lets your FreeFlow assistant open and use web pages in this browser, in its own tab group.
- **Category:** Productivity → Tools
- **Language:** English
- **Icon:** `icons/icon-128.png`
- **Screenshots:** at least one, 1280×800: the FreeFlow assistant panel next to a collapsed "FreeFlow agent" tab group.
- **Description:**

  > FreeFlow Browser connects your FreeFlow assistant (app.freeflow.im) to this browser, so the assistant can look
  > things up and work on web pages for you while you watch.
  >
  > - The assistant works only in tabs it opens itself, kept together in a collapsed "FreeFlow agent" tab group. It
  >   never reads or touches your own tabs.
  > - It can open pages, read them, click, type, scroll and take screenshots of its own tabs.
  > - It never types into password fields. For sign-ins, payments and anything that needs you, it hands the tab to you.
  > - Click the toolbar button at any time to stop it and close all of its tabs.
  > - Only FreeFlow (app.freeflow.im) can send it commands.
  >
  > You need a FreeFlow account. Open the assistant in FreeFlow Workspace, Mail or Calendar and ask it to do something
  > on the web.

## Privacy practices

- **Single purpose:** Lets the user's FreeFlow assistant open, read and act on web pages in tabs it opens, at the
  user's request.
- **Permission justifications:**
  - `tabs`: open, find, switch and close the assistant's own tabs.
  - `tabGroups`: keep the assistant's tabs in one collapsed "FreeFlow agent" group, apart from the user's tabs.
  - `scripting`: read the text of the assistant's tabs and click, type and scroll in them when the assistant asks.
  - `storage`: remember which tabs belong to the assistant while the browser is open (session storage only).
  - Host permission `<all_urls>`: the assistant opens whatever site the user asks it to use, so it must be able to read
    and act on any site, in its own tabs only.
- **Remote code:** No. All code is in the package; commands from FreeFlow are data (a tool name and its input).
- **Data usage:** collects **Website content** (page text and screenshots of the assistant's own tabs, sent to the
  FreeFlow page that asked, to complete the user's request). Not sold, not used for anything else, not used for
  creditworthiness. Check the three certification boxes.
- **Privacy policy URL:** https://app.freeflow.im/privacy

## Distribution

- **Visibility:** Unlisted
- **Regions:** All regions
