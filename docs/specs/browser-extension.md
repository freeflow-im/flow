# FreeFlow Browser: the side panel

Status: **phase 1 built**, 2026-11-26 (branch `extension/side-panel`, Taskboard task 54). Phase 2 (§3.3) needs a ruling.

Today the extension has no interface. Clicking its toolbar icon closes the agent's tabs. This spec gives it one: a
side panel in Chrome where the person talks to their default private agent (their assistant, `agents.md` §1.3) about
the page they are looking at. Example: "Please summarize this page for me."

It also helps with the Chrome Web Store. The store rejected 0.1.0 on 2026-11-14 ("Yellow Nickel", Spam and Placement).
The most likely reason is that the extension did nothing on its own. With a panel, it does.

## 1. What the person sees

1. They click the FreeFlow icon in Chrome's toolbar. Chrome's side panel opens on the right, **for that tab only**
   (operator request 2026-11-27: the panel belongs to its tab, not to the whole window).
2. The panel shows their assistant's conversation: the same one as in the FreeFlow suite (§4).
3. Above the message box is a **page chip**: the favicon and title of the panel's tab, for example
   "📄 How R2 pricing works — developers.cloudflare.com". It follows that tab as it goes to other pages.
4. They type "Summarize this page" and send. The assistant answers in the panel, streaming, as it does in the suite.
5. Switching to another tab hides the panel; switching back shows it again, as it was. Another tab can have its own
   panel (click the icon there). Each message is about the panel's own tab. Every panel shows the same conversation
   (the home chat, §3.1), loaded when it opens.

```
┌──────────────────────────────────┐
│ ● Sam (your assistant)  Acme ▾ ⋯ │  ← agent name, organization, menu
├──────────────────────────────────┤
│                                  │
│  You: Summarize this page        │
│                                  │
│  Sam: The page explains R2's     │
│  three charges: storage, class A │
│  and class B operations...       │
│                                  │
├──────────────────────────────────┤
│ [📄 How R2 pricing works  ✕]     │  ← page chip; ✕ sends the message without the page
│ ┌──────────────────────────────┐ │
│ │ Ask about this page…         │ │
│ └──────────────────────────────┘ │
│ 2 agent tabs open · Stop         │  ← shown only when the agent has tabs open
└──────────────────────────────────┘
```

**The header** is the suite panel's own: the agent picker, ‹ › for earlier conversations, and New chat. A person in
several organizations also gets an organization picker above it.

**Signed out:** the frame shows FreeFlow's login page inside the panel. After sign-in it returns to the panel (tested:
`/login?next=/home/browser`).

**Stop:** the icon click now opens the panel, so stopping moves. "Stop" in the panel's footer closes all agent tabs and
stops a running turn. The icon's right-click menu gets **Stop the assistant and close its tabs** too, so it works
with the panel closed.

## 2. How it is built: the panel is a FreeFlow page in a frame

The panel is an extension page (`panel.html`) that holds one full-size iframe:
`https://app.freeflow.im/home/browser`. The key and window id are not in the address (a sign-in redirect would lose them): the frame asks the panel page for them with `postMessage` (§3.2).

The FreeFlow page inside the frame is a page of Home (`packages/home/src/browser/`), like `/home/setup` with none of Home's frames. It draws the assistant with the suite bar's existing chat
(`packages/suite-bar/src/suiteChat.ts`, `SuiteAssistantColumn`). So the extension has no chat UI, no API client and
no sign-in code of its own.

**Why a frame, not a chat built inside the extension:**

- One chat UI to keep up to date, not two. Markdown, tool rows, pictures, agent picker and history all work already.
- Sign-in uses the person's normal FreeFlow session cookie. The extension never holds a token.
- A change to the panel ships when `main` merges (the Worker deploys). Only extension changes need a store review.
- The page in the frame can already reach the extension (`externally_connectable` lists app.freeflow.im), so the
  agent's `browser_*` tools work from the panel as they do from the suite today.

**Spike results (2026-11-26): the frame design works.** Tested in Chrome for Testing 151 with a throwaway copy of the
dev extension (same id), against `pnpm dev:suite`, signed in as the test account `dev@flow.test`:

