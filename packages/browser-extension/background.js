// FreeFlow Browser. Lets the FreeFlow assistant use web pages in this browser: the assistant's turn pauses
// on a browser_* tool, the FreeFlow page that started the turn passes the call here (chrome.runtime.sendMessage, allowed
// by `externally_connectable` for FreeFlow's origins only), and this worker runs it and answers with text.
//
// The toolbar button opens the side panel (panel.html, docs/specs/browser-extension.md): the person's assistant, FreeFlow's
// own page in a frame. A message sent there carries the tab in front, which this worker reads for it (`page`), and the
// agent may then read and screenshot that tab, nothing more.
//
// Otherwise the agent works only in tabs it opened, kept in one collapsed "FreeFlow agent" group per window. It never
// clicks or types in the person's own tabs, never types into password fields (it hands those pages to the person
// instead), and Stop (in the panel, or on the toolbar button's menu) closes every agent tab at once. Pages are read as text with numbered references for links, buttons and fields;
// the numbers are kept on the elements (data-flow-ref) so a click or a typed value names what a read showed.
//
// Ideas from anomalyco/browse (MIT): agent tabs in a collapsed group, the take-back toolbar button, handing a tab to the
// person. The actions are this file's own (chrome.scripting), so nothing runs agent code. In the dev build only,
// browser_screenshot attaches the debugger for the one capture, so a tab in the background can be drawn; the customer
// build (package.mjs) has no debugger permission and shows the tab for a moment instead.

import { isAllowed, listSites, siteOf } from './sites.js';

const VERSION = chrome.runtime.getManifest().version;
const GROUP_TITLE = 'FreeFlow agent';
const LOAD_TIMEOUT_MS = 20_000;
const SETTLE_MS = 600;
const MAX_READ = 20_000;

const TOOLS = ['browser_open', 'browser_tabs', 'browser_read', 'browser_click', 'browser_type', 'browser_scroll', 'browser_navigate', 'browser_close', 'browser_handoff', 'browser_screenshot'];
const SHOT_MAX_WIDTH = 1280;
const SHOT_TIMEOUT_MS = 8000;
/** How long a question about a site waits for the person (browserBridge.ts waits longer for the call). */
const ASK_TIMEOUT_MS = 120_000;

/**
 * FreeFlow's own pages: production always, and a local dev server on any port only when the manifest lists it (the dev
 * build does; the customer build made by package.mjs does not). Chrome already enforces `externally_connectable`.
 */
const LOCAL_ALLOWED = (chrome.runtime.getManifest().externally_connectable?.matches ?? []).some((m) => m.startsWith('http://localhost'));
const allowedOrigin = (origin) =>
  origin === 'https://app.freeflow.im' || (LOCAL_ALLOWED && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin ?? ''));

class ToolError extends Error {}

// --- The agent's tabs (kept in session storage: the worker may stop between calls) ---

async function agentTabs() {
  const { tabs = [] } = await chrome.storage.session.get('tabs');
  return new Set(tabs);
}

