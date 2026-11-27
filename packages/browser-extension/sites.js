// The sites the assistant may use (docs/specs/browser-extension.md §3.4), shared by background.js and the extension's
// pages (panel.js, ask.js). A site is a host name without "www."; a rule covers the site and its subdomains, so
// "linkedin.com" covers "www.linkedin.com" and "uk.linkedin.com". "Always" rules are kept in local storage; "This
// session" rules in session storage, which Chrome clears when the browser closes.
//
// Only the extension's own code reads or writes these: web pages and FreeFlow's pages cannot reach its storage.

/** The site of a web address, or null for anything that is not an http(s) page. */
export function siteOf(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

/** What a person typed in Settings ("https://www.example.com/path", "Example.com"), as a site; null when it is not one. */
export function normalizeSite(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const site = siteOf(text.includes('://') ? text : `https://${text}`);
  // A host name: labels of letters, digits and hyphens (or an IP address), with a dot or "localhost".
  if (!site || !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(site) || (!site.includes('.') && site !== 'localhost')) return null;
  return site;
}

/** Whether a rule for `rule` covers the site `site`. */
export const covers = (rule, site) => site === rule || site.endsWith(`.${rule}`);

/** Every rule: { site, how: 'always' | 'session', added }, sorted by site. */
export async function listSites() {
  const { sites = {} } = await chrome.storage.local.get('sites');
  const { sessionSites = {} } = await chrome.storage.session.get('sessionSites');
  const rows = [
    ...Object.entries(sites).map(([site, v]) => ({ site, how: 'always', added: v?.added ?? null })),
    ...Object.entries(sessionSites).filter(([site]) => !(site in sites)).map(([site, v]) => ({ site, how: 'session', added: v?.added ?? null })),
  ];
  return rows.sort((a, b) => a.site.localeCompare(b.site));
}

/** Whether the assistant may use this site now. */
export async function isAllowed(site) {
  if (!site) return true;
  return (await listSites()).some((r) => covers(r.site, site));
}

/** Allows a site, always or for this browser session. */
export async function addSite(site, how) {
  const key = how === 'always' ? 'sites' : 'sessionSites';
  const area = how === 'always' ? chrome.storage.local : chrome.storage.session;
  const { [key]: current = {} } = await area.get(key);
  await area.set({ [key]: { ...current, [site]: { added: new Date().toISOString() } } });
}

/** Removes a site's rule, whichever kind it is. */
export async function removeSite(site) {
  for (const [area, key] of [[chrome.storage.local, 'sites'], [chrome.storage.session, 'sessionSites']]) {
    const { [key]: current = {} } = await area.get(key);
    if (site in current) {
      delete current[site];
      await area.set({ [key]: current });
    }
  }
}

// --- Asking the person ---
// background.js puts a question in session storage (`asks`) and waits for its answer (`answers`). The panel shows the
// questions as cards; with no panel open, ask.html shows them in a small window. The first answer counts.

/** The questions waiting for the person: { id, site, action, at }. */
export async function pendingAsks() {
  const { asks = [] } = await chrome.storage.session.get('asks');
  return asks;
}

/** The person's answer to a question: 'always', 'session' or 'deny'. */
export async function answerAsk(id, choice) {
  const { asks = [] } = await chrome.storage.session.get('asks');
  const ask = asks.find((a) => a.id === id);
  if (!ask) return;
  if (choice === 'always' || choice === 'session') await addSite(ask.site, choice);
  const { answers = {} } = await chrome.storage.session.get('answers');
  await chrome.storage.session.set({ answers: { ...answers, [id]: choice }, asks: asks.filter((a) => a.id !== id) });
}

/** What an ask card says the assistant wants to do, from the tool it called. */
export function askLine(ask) {
  const what = { browser_open: 'open a page on', browser_navigate: 'go to a page on', browser_click: 'follow a link to', browser_type: 'submit a form to' }[ask.action] ?? 'use';
  return `Your FreeFlow assistant wants to ${what} ${ask.site}.`;
}

/** Draws one question as a card with its three answers (panel.js and ask.js). */
export function askCard(ask, onAnswered) {
  const card = document.createElement('div');
  card.className = 'ask-card';
  card.dataset.ask = ask.id;
  const title = document.createElement('div');
  title.className = 'ask-title';
  title.textContent = 'Allow this site?';
  const line = document.createElement('div');
  line.className = 'ask-line';
  line.textContent = askLine(ask);
  const buttons = document.createElement('div');
  buttons.className = 'ask-buttons';
  for (const [choice, label] of [['always', 'Always'], ['session', 'This session'], ['deny', 'Don’t allow']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.className = `ask-${choice}`;
    b.addEventListener('click', async () => {
      for (const other of buttons.querySelectorAll('button')) other.disabled = true;
      await answerAsk(ask.id, choice);
      onAnswered?.(choice);
    });
    buttons.append(b);
  }
  card.append(title, line, buttons);
  return card;
}
