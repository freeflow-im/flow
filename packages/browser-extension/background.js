// FreeFlow Browser. Lets the FreeFlow assistant use web pages in this browser: the assistant's turn pauses
// on a browser_* tool, the FreeFlow page that started the turn passes the call here (chrome.runtime.sendMessage, allowed
// by `externally_connectable` for FreeFlow's origins only), and this worker runs it and answers with text.
//
// The agent works only in tabs it opened, kept in one collapsed "FreeFlow agent" group per window. It never touches the
// person's own tabs, never types into password fields (it hands those pages to the person instead), and the toolbar
// button closes every agent tab at once. Pages are read as text with numbered references for links, buttons and fields;
// the numbers are kept on the elements (data-flow-ref) so a click or a typed value names what a read showed.
//
// Ideas from anomalyco/browse (MIT): agent tabs in a collapsed group, the take-back toolbar button, handing a tab to the
// person. The actions are this file's own (chrome.scripting), so nothing runs agent code. In the dev build only,
// browser_screenshot attaches the debugger for the one capture, so a tab in the background can be drawn; the customer
// build (package.mjs) has no debugger permission and shows the tab for a moment instead.

const VERSION = chrome.runtime.getManifest().version;
const GROUP_TITLE = 'FreeFlow agent';
const LOAD_TIMEOUT_MS = 20_000;
const SETTLE_MS = 600;
const MAX_READ = 20_000;

const TOOLS = ['browser_open', 'browser_tabs', 'browser_read', 'browser_click', 'browser_type', 'browser_scroll', 'browser_navigate', 'browser_close', 'browser_handoff', 'browser_screenshot'];
const SHOT_MAX_WIDTH = 1280;
const SHOT_TIMEOUT_MS = 8000;

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
  await chrome.action.setBadgeText({ text: set.size ? String(set.size) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
}

async function agentTab(tab) {
  const id = Number(tab);
  if (!Number.isInteger(id) || !(await agentTabs()).has(id)) throw new ToolError(`Tab ${tab} is not one of your tabs. browser_tabs lists them; browser_open opens one.`);
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
});

// The toolbar button: stop the agent by closing every tab it opened.
chrome.action.onClicked.addListener(async () => {
  const set = await agentTabs();
  await saveTabs(new Set());
  if (set.size) await chrome.tabs.remove([...set]).catch(() => {});
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

async function readTab(tabId, offset = 0) {
  const page = await inPage(tabId, readPage, [Math.max(0, Number(offset) || 0), MAX_READ]);
  return `Tab ${tabId}: ${page.title}\nURL: ${page.url}\n\n${page.text || '(the page shows no text)'}`;
}

async function run(name, input, sender) {
  switch (name) {
    case 'browser_open': {
      const url = webUrl(input.url);
      const tab = await chrome.tabs.create({ url, active: false, ...(sender.tab ? { windowId: sender.tab.windowId } : {}) });
      const set = await agentTabs();
      set.add(tab.id);
      await saveTabs(set);
      await addToGroup(tab.id, tab.windowId);
      await settled(tab.id);
      return `Opened tab ${tab.id}.\n${await readTab(tab.id)}`;
    }
    case 'browser_tabs': {
      const tabs = await Promise.all([...(await agentTabs())].map((id) => chrome.tabs.get(id).catch(() => null)));
      const open = tabs.filter(Boolean);
      return open.length ? open.map((t) => `Tab ${t.id}: ${t.title} — ${t.url}`).join('\n') : 'You have no tabs open. browser_open opens one.';
    }
    case 'browser_read': {
      const tab = await agentTab(input.tab);
      return readTab(tab.id, input.offset);
    }
    case 'browser_click': {
      const tab = await agentTab(input.tab);
      await inPage(tab.id, findAndClick, [String(input.ref)]);
      await settled(tab.id);
      return `Clicked [${input.ref}].\n${await readTab(tab.id)}`;
    }
    case 'browser_type': {
      const tab = await agentTab(input.tab);
      await inPage(tab.id, findAndType, [String(input.ref), String(input.text ?? ''), !!input.submit]);
      if (input.submit) await settled(tab.id);
      return `Typed into [${input.ref}]${input.submit ? ' and submitted' : ''}.\n${await readTab(tab.id)}`;
    }
    case 'browser_scroll': {
      const tab = await agentTab(input.tab);
      const at = await inPage(tab.id, scrollPage, [input.direction ?? 'down']);
      await sleep(SETTLE_MS);
      return `Scrolled ${input.direction ?? 'down'}: now at ${at.y} of ${at.height} (a screen is ${at.viewport}). browser_read shows what loaded.`;
    }
    case 'browser_navigate': {
      const tab = await agentTab(input.tab);
      if (input.back) await chrome.tabs.goBack(tab.id);
      else await chrome.tabs.update(tab.id, { url: webUrl(input.url) });
      await settled(tab.id);
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
      const tab = await agentTab(input.tab);
      return screenshot(tab);
    }
    default:
      throw new ToolError(`Unknown tool ${name}.`);
  }
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