async function saveTabs(set) {
  await chrome.storage.session.set({ tabs: [...set] });
  await updateBlockRule();
  await chrome.action.setBadgeText({ text: set.size ? String(set.size) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
}

// The person's tabs a side-panel message was about (`page`): the agent may read and screenshot them, from the panel only.
async function sharedTabs() {
  const { shared = [] } = await chrome.storage.session.get('shared');
  return new Set(shared);
}

async function shareTab(id) {
  const set = await sharedTabs();
  set.add(id);
  await chrome.storage.session.set({ shared: [...set] });
}

/**
 * One of the agent's tabs, else an error the agent is told. `reading` (browser_read, browser_screenshot) from the side
 * panel's frame also allows a tab of the person's that a panel message was about.
 */
async function agentTab(tab, { reading = false, sender } = {}) {
  const id = Number(tab);
  const mine = Number.isInteger(id) && (await agentTabs()).has(id);
  const shared = !mine && reading && sender && fromPanel(sender) && Number.isInteger(id) && (await sharedTabs()).has(id);
  if (!mine && !shared) {
    throw new ToolError(
      Number.isInteger(id) && (await sharedTabs()).has(id)
        ? `Tab ${tab} is the user's own tab: you may only read it (browser_read) and look at it (browser_screenshot). To act on that page, open it in a tab of your own with browser_open.`
        : `Tab ${tab} is not one of your tabs. browser_tabs lists them; browser_open opens one.`,
    );
  }
  if (shared) return chrome.tabs.get(id).catch(() => { throw new ToolError(`Tab ${tab} was closed.`); });
  try {
    return await chrome.tabs.get(id);
  } catch {
    const set = await agentTabs();
    set.delete(id);
    await saveTabs(set);
    throw new ToolError(`Tab ${tab} was closed.`);
  }
}

chrome.tabs.onRemoved.addListener(async (id) => {
  const set = await agentTabs();
  if (set.delete(id)) await saveTabs(set);
  const shared = await sharedTabs();
  if (shared.delete(id)) await chrome.storage.session.set({ shared: [...shared] });
});

/** Stop: close every tab the agent opened. */
async function stopAgent() {
  const set = await agentTabs();
  await saveTabs(new Set());
  if (set.size) await chrome.tabs.remove([...set]).catch(() => {});
}

// The toolbar button opens the side panel; its right-click menu has Stop, for when the panel is closed.
const STOP_MENU = 'stop-agent';
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: STOP_MENU, title: 'Stop the assistant and close its tabs', contexts: ['action'] }, () => void chrome.runtime.lastError);
});
chrome.contextMenus.onClicked.addListener((info) => info.menuItemId === STOP_MENU && void stopAgent());

// The panel page's own requests (it is this extension's page): Stop.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== 'stop') return false;
  stopAgent().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
  return true;
});

async function addToGroup(tabId, windowId) {
  const [group] = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE });
  if (group) {
    await chrome.tabs.group({ groupId: group.id, tabIds: [tabId] });
    return;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'purple', collapsed: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until the tab has loaded (or the timeout), after a short pause so a navigation a click started is under way. */
async function settled(tabId) {
  await sleep(SETTLE_MS);
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => id === tabId && info.status === 'complete' && finish();
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(finish, LOAD_TIMEOUT_MS);
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && finish(), finish);
  });
}

