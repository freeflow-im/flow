// FreeFlow Browser's side panel (docs/specs/browser-extension.md): this page in the extension's panel frame. Two channels:
// - the panel page (the frame's parent, chrome-extension://<id>) tells it the panel's key and window, and the tab in front
//   as it changes (postMessage, checked by origin and source);
// - it asks the extension (chrome.runtime.sendMessage, through browserBridge) for the page's text when a message is sent,
//   and runs the agent's browser_* calls there.
import { askBrowserExtension, checkBrowserExtension, isBrowserExtensionId, isWebTool, pinBrowserExtension, runWebTool, webPicturesNote } from '../../../docs/client/src/agent/browserBridge';
import { MAX_IMAGES_PER_MESSAGE, MAX_WEB_PAGE_SELECTION, MAX_WEB_PAGE_TEXT, type AgentImage, type WebPageContext } from '../../../docs/shared/agent/protocol';
import type { SuiteToolAnswer, SuiteToolCall } from '@flow/suite-bar/assistant-chat';

/** The tab in front of the panel's window, as the panel page says (no text: that is read only on send). */
export interface PanelTab {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
  /** An http(s) page the extension may read (not chrome://, the Web Store or a new tab). */
  readable: boolean;
}

/** What the panel page sends the frame. */
export type PanelMessage =
  | { type: 'flow-panel'; key: string; window: number }
  | { type: 'flow-tab'; tab: PanelTab | null };

/** The extension whose panel holds this page, from the frame's parent origin; null when the page is not in its panel. */
export function panelExtensionId(ancestors: ArrayLike<string> | undefined = window.location.ancestorOrigins): string | null {
  const parent = ancestors?.[0];
  const m = parent ? /^chrome-extension:\/\/([a-p]{32})$/.exec(parent) : null;
  return m && isBrowserExtensionId(m[1]!) ? m[1]! : null;
}

/** A message from the panel page, or null for anything else (another frame, another origin, another shape). */
export function panelMessage(e: { origin: string; source: unknown; data: unknown }, extensionId: string, parent: unknown): PanelMessage | null {
  if (e.origin !== `chrome-extension://${extensionId}` || e.source !== parent) return null;
  const d = e.data as Partial<PanelMessage> | null;
  if (d?.type === 'flow-panel' && typeof d.key === 'string' && Number.isInteger(d.window)) return { type: 'flow-panel', key: d.key, window: d.window! };
  if (d?.type === 'flow-tab') {
    const t = d.tab as Partial<PanelTab> | null | undefined;
    if (!t) return { type: 'flow-tab', tab: null };
    if (!Number.isInteger(t.id) || typeof t.url !== 'string') return null;
    return { type: 'flow-tab', tab: { id: t.id!, title: String(t.title ?? ''), url: t.url, readable: !!t.readable, ...(typeof t.favIconUrl === 'string' ? { favIconUrl: t.favIconUrl } : {}) } };
  }
  return null;
}

export { pinBrowserExtension };

/** The page in front, read by the extension for one message; null when it cannot be read (the reason in `error`). */
export async function readPanelPage(key: string, windowId: number): Promise<{ page: WebPageContext } | { error: string }> {
  const a = await askBrowserExtension({ type: 'page', key, window: windowId });
  if (!a) return { error: 'The FreeFlow browser extension did not answer.' };
  if (!a.ok) return { error: a.error ?? 'The page could not be read.' };
  const page: WebPageContext = {
    tab: Number(a.tab),
    url: String(a.url ?? ''),
    title: String(a.title ?? ''),
    text: String(a.text ?? '').slice(0, MAX_WEB_PAGE_TEXT),
    ...(a.truncated ? { truncated: true } : {}),
    ...(typeof a.selection === 'string' && a.selection.trim() ? { selection: a.selection.slice(0, MAX_WEB_PAGE_SELECTION) } : {}),
  };
  return { page };
}

/** The context a message from the panel carries: the browser tools, and the page unless the person left it out. */
export async function panelContext(include: { key: string; window: number } | null, read = readPanelPage, check = checkBrowserExtension): Promise<Record<string, unknown>> {
  const browser = await check(true);
  if (!include) return browser ? { browser: true } : {};
  const r = await read(include.key, include.window);
  return { ...(browser ? { browser: true } : {}), ...('page' in r ? { webPage: r.page } : {}) };
}

/** Runs the browser_* calls a turn paused on, in the extension; any other browser tool belongs to an app's own page. */
export async function runPanelCalls(calls: SuiteToolCall[], run: typeof runWebTool = runWebTool, isWeb: typeof isWebTool = isWebTool): Promise<SuiteToolAnswer> {
  const images: AgentImage[] = [];
  const pictures: Record<string, string> = {};
  const toolResults: SuiteToolAnswer['toolResults'] = [];
  for (const call of calls) {
    if (!isWeb(call.name)) {
      toolResults.push({ id: call.id, isError: true, content: `${call.name} works only on its app's open page (Docs, Mail or Calendar), not in the browser side panel. Tell the person to open that app if they want it.` });
      continue;
    }
    const before = images.length;
    try {
      const content = await run({ id: call.id, name: call.name, input: call.input ?? {} }, (img) => images.length < MAX_IMAGES_PER_MESSAGE && images.push(img) > 0);
      const shot = images.length > before ? images[images.length - 1] : undefined;
      if (shot) pictures[call.id] = `data:${shot.mediaType};base64,${shot.data}`;
      toolResults.push({ id: call.id, content });
    } catch (e) {
      toolResults.push({ id: call.id, isError: true, content: e instanceof Error ? e.message : String(e) });
    }
  }
  return { toolResults, ...(images.length ? { images, message: webPicturesNote(images.length) } : {}), pictures };
}

/** The address shown on the page chip: its host and path, short. */
export function shortAddress(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}