| Case | Session cookie sent | `GET /v1/me/workspaces` from the frame |
| --- | --- | --- |
| `http://localhost:8811` framed by an extension page | yes | 200 |
| `https://flow.test` (a local https proxy, standing in for production) framed by an extension page | yes | 200 |
| The same, inside a real side panel (opened with `chrome.sidePanel.open` on a click) | yes | 200 |
| Control: the same page framed by another site (`https://other.test`) | no | 401, shows the login page |
| All of the above again with third-party cookies blocked (`--test-third-party-cookie-phaseout`) | same results | same results |

So the `SameSite=Lax` session cookie is sent to a FreeFlow page framed by the extension, and still not sent when any
other site frames it. No sign-in hand-off is needed.

Other findings:

- **Framing headers.** No suite page sends `X-Frame-Options` or `frame-ancestors` today (checked production `/home`,
  `/login`, `/chat`), so the frame loads with no change. The new page should still say
  `Content-Security-Policy: frame-ancestors chrome-extension://dlfndpnhaonbojepfbiaonajkoonmmok
  chrome-extension://gnmcgiakoiplophhcoekeeaghfiipglo`, so only the extension can frame it.
- **Messages from the panel's frame.** `chrome.runtime.sendMessage` from the frame reaches the extension. In a real side
  panel the extension sees `sender.origin` and `sender.url`, but **no `sender.tab`** (a page in a normal tab always has
  one). So the extension can tell the panel's frame apart from FreeFlow pages in tabs. It does not see the window, so
  the panel page tells the frame its window id (§3.1). The panel's key (§3.2) is a second check.
- **Opening the panel.** `chrome.sidePanel.open` works only on a user gesture. `setPanelBehavior({ openPanelOnActionClick:
  true })` covers the toolbar icon, which is all §1 needs.

Not tested: the real production site (needs a real sign-in, which only a person can do), and Chrome's normal stable
build with a person's own settings. Check both by hand once the dev build has a panel.

## 3. The current page as context

### 3.1 What is sent

When the person sends a message, the frame asks the extension for the panel's own tab:

```
panel page → frame: { type: 'flow-panel', key, window }      (postMessage, to the suite's origin)
panel page → frame: { type: 'flow-tab', tab: { id, title, url, favIconUrl, readable } }   (on every tab change)
frame → extension:  { type: 'page', key, window }            (chrome.runtime.sendMessage)
extension → frame:  { ok, tab, url, title, selection, text, truncated }
```

The extension reads the tab with the same `readPage` it uses for agent tabs (so `browser_read` with an offset continues
the same text), cut to 20,000 characters (`truncated: true` when longer). `selection` is the text the person selected,
if any.

The frame sends it in the turn as `webPage`, an optional field of the home page's context (`BrowserReach`), like
`building` and `installedApp`. So the turn stays a home-chat turn with the home page's tools:

```ts
/** The web page a message from FreeFlow Browser's side panel is about (BrowserReach `webPage`). */
export interface WebPageContext {
  /** The extension's id for the tab, so browser_read and browser_screenshot can name it. */
  tab: number;
  url: string;
  title: string;
  /** The page's text as the extension read it. The page's own words: data, not instructions. */
  text: string;
  truncated?: boolean;
  /** The text the person selected on the page. */
  selection?: string;
}
```

It is in `packages/docs/shared/agent/protocol.ts`, and `prompt.ts` renders it (`renderWebPage`). The text goes in as
quoted page content, clearly marked as the page's words and not the person's. Pages can contain text written to steer
an agent, so this marking matters.

The ✕ on the page chip sends a message with no page: for questions that are not about the page.

The conversation is the person's **home chat** (`HOME_CHAT`) with their default agent: the same conversation as the
assistant in Home and Chat (`agents.md` §6: one private conversation, shown everywhere). Each message carries its own
page, so the history shows which page each question was about.

### 3.2 Who may read the person's tab

This is a change to a promise. The store listing says the agent "never reads or touches your own tabs". With the panel,
the extension reads the tab in front, but only in this case:

- The request comes from the panel's own frame: it has no `sender.tab` (§2, spike findings).
- The panel page makes a random `key` each time it opens, keeps it in the extension's session storage, and gives it to
  the frame by `postMessage` (never in an address). The extension answers `page` only with that key, and only with the
  tab that panel belongs to (session storage `panelKeys`: key → tab).