function webUrl(url) {
  let u;
  try {
    u = new URL(String(url).includes('://') ? String(url) : `https://${url}`);
  } catch {
    throw new ToolError(`Not a web address: ${url}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ToolError('Only http and https pages can be opened.');
  return u.href;
}

/** Run one of the page functions below in the tab (the extension's isolated world: the page cannot see it). */
async function inPage(tabId, func, args = []) {
  let out;
  try {
    [out] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  } catch (e) {
    throw new ToolError(`This page cannot be used by the extension (${e.message}).`);
  }
  const result = out?.result;
  if (result?.error) throw new ToolError(result.error);
  return result;
}

// --- Functions that run in the page. Each is sent on its own, so they share nothing: helpers are repeated inside. ---

/** The page as text: headings, text, and every visible link, button and field with its reference number. */
function readPage(offset, max) {
  const INTERACTIVE =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[contenteditable=""],[contenteditable=true]';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'HEAD']);
  const root = document.documentElement;
  let next = Number(root.dataset.flowRefNext || 1);
  const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
  const quote = (t) => `"${clean(t).slice(0, 120)}"`;
  const name = (el) => el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.title || el.getAttribute('alt') || el.name || '';
  const ref = (el) => {
    if (!el.dataset.flowRef) el.dataset.flowRef = String(next++);
    return el.dataset.flowRef;
  };
  const fieldLabel = (el) => {
    const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return el.getAttribute('aria-label') || byFor?.innerText || el.closest('label')?.innerText || el.getAttribute('placeholder') || el.name || '';
  };
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (tag === 'a') return `link ${quote(name(el))} → ${el.href}`;
    if (tag === 'select') {
      const opts = [...el.options].slice(0, 30).map((o) => clean(o.text));
      return `select ${quote(fieldLabel(el))} = ${quote(el.options[el.selectedIndex]?.text ?? '')} options: ${opts.join(' | ')}`;
    }
    if (tag === 'textarea') return `text area ${quote(fieldLabel(el))} = ${quote(el.value)}`;
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return `${type} ${quote(fieldLabel(el))}${el.checked ? ' (checked)' : ''}`;
      if (['submit', 'button', 'reset', 'image'].includes(type)) return `button ${quote(el.value || name(el))}`;
      if (type === 'password') return `password field ${quote(fieldLabel(el))} (hand this page to the user)`;
      return `field (${type}) ${quote(fieldLabel(el))} = ${quote(el.value)}`;
    }
    if (el.isContentEditable) return `editable text ${quote(fieldLabel(el) || el.innerText)}`;
    const state = el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' ? ' (selected)' : '';
    return `${role || 'button'} ${quote(name(el))}${state}`;
  };
  const lines = [];
  let text = '';
  const flush = () => {
    const t = clean(text);
    if (t) lines.push(t);
    text = '';
  };
  const walk = (node) => {
    const kids = node.shadowRoot ? [...node.shadowRoot.childNodes, ...node.childNodes] : node.childNodes;
    for (const child of kids) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += ` ${child.textContent}`;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE || SKIP.has(child.tagName)) continue;
      // An element with `display: contents` draws no box of its own (its children are drawn in its place), so
      // checkVisibility calls it hidden; LinkedIn wraps its whole profile in one. Read through it.
      const display = getComputedStyle(child).display;
      if (display !== 'contents' && child.checkVisibility && !child.checkVisibility({ checkVisibilityCSS: true })) continue;
      if (child.matches(INTERACTIVE)) {
        flush();
        lines.push(`[${ref(child)}] ${describe(child)}`);
        // Its own text is in its line; look inside only for links and fields it holds (a clickable card with a link).
        if (child.isContentEditable || !child.querySelector(INTERACTIVE)) continue;
      }
      const heading = /^H([1-6])$/.exec(child.tagName);
      if (heading) {
        flush();
        lines.push(`${'#'.repeat(Number(heading[1]))} ${clean(child.innerText)}`);
        continue;
      }
      const inline = display.startsWith('inline') || display === 'contents';
      if (!inline) flush();
      walk(child);
      if (!inline) flush();
    }
  };
  walk(document.body ?? root);
  flush();
  root.dataset.flowRefNext = String(next);
  const body = lines.join('\n');
  const part = body.slice(offset, offset + max);
  const more = offset + max < body.length ? `\n\n[${body.length - offset - max} more characters: browser_read with offset ${offset + max}]` : '';
  return { title: document.title, url: location.href, text: `${part}${more}` };
}

function findAndClick(ref) {
  const find = (root) => {
    const hit = root.querySelector(`[data-flow-ref="${CSS.escape(String(ref))}"]`);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) {
      const inner = find(el.shadowRoot);
      if (inner) return inner;
    }
    return null;
  };
  const el = find(document);
  if (!el) return { error: `There is no [${ref}] on the page now. browser_read gives fresh references.` };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus?.({ preventScroll: true });
  el.click();
  return { ok: true };
}

function findAndType(ref, text, submit) {
  const find = (root) => {
    const hit = root.querySelector(`[data-flow-ref="${CSS.escape(String(ref))}"]`);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) {
      const inner = find(el.shadowRoot);
      if (inner) return inner;
    }
    return null;
  };
  const el = find(document);
  if (!el) return { error: `There is no [${ref}] on the page now. browser_read gives fresh references.` };
  if (el.tagName === 'INPUT' && el.type === 'password') return { error: 'That is a password field: never type passwords. Hand the page to the user with browser_handoff.' };
  el.scrollIntoView({ block: 'center' });
  el.focus?.({ preventScroll: true });
  if (el.tagName === 'SELECT') {
    const opt = [...el.options].find((o) => o.text.trim() === text || o.value === text);
    if (!opt) return { error: `No option "${text}" in that list.` };
    el.value = opt.value;
  } else if (el.isContentEditable) {
    document.getSelection()?.selectAllChildren(el);
    document.execCommand('insertText', false, text);
  } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    // The prototype's setter, so frameworks that track the value (React) see the change.
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
  } else {
    return { error: `[${ref}] is not a field you can type in.` };
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (submit) {
    const form = el.form ?? el.closest('form');
    if (form) form.requestSubmit();
    else for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  }
  return { ok: true };
}

function scrollPage(direction) {
  const by = direction === 'up' ? -0.85 : 0.85;
  if (direction === 'top') window.scrollTo(0, 0);
  else if (direction === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
  else window.scrollBy(0, Math.round(window.innerHeight * by));
  return { y: Math.round(window.scrollY), height: document.documentElement.scrollHeight, viewport: window.innerHeight };
}

/** A card on the page telling the person what the agent needs from them. */
function showHandoffCard(reason) {
  document.getElementById('flow-handoff-card')?.remove();
  const host = document.createElement('div');
  host.id = 'flow-handoff-card';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    .card{position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:340px;padding:14px 16px;border-radius:12px;
      background:#1f1633;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)}
    .t{font-weight:600;margin-bottom:6px} button{margin-top:10px;padding:6px 12px;border:0;border-radius:8px;background:#a78bfa;color:#1f1633;font-weight:600;cursor:pointer}
  </style><div class="card"><div class="t">Your FreeFlow assistant needs you</div><div class="r"></div><button>Done</button></div>`;
  shadow.querySelector('.r').textContent = reason;
  shadow.querySelector('button').addEventListener('click', () => host.remove());
  document.documentElement.append(host);
  return { ok: true };
}

// --- Screenshots ---

const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took too long`)), ms))]);

/**
 * A picture of a tab that may be in the background: through the debugger, with focus emulation so the page draws as if
 * it were in front. Chrome shows its "started debugging" bar only while attached, which is just this capture.
 */
async function captureWithDebugger(tabId) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    const shot = await withTimeout(chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'jpeg', quality: 80 }), SHOT_TIMEOUT_MS, 'The capture');
    return shot.data;
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

/** The fallback (another debugger is attached, or the capture hung): show the tab a moment, capture it, and go back. */
async function captureByShowing(tab) {
  const [front] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  await chrome.tabs.update(tab.id, { active: true });
  await sleep(400);
  try {
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
    return url.slice(url.indexOf(',') + 1);
  } finally {
    if (front && front.id !== tab.id) await chrome.tabs.update(front.id, { active: true }).catch(() => {});
    if (tab.groupId > -1) await chrome.tabGroups.update(tab.groupId, { collapsed: true }).catch(() => {});
  }
}

/** A capture made smaller (at most SHOT_MAX_WIDTH wide) and sent as JPEG, so it stays well inside the model's limits. */
async function shrink(base64) {
  const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${base64}`)).blob());
  const scale = Math.min(1, SHOT_MAX_WIDTH / bitmap.width);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 })).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(binary), width, height };
}

