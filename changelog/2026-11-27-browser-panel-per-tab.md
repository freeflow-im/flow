# FreeFlow Browser: the side panel belongs to the tab it was opened on

- `[web]` The toolbar icon opens a tab-specific side panel (hidden on other tabs, back with its tab); each panel reads only its own tab. Site questions use the small window when the tab in front has no panel.
- `[server]` `[web]` Opening the panel on a tab lets the assistant act there (every browser tool but close, `canAct` in the page context); its first tool there asks for the site like anywhere else, and other sites block only while it acts. "Back" uses the page's own `history.back()`.

## Feature

- **The FreeFlow side panel stays with its tab.** Open it on a page and it is there when you come back to that tab, and out of the way on your other tabs. Open it on another tab too and each one talks about its own page.
- **Your assistant can work in the page you opened it on.** Ask it to click, fill in or scroll the page beside the panel, and it does it right there instead of in a new tab. It never closes your tab, and the first time it uses a site, this one included, it asks you.
