// FreeFlow Browser's side panel (docs/specs/browser-extension.md). The chat is FreeFlow's own page (/home/browser) in a
// frame, signed in with the person's FreeFlow session. This page tells the frame its key and window and the tab in
// front (postMessage, to the suite's origin only), and shows the agent's tabs with Stop. The frame asks background.js for
// the page's text itself, with the key, when a message is sent.

const PRODUCTION = 'https://app.freeflow.im';
// The dev build may also use a local suite (its manifest lists localhost; the store build's does not).
const LOCAL_ALLOWED = (chrome.runtime.getManifest().externally_connectable?.matches ?? []).some((m) => m.startsWith('http://localhost'));
const allowedOrigin = (o) => o === PRODUCTION || (LOCAL_ALLOWED && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));

const frame = document.getElementById('suite');
const { suiteOrigin } = await chrome.storage.local.get('suiteOrigin');
const origin = allowedOrigin(suiteOrigin) ? suiteOrigin : PRODUCTION;
const { id: windowId } = await chrome.windows.getCurrent();
// A new key each time the panel opens: background.js reads the person's tab only for a request that brings it.
const key = crypto.randomUUID();
await chrome.storage.session.set({ [`panel:${windowId}`]: key });
addEventListener('pagehide', () => void chrome.storage.session.remove(`panel:${windowId}`));

frame.src = `${origin}/home/browser`;

const post = (message) => frame.contentWindow?.postMessage(message, origin);

/** An http(s) page the extension may read: not chrome://, the Web Store (Chrome refuses scripts there) or a new tab. */
const readable = (url) => /^https?:\/\//.test(url ?? '') && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url);

async function sendTab() {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  post({ type: 'flow-tab', tab: tab ? { id: tab.id, title: tab.title ?? '', url: tab.url ?? '', ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}), readable: readable(tab.url) } : null });
}

addEventListener('message', (e) => {
  if (e.origin !== origin || e.source !== frame.contentWindow) return;
  if (e.data?.type === 'flow-hello') {
    post({ type: 'flow-panel', key, window: windowId });
    void sendTab();
  }
});
chrome.tabs.onActivated.addListener((info) => info.windowId === windowId && void sendTab());
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.windowId === windowId && tab.active && (change.url || change.title || change.favIconUrl || change.status === 'complete')) void sendTab();
});

// The agent's own tabs (background.js keeps them in session storage), and Stop, which closes them all.
const footer = document.getElementById('footer');
async function showAgentTabs() {
  const { tabs = [] } = await chrome.storage.session.get('tabs');
  footer.hidden = !tabs.length;
  document.getElementById('agent-tabs').textContent = `${tabs.length} assistant tab${tabs.length === 1 ? '' : 's'} open`;
}
chrome.storage.session.onChanged.addListener((changes) => 'tabs' in changes && void showAgentTabs());
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