async function screenshot(tab) {
  let raw;
  let how = 'debugger';
  try {
    if (!chrome.debugger) throw new Error('no debugger permission');
    raw = await captureWithDebugger(tab.id);
  } catch {
    how = 'shown';
    raw = await captureByShowing(tab).catch((e) => {
      throw new ToolError(`The tab could not be captured (${e.message}).`);
    });
  }
  const shot = await shrink(raw);
  return {
    content: `A screenshot of tab ${tab.id} (${tab.title}), ${shot.width}×${shot.height}, is attached${how === 'shown' ? ' (the tab was shown to the user for a moment to take it)' : ''}. It shows only the part of the page in view: browser_scroll moves it.`,
    image: { mediaType: 'image/jpeg', data: shot.data },
  };
}

// --- The tools ---

// --- Sites the assistant may use (sites.js; docs/specs/browser-extension.md §3.4) ---

/**
 * Asks the person whether the assistant may use a site, and waits for the answer: 'always', 'session', 'deny' or
 * 'timeout'. The open side panel shows the question; with none open, ask.html does, in a small window. One question per
 * site: a second call for the same site waits on the first.
 */
async function askPerson(site, action) {
  const { asks = [] } = await chrome.storage.session.get('asks');
  let ask = asks.find((a) => a.site === site);
  if (!ask) {
    ask = { id: crypto.randomUUID(), site, action, at: Date.now() };
    await chrome.storage.session.set({ asks: [...asks, ask] });
    const panels = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).catch(() => []);
    const windows = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [chrome.runtime.getURL('ask.html')] }).catch(() => []);
    if (!panels.length && !windows.length) await chrome.windows.create({ url: chrome.runtime.getURL('ask.html'), type: 'popup', width: 460, height: 320, focused: true }).catch(() => {});
  }
  // Polled rather than awaited on an event: each storage call keeps this worker awake while it waits.
  const end = Date.now() + ASK_TIMEOUT_MS;
  for (;;) {
    const { answers = {} } = await chrome.storage.session.get('answers');
    if (answers[ask.id]) return answers[ask.id];
    if (Date.now() > end) {
      const { asks: left = [] } = await chrome.storage.session.get('asks');
      await chrome.storage.session.set({ asks: left.filter((a) => a.id !== ask.id) });
      return 'timeout';
    }
    await sleep(500);
  }
}

