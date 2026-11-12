// The page's side of the web tools: passes the assistant's browser_* calls to the FreeFlow browser extension
// (packages/browser-extension) in this same browser, and says in the turn's context whether it is there, so the assistant
// is offered the tools only when they can run. The extension answers only FreeFlow's own pages (its
// `externally_connectable`). It has two ids: the Chrome Web Store build's, and the dev build's (fixed by the `key` in its
// manifest, loaded unpacked); the page asks each and keeps the one that answers. Mail's and Calendar's panels use it too
// (their lib/docsAgent.ts), so it imports nothing of the Docs editor.
import { BROWSER_TOOLS, type AgentImage, type ClientToolCall } from '../../../shared/agent/protocol.ts';

/** A web tool's failure, said to the assistant as it is (a closed tab, a missing element, no extension). */
export class WebToolError extends Error {}

/** The Chrome Web Store build's id, given by the store when the item was first uploaded ('' until then). */
export const BROWSER_EXTENSION_STORE_ID = '';
/** The dev build's id, from its manifest's `key` (unpacked builds keep it). */
export const BROWSER_EXTENSION_DEV_ID = 'gnmcgiakoiplophhcoekeeaghfiipglo';
const EXTENSION_IDS = [BROWSER_EXTENSION_STORE_ID, BROWSER_EXTENSION_DEV_ID].filter(Boolean);
/** The id that last answered a ping; calls go there. */
let extensionId: string = EXTENSION_IDS[0] ?? BROWSER_EXTENSION_DEV_ID;

interface ExtensionAnswer {
  ok: boolean;
  content?: string;
  /** A picture the tool took (browser_screenshot). */
  image?: { mediaType: 'image/jpeg' | 'image/png'; data: string };
  error?: string;
  version?: string;
}

/**
 * What the next request says beside the pictures the web tools took, which the panel attaches to it (the API takes only
 * text in tool results, so the pictures follow them in the same message, as render_slide's do in Docs).
 */
export const webPicturesNote = (count: number): string =>
  `[browser_screenshot: ${count === 1 ? 'the picture is' : 'the pictures are'} attached above, in call order. Added by the app, not written by the user.]`;

interface ChromeRuntime {
  sendMessage(id: string, message: unknown, callback: (answer: ExtensionAnswer | undefined) => void): void;
  lastError?: { message?: string };
}

/** `chrome.runtime` exists in a page only when an installed extension lists the page's origin as one that may message it. */
const runtime = (): ChromeRuntime | null => (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime ?? null;

function send(message: unknown, timeoutMs: number, id = extensionId): Promise<ExtensionAnswer | null> {
  const rt = runtime();
  if (!rt?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      rt.sendMessage(id, message, (answer) => {
        clearTimeout(timer);
        // Reading lastError tells Chrome the failure (no such extension) was handled.
        resolve(rt.lastError ? null : (answer ?? null));
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/** Asks each id in turn (the store build first) and keeps the first that answers. */
async function ping(): Promise<boolean> {
  for (const id of EXTENSION_IDS) {
    const answer = await send({ type: 'ping' }, 1500, id);
    if (answer?.ok) {
      extensionId = id;
      return true;
    }
  }
  return false;
}

let present = false;
let checking: Promise<boolean> | null = null;

/** Whether the extension answers; asked once, then again only when asked to (`recheck`). */
export function checkBrowserExtension(recheck = false): Promise<boolean> {
  if (!checking || recheck) checking = ping().then((ok) => (present = ok));
  return checking;
}

/** What the last check found: the context of the next request says so. */
export const browserExtensionPresent = (): boolean => present;

export const isWebTool = (name: string): boolean => BROWSER_TOOLS.has(name);

/**
 * Run one browser_* call in the extension; its text, or a WebToolError the assistant is told. A picture it took goes to
 * `attach`, which answers false when this step already carries as many pictures as a request may.
 */
export async function runWebTool(call: ClientToolCall, attach?: (image: AgentImage) => boolean): Promise<string> {
  // A page load can take a while (the extension waits up to 20 s), and a click then reads the page.
  const answer = await send({ type: 'call', name: call.name, input: call.input }, 60_000);
  if (!answer) {
    present = false;
    throw new WebToolError('The FreeFlow browser extension did not answer: it may have been removed or turned off. Tell the user.');
  }
  if (!answer.ok) throw new WebToolError(answer.error ?? 'The browser tool failed.');
  const content = answer.content ?? '';
  if (!answer.image) return content;
  if (attach?.({ mediaType: answer.image.mediaType, data: answer.image.data })) return content;
  throw new WebToolError('The screenshot was taken but could not be attached: this step already has as many pictures as it may. Take it again in your next step.');
}
