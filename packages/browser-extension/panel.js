// FreeFlow Browser's side panel (docs/specs/browser-extension.md), one per tab: it belongs to the tab it was opened on,
// hides when the person switches tabs and comes back with that tab. The chat is FreeFlow's own page (/home/browser) in a
// frame, signed in with the person's FreeFlow session. This page tells the frame its key and its tab (postMessage, to
// the suite's origin only), and shows the agent's tabs with Stop. The frame asks background.js for
// the page's text itself, with the key, when a message is sent. Settings lists the sites the assistant may use, and
// questions about new sites show here as cards (sites.js): the extension's own page, so no web page can answer them.

import { addSite, askCard, listSites, normalizeSite, pendingAsks, removeSite } from './sites.js';

const PRODUCTION = 'https://app.freeflow.im';
// The dev build may also use a local suite (its manifest lists localhost; the store build's does not).
const LOCAL_ALLOWED = (chrome.runtime.getManifest().externally_connectable?.matches ?? []).some((m) => m.startsWith('http://localhost'));
const allowedOrigin = (o) => o === PRODUCTION || (LOCAL_ALLOWED && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));

const frame = document.getElementById('suite');
const { suiteOrigin } = await chrome.storage.local.get('suiteOrigin');
const origin = allowedOrigin(suiteOrigin) ? suiteOrigin : PRODUCTION;
// The tab this panel belongs to (background.js opens one panel per tab, with its id in the address).
const tabId = Number(new URLSearchParams(location.search).get('tab'));
const { id: windowId } = await chrome.windows.getCurrent();
// A new key each time the panel opens: background.js reads the person's tab only for a request that brings it.
const key = crypto.randomUUID();
async function keepKey(on) {
  const { panelKeys = {} } = await chrome.storage.session.get('panelKeys');
  if (on) panelKeys[key] = tabId;
  else delete panelKeys[key];
  await chrome.storage.session.set({ panelKeys });
}
await keepKey(true);
addEventListener('pagehide', () => void keepKey(false));

frame.src = `${origin}/home/browser`;

const post = (message) => frame.contentWindow?.postMessage(message, origin);

/** An http(s) page the extension may read: not chrome://, the Web Store (Chrome refuses scripts there) or a new tab. */
const readable = (url) => /^https?:\/\//.test(url ?? '') && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url);

async function sendTab() {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const { tabs: agentTabs = [] } = await chrome.storage.session.get('tabs');
  post({ type: 'flow-tab', tab: tab ? { id: tab.id, title: tab.title ?? '', url: tab.url ?? '', ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}), readable: readable(tab.url), agent: agentTabs.includes(tab.id) } : null });
}

addEventListener('message', (e) => {
  if (e.origin !== origin || e.source !== frame.contentWindow) return;
  if (e.data?.type === 'flow-hello') {
    post({ type: 'flow-panel', key, window: windowId });
    void sendTab();
  }
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (id === tabId && (change.url || change.title || change.favIconUrl || change.status === 'complete')) void sendTab();
});

// The agent's own tabs (background.js keeps them in session storage), and Stop, which closes them all.
const footer = document.getElementById('footer');
async function showAgentTabs() {
  const { tabs = [] } = await chrome.storage.session.get('tabs');
  footer.hidden = !tabs.length;
  document.getElementById('agent-tabs').textContent = `${tabs.length} assistant tab${tabs.length === 1 ? '' : 's'} open`;
}
chrome.storage.session.onChanged.addListener((changes) => {
  if (!('tabs' in changes)) return;
  void showAgentTabs();
  void sendTab();
});
document.getElementById('stop').addEventListener('click', () => void chrome.runtime.sendMessage({ type: 'stop' }));
void showAgentTabs();

// The dev build: which suite the panel opens (production, or a local `pnpm dev:suite`).
if (LOCAL_ALLOWED) {
  const dev = document.getElementById('dev');
  const input = document.getElementById('dev-origin');
  dev.hidden = false;
  input.value = origin;
  document.getElementById('dev-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = input.value.trim().replace(/\/+$/, '');
    if (!allowedOrigin(value)) return void (input.value = origin);
    await chrome.storage.local.set({ suiteOrigin: value });
    location.reload();
  });
}

// --- Assistant | Settings ---
const settings = document.getElementById('settings');
function show(which) {
  const chat = which === 'chat';
  frame.hidden = !chat;
  settings.hidden = chat;
  document.getElementById('tab-chat').setAttribute('aria-selected', String(chat));
  document.getElementById('tab-settings').setAttribute('aria-selected', String(!chat));
  if (!chat) void showSites();
}
document.getElementById('tab-chat').addEventListener('click', () => show('chat'));
document.getElementById('tab-settings').addEventListener('click', () => show('settings'));

/** The sites list, with Remove on each. */
async function showSites() {
  const rows = await listSites();
  const list = document.getElementById('site-list');
  list.replaceChildren(
    ...rows.map((r) => {
      const li = document.createElement('li');
      li.dataset.site = r.site;
      const name = document.createElement('span');
      name.className = 'site';
      name.textContent = r.site;
      name.title = `${r.site} and its subdomains`;
      const how = document.createElement('span');
      how.className = `how ${r.how}`;
      how.textContent = r.how === 'always' ? 'Always' : 'This session';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${r.site}`);
      remove.addEventListener('click', () => void removeSite(r.site));
      li.append(name, how, remove);
      return li;
    }),
  );
  document.getElementById('site-empty').hidden = rows.length > 0;
}

document.getElementById('add-site').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('add-site-input');
  const error = document.getElementById('add-site-error');
  const site = normalizeSite(input.value);
  error.hidden = !!site;
  if (!site) {
    error.textContent = 'Enter a site, such as example.com.';
    return;
  }
  await addSite(site, document.getElementById('add-site-how').value);
  input.value = '';
});

// --- Questions about new sites ---
async function showAsks() {
  const asks = await pendingAsks();
  const box = document.getElementById('asks');
  const shown = new Set([...box.children].map((c) => c.dataset.ask));
  for (const c of [...box.children]) if (!asks.some((a) => a.id === c.dataset.ask)) c.remove();
  for (const a of asks) if (!shown.has(a.id)) box.append(askCard(a));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && 'sites' in changes) || (area === 'session' && 'sessionSites' in changes)) void showSites();
  if (area === 'session' && 'asks' in changes) void showAsks();
});
void showAsks();
