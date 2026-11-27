# Chrome Web Store listing — FreeFlow Browser

Text to paste into the developer dashboard. Keep it true to `background.js`.

## Store listing

- **Name:** FreeFlow Browser (from the manifest)
- **Summary (≤132 chars):** Ask your FreeFlow assistant about the page you are on, in a side panel: summaries, key facts, replies.
- **Category:** Productivity → Tools
- **Language:** English
- **Icon:** `icons/icon-128.png`
- **Screenshots:** at least one, 1280×800: a web page with the FreeFlow side panel open beside it, showing a question
  about the page and the assistant's answer. A second: the panel's empty state with its suggested questions.
- **Description:**

  > FreeFlow Browser puts your FreeFlow assistant (app.freeflow.im) in Chrome's side panel, next to the page you are
  > reading.
  >
  > - Click the FreeFlow icon to open the panel. Ask "Summarize this page", "What are the key points?" or "Draft a
  >   reply to this", and the assistant answers from the page in front of you.
  > - The page is sent only when you send a message, and only that page. Take it off a message with ✕.
  > - The panel belongs to the tab you open it on, and lets the assistant use that page: read it, click, type and
  >   scroll there when you ask. It never closes your tab. On tabs where the panel is not open, it does nothing.
  > - When you ask it to, it can open pages in its own tabs, kept together in a collapsed "FreeFlow agent" tab group,
  >   and read, click, type and scroll there. It never types into password fields: for sign-ins and payments it hands
  >   the tab to you.
  > - It asks you before it uses a site for the first time: always, for this session, or not at all. Settings in the
  >   panel lists the sites you allowed, and lets you add or remove them.
  > - Stop it at any time from the panel, or from the icon's right-click menu, which closes all of its tabs.
  >
  > You need a FreeFlow account. Sign in once in the panel.

## Test instructions (for the reviewer)

Give the reviewer a test account on app.freeflow.im (made for the review, not a person's), then:

1. Install the extension and open any article, for example a Wikipedia page.
2. Click the FreeFlow icon in the toolbar. The side panel opens; sign in with the test account.
3. Click **Summarize this page**. The assistant answers with a summary of the article.
4. Ask "Open example.com and tell me its heading." A collapsed "FreeFlow agent" tab group appears with that page;
   the answer names the heading. Click **Stop** in the panel to close it.

## Privacy practices

- **Single purpose:** Lets the user talk to their FreeFlow assistant in a side panel about the page they are viewing,
  and lets the assistant open and use pages in its own tabs at the user's request.
- **Permission justifications:**
  - `tabs`: open, find, switch and close the assistant's own tabs.
  - `tabGroups`: keep the assistant's tabs in one collapsed "FreeFlow agent" group, apart from the user's tabs.
  - `scripting`: read the text of the page the user asks about, and of the assistant's own tabs; click, type and scroll
    in the assistant's own tabs, and in the user's tab where the user opened the side panel, when the user asks.
  - `storage`: remember which tabs belong to the assistant while the browser is open (session storage), and the sites
    the user allowed it to use (local storage for "Always", session storage for "This session").
  - `sidePanel`: the panel where the user talks to their assistant.
  - `contextMenus`: Stop on the toolbar icon's right-click menu, to close the assistant's tabs when the panel is closed.
  - `declarativeNetRequestWithHostAccess`: block pages of sites the user has not allowed in the assistant's own tabs,
    and in the user's tab only while the assistant acts there, so a link or redirect cannot take the assistant somewhere
    the user did not approve.
  - Host permission `<all_urls>`: the user may ask about any page they are viewing, and the assistant opens whatever
    site the user asks it to use, so the extension must be able to read any site. It acts (clicks, types) only in the
    assistant's own tabs and in a tab where the user opened the side panel, and reads the user's tab only when the user
    sends a message about it.
- **Remote code:** No. All code is in the package; commands from FreeFlow are data (a tool name and its input).
- **Data usage:** collects **Website content**: the text of the page in front of the user, only when they send a
  message in the side panel (they can leave it off), and page text and screenshots of the assistant's own tabs, sent to
  FreeFlow to complete the user's request. Not sold, not used for anything else, not used for
  creditworthiness. Check the three certification boxes.
- **Privacy policy URL:** https://app.freeflow.im/privacy

## Distribution

- **Visibility:** Unlisted
- **Regions:** All regions