/**
 * Chrome itself refuses to load a page of a site not on the list in the agent's tabs (a session rule of
 * declarativeNetRequest, for those tabs only), so a click or a redirect to another site loads nothing until the person
 * allows it. Kept up to date with the agent's tabs and the list.
 */
const BLOCK_RULE = 1;
async function updateBlockRule() {
  const tabs = [...(await agentTabs())];
  const sites = (await listSites()).map((r) => r.site);
  const addRules = tabs.length
    ? [{ id: BLOCK_RULE, priority: 1, action: { type: 'block' }, condition: { tabIds: tabs, resourceTypes: ['main_frame'], ...(sites.length ? { excludedRequestDomains: sites } : {}) } }]
    : [];
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [BLOCK_RULE], addRules }).catch((e) => console.warn('FreeFlow: block rule', e));
}
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && 'sites' in changes) || (area === 'session' && 'sessionSites' in changes)) void updateBlockRule();
});
void updateBlockRule();

/** Passes when the assistant may use the address's site (asking the person if need be); else the error it is told. */
async function requireSite(url, action) {
  const site = siteOf(url);
  if (!site || (await isAllowed(site))) return;
  const answer = await askPerson(site, action);
  if (answer === 'always' || answer === 'session') {
    // Before the page is loaded (again): the block rule must already let it through.
    await updateBlockRule();
    return;
  }
  throw new ToolError(
    answer === 'timeout'
      ? `The user did not answer whether you may use ${site}. Tell them you asked, and try again only if they say so.`
      : `The user did not allow you to use ${site}. Do not try it again unless they ask. They can allow it in Settings in the FreeFlow side panel.`,
  );
}

/**
 * The site one of the agent's tabs is on must be allowed: before an action on it (the list may have changed), and after
 * a page loaded (a click, a redirect). After a load (`loaded`), Chrome has already refused a page of a site not on the
 * list (the block rule), so: allowed now, the tab loads it again; refused, the tab goes back (to `before` if need be; a
 * new tab closes) and the error is told.
 */