- So another FreeFlow page, or a turn started in the suite, cannot read the person's tabs.
- It reads only when the person sends a message, never in the background.

The store listing and privacy answers change to say this (§6).

### 3.3 Acting on the page

**Opening the panel on a tab lets the agent use it** (operator request 2026-11-27, once panels became per tab). The
panel belongs to its tab, so opening it there is a clear act by the person. From that panel, the agent may use every
browser tool on the tab (read, click, type, scroll, navigate, screenshot, hand off) except `browser_close`: it never
closes the person's tab. Closing the panel takes the permission away. Until 2026-11-27 the person's tab was read only.

- **Sites.** Opening the panel does not allow the tab's site. The first time the agent uses the tab (any tool, a read
  included), the extension asks for its site unless it is on the list, as in the agent's own tabs (§3.4). The list is the
  record of every site the agent used (operator ruling 2026-11-27). Only the page text the person's own message carries
  is exempt: that is the person's act, not the agent's.
- **Blocking only while the agent acts.** The agent's tabs block other sites all the time. The person's tab blocks them
  only while one of the agent's actions runs in it (`guarded`: a `declarativeNetRequest` rule for that tab, added before
  the action and removed after), so the person's own clicks are never blocked.
- **Going back.** Chrome's `tabs.goBack` skips pages left by a script's click (its history intervention), which every
  click of the agent's is. So "back" runs `history.back()` in the page, and after a refused site the tab goes straight to
  the page it was on.
- **Only the panel.** The assistant in Mail, Docs or Calendar (a FreeFlow page in a normal tab) still works only in its
  own tabs: a call naming the person's tab from there fails.

When the tab in front is one the agent opened itself (the person switched to it), it is not the person's tab: the
`page` answer says `agentTab`, the chip says "Assistant's tab", and the agent may use every tool there. Asked to go
somewhere else, it goes there in that tab with `browser_navigate` instead of opening another (found in testing,
2026-11-26).

The extension enforces this, not the model. A tab of the person's that a panel message read (`page`) is remembered as
shared: after its panel closes, the panel may still read and screenshot it, nothing more. Any call naming the person's
tab from a FreeFlow page in a normal tab fails, and so does `browser_close` on it (tested end to end, §7).

The server offers the `browser_*` tools only to the person's own assistant (`edge/src/assistant/browserTools.ts`). So a
shared agent picked in the panel gets the page's text, but cannot read further or take screenshots.

### 3.4 Sites the assistant may use

(Operator request, 2026-11-26.) The extension keeps a list of sites the assistant may use. Before the assistant opens
or goes to a site that is not on it, the extension asks the person: **Always**, **This session** or **Don't allow**.

- **A site** is a host name without `www.`; a rule covers its subdomains (`linkedin.com` covers `uk.linkedin.com`).
  "Always" rules are in the extension's local storage; "This session" rules in session storage, which Chrome clears when
  it quits. A refusal is not remembered: the next try asks again. The model is told not to retry unless asked.
- **Where it asks:** a card at the top of the side panel when the tab in front has one, else a small window (`ask.html`). Both are
  the extension's own pages: no web page or FreeFlow page can answer. With no answer in 2 minutes, the call fails and
  the model is told so.
- **Settings** (a tab in the panel) lists the rules, each with Remove, and adds one (Always or This session).
- **Enforced by Chrome, not only by checks.** A `declarativeNetRequest` session rule blocks page loads (main frame
  only) in the agent's own tabs for every site not on the list. So a click or a redirect to another site loads nothing:
  the tab shows Chrome's "blocked" page while the extension asks. Allowed, the page loads again; refused, the tab goes
  back. Before `browser_open` and `browser_navigate` the extension asks first, so nothing is blocked there.
- **Not covered:** the page text the person's own message carries (their act), and frames inside a page (embeds, ads).
  Every tool the agent calls asks, on any tab: its own, the person's tab with the panel open, or one shared earlier.
  A link that opens a new tab (`target=_blank`) opens it outside the agent's tabs, as before.

## 4. Which agent, which organization

- The panel opens the person's **default** agent in the organization they last chose in the suite bar.
- A person in several organizations gets an organization picker at the top of the panel.
- The agent picker from `SuiteAssistantColumn` stays, so they can pick another of their agents or a shared one. For a
  shared agent, the page context is still sent: it is a web page the person chose to share by asking, not a FreeFlow
  object. (Open question 3.)