async function requireLanded(tabId, action, { isNew = false, loaded = false, before = null } = {}) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url || tab?.pendingUrl || '';
  const site = siteOf(url);
  if (!site || (await isAllowed(site))) return;
  try {
    await requireSite(url, action);
  } catch (e) {
    if (isNew) await chrome.tabs.remove(tabId).catch(() => {});
    else if (loaded) {
      await chrome.tabs.goBack(tabId).catch(() => {});
      await settled(tabId);
      const now = await chrome.tabs.get(tabId).catch(() => null);
      const there = siteOf(now?.url);
      if (before && there && !(await isAllowed(there))) {
        await chrome.tabs.update(tabId, { url: before }).catch(() => {});
        await settled(tabId);
      }
    }
    throw e;
  }
  if (loaded) {
    await chrome.tabs.update(tabId, { url });
    await settled(tabId);
  }
}

/** Whether the tab is one the agent opened (not the person's, which a side-panel message shared for reading). */
const isAgentTab = async (tabId) => (await agentTabs()).has(tabId);

async function readTab(tabId, offset = 0) {
  const page = await inPage(tabId, readPage, [Math.max(0, Number(offset) || 0), MAX_READ]);
  return `Tab ${tabId}: ${page.title}\nURL: ${page.url}\n\n${page.text || '(the page shows no text)'}`;
}

async function run(name, input, sender) {
  switch (name) {
    case 'browser_open': {
      const url = webUrl(input.url);
      await requireSite(url, name);
      // Blank first, so the block rule covers the tab before it loads anything (a redirect to another site included).
      const tab = await chrome.tabs.create({ url: 'about:blank', active: false, ...(sender.tab ? { windowId: sender.tab.windowId } : {}) });
      const set = await agentTabs();
      set.add(tab.id);
      await saveTabs(set);
      await addToGroup(tab.id, tab.windowId);
      await chrome.tabs.update(tab.id, { url });
      await settled(tab.id);
      await requireLanded(tab.id, name, { isNew: true, loaded: true });
      return `Opened tab ${tab.id}.\n${await readTab(tab.id)}`;
    }
    case 'browser_tabs': {
      const tabs = await Promise.all([...(await agentTabs())].map((id) => chrome.tabs.get(id).catch(() => null)));
      const open = tabs.filter(Boolean);
      return open.length ? open.map((t) => `Tab ${t.id}: ${t.title} — ${t.url}`).join('\n') : 'You have no tabs open. browser_open opens one.';
    }
    case 'browser_read': {
      const tab = await agentTab(input.tab, { reading: true, sender });
      if (await isAgentTab(tab.id)) await requireLanded(tab.id, name);
      return readTab(tab.id, input.offset);
    }
    case 'browser_click': {
      const tab = await agentTab(input.tab);
      await requireLanded(tab.id, name);
      await inPage(tab.id, findAndClick, [String(input.ref)]);
      await settled(tab.id);
      await requireLanded(tab.id, name, { loaded: true, before: tab.url });
      return `Clicked [${input.ref}].\n${await readTab(tab.id)}`;
    }
    case 'browser_type': {
      const tab = await agentTab(input.tab);
      await requireLanded(tab.id, name);
      await inPage(tab.id, findAndType, [String(input.ref), String(input.text ?? ''), !!input.submit]);
      if (input.submit) await settled(tab.id);
      await requireLanded(tab.id, name, { loaded: true, before: tab.url });
      return `Typed into [${input.ref}]${input.submit ? ' and submitted' : ''}.\n${await readTab(tab.id)}`;
    }
    case 'browser_scroll': {
      const tab = await agentTab(input.tab);
      await requireLanded(tab.id, name);
      const at = await inPage(tab.id, scrollPage, [input.direction ?? 'down']);
      await sleep(SETTLE_MS);
      return `Scrolled ${input.direction ?? 'down'}: now at ${at.y} of ${at.height} (a screen is ${at.viewport}). browser_read shows what loaded.`;
    }
    case 'browser_navigate': {
      const tab = await agentTab(input.tab);
      const before = tab.url;
      if (input.back) await chrome.tabs.goBack(tab.id);
      else {
        const url = webUrl(input.url);
        await requireSite(url, name);
        await chrome.tabs.update(tab.id, { url });
      }
      await settled(tab.id);
      await requireLanded(tab.id, name, { loaded: true, before });
      return readTab(tab.id);
    }
    case 'browser_close': {
      const tab = await agentTab(input.tab);
      await chrome.tabs.remove(tab.id);
      return `Closed tab ${tab.id}.`;
    }
    case 'browser_handoff': {
      const tab = await agentTab(input.tab);
      await inPage(tab.id, showHandoffCard, [String(input.reason ?? 'Please finish this step.')]);
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return `Tab ${tab.id} is now in front of the user with your note. Tell the user what to do there and end your turn; when they say they are done, continue with browser_read.`;
    }
    case 'browser_screenshot': {
      const tab = await agentTab(input.tab, { reading: true, sender });
      if (await isAgentTab(tab.id)) await requireLanded(tab.id, name);
      return screenshot(tab);
    }
    default:
      throw new ToolError(`Unknown tool ${name}.`);
  }
}

// --- The side panel ---

/**
 * A request from the side panel's frame: FreeFlow's page in this extension's panel has no tab (a FreeFlow page in a normal
 * tab always has one), and the spike measured it so (docs/specs/browser-extension.md §2).
 */
const fromPanel = (sender) => !sender.tab && allowedOrigin(sender.origin);

function selectedText() {
  return String(globalThis.getSelection?.()?.toString() ?? '').slice(0, 4000);
}

/** The tab in front of the panel's window, read for one message: its address, title, selection and text. */
async function panelPage(msg, sender) {
  if (!fromPanel(sender)) throw new ToolError('Only the FreeFlow side panel may read the page in front.');
  const windowId = Number(msg.window);
  const { [`panel:${windowId}`]: key } = await chrome.storage.session.get(`panel:${windowId}`);
  if (!key || msg.key !== key) throw new ToolError('The side panel is not open in that window.');
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab?.id || !/^https?:/.test(tab.url ?? '')) throw new ToolError('The page in front cannot be read.');
  const page = await inPage(tab.id, readPage, [0, MAX_READ]);
  const [sel] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: selectedText }).catch(() => [null]);
  // The agent's own tab (the person is looking at one it opened): it may use every tool there, so it is not shared.
  const mine = (await agentTabs()).has(tab.id);
  if (!mine) await shareTab(tab.id);
  return { tab: tab.id, agentTab: mine, url: page.url, title: page.title, text: page.text, truncated: /\n\n\[\d+ more characters: browser_read with offset \d+\]$/.test(page.text), selection: sel?.result || undefined };
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!allowedOrigin(sender.origin)) {
    sendResponse({ ok: false, error: 'This page may not use the FreeFlow browser extension.' });
    return false;
  }
  if (msg?.type === 'ping') {
    sendResponse({ ok: true, version: VERSION, tools: TOOLS });
    return false;
  }
  if (msg?.type === 'page') {
    panelPage(msg, sender).then(
      (page) => sendResponse({ ok: true, ...page }),
      (e) => sendResponse({ ok: false, error: e instanceof ToolError ? e.message : `The page could not be read: ${e?.message ?? e}` }),
    );
    return true;
  }
  if (msg?.type === 'call' && TOOLS.includes(msg.name)) {
    run(msg.name, msg.input ?? {}, sender).then(
      // A tool answers with text, or with text and a picture ({ content, image }).
      (out) => sendResponse(typeof out === 'string' ? { ok: true, content: out } : { ok: true, ...out }),
      (e) => sendResponse({ ok: false, error: e instanceof ToolError ? e.message : `The browser tool failed: ${e?.message ?? e}` }),
    );
    return true; // answered later
  }
  sendResponse({ ok: false, error: 'Unknown request.' });
  return false;
});