## 5. Changes, by place

**Extension (`packages/browser-extension`)**

- `manifest.json`: `side_panel`, permissions `sidePanel` and `contextMenus`, version 0.2.0.
- `panel.html`, `panel.js`, `panel.css`: the frame, the key and window for it, the tab in front as it changes, and a
  footer with the agent's open tabs and Stop. The dev build adds **Suite address** to point the panel at a local suite.
- `background.js`: the icon opens the panel (`setPanelBehavior`); Stop on the icon's right-click menu and from the
  panel (`stop`); the `page` request (§3.1, §3.2); shared tabs readable from the panel (§3.3).
- `package.mjs`: ships the panel files. The store build's panel always opens production.

**Suite**

- `packages/shared/src/manifests.ts`: the page `/home/browser`, with `frame-ancestors 'self'` and the extension's ids.
- `packages/home/src/browser/`: the page (`BrowserPanelPage.tsx`) and its logic (`panel.ts`, tested).
- `packages/suite-bar`: `useSuiteAssistant` and `SuiteAssistantColumn` take `options` (`prepare`: context read when a
  message is sent; `runClientCalls`: run browser tools), a slot above the message box, and a placeholder. Tool lines
  show the pictures a tool took.
- `packages/docs/client/src/agent/browserBridge.ts`: `pinBrowserExtension` (talk only to the extension whose panel holds
  the page) and `askBrowserExtension`.
- `protocol.ts`: `WebPageContext` (§3.1). `prompt.ts`: `renderWebPage`. `edge/src/assistant/browserTools.ts`:
  `browser_read` and `browser_screenshot` may name the person's tab.

**Docs**

- `STORE_LISTING.md`: new description, test instructions for the reviewer, permission reasons for `sidePanel` and
  `contextMenus`, the new data use. `README.md` in the extension: the panel, and the dev build's suite address.

## 6. Store listing changes

- **Description:** lead with the panel: "Ask your FreeFlow assistant about the page you are on: summarize it, pull out
  facts, draft a reply."
- **Single purpose:** "Lets the user talk to their FreeFlow assistant in a side panel about the page they are viewing,
  and lets the assistant open and use pages in its own tabs."
- **Data:** the page text of the tab in front is sent to FreeFlow only when the user sends a message in the panel.
- **Permissions:** `sidePanel`: the panel. `contextMenus`: Stop on the toolbar icon's menu.

## 7. Build order and testing

One branch and one PR. Built 2026-11-26: the spike (§2), then the panel, page context, read tools and Stop, then the
docs.

**Tested end to end** in Chrome for Testing 151, with the dev extension loaded, a real side panel, a local suite and a
real model:

- The panel opens, signed in, with the chip showing the tab in front. It follows tab changes, says "This page can't be
  read" on `chrome://` pages, and ✕ takes the page off the next message.
- "Summarize this page" answered from the page's text. A screenshot of the person's tab was taken and shown under its
  tool line.
- Calls made directly to the extension: `browser_read` on the shared tab from the panel works; `browser_click` and
  `browser_type` there fail; a read of any other tab fails; a read of the shared tab from a FreeFlow page in a normal
  tab fails; a `page` request from a normal tab fails.
- Signed out, the panel shows FreeFlow's login page; after sign-in it returns to the panel.
- `/home/browser` opened in a normal tab says it is the side panel and to click the toolbar icon.

Not tested: production, and Chrome's normal stable build with a person's own settings. Check both by hand with the dev
build before uploading 0.2.0 to the store.

Phase 2 (§3.3) is a later PR after a ruling.

## 8. Open questions

1. **Phase 2:** should the agent ever click and type in the person's own tab, or always use its own tab?
2. **Long pages:** 20,000 characters on the first message, then `browser_read` with an offset. Is that the right
   amount, given that every message about a long page costs that much?
3. **Shared agents:** should page context go to a shared agent (Omni), whose conversation other people may see?
   This design says yes, because the person chose to ask. The safer answer is to send it only to personal agents.
4. **Which conversation:** the home chat (this design), or a separate "Browser" chat so web questions do not fill the
   home chat?
