// The page's side of the web tools (prototype): passes the assistant's browser_* calls to the FreeFlow browser extension
// (packages/browser-extension) in this same browser, and says in the turn's context whether it is there, so the assistant
// is offered the tools only when they can run. The extension answers only FreeFlow's own pages (its
// `externally_connectable`); its id is fixed by the `key` in its manifest. Mail's and Calendar's panels use it too
// (their lib/docsAgent.ts), so it imports nothing of the Docs editor.
import { BROWSER_TOOLS, type ClientToolCall } from '../../../shared/agent/protocol.ts';

/** A web tool's failure, said to the assistant as it is (a closed tab, a missing element, no extension). */
export class WebToolError extends Error {}

/** The extension's id, from its manifest's `key` (unpacked builds keep it). */
export const BROWSER_EXTENSION_ID = 'gnmcgiakoiplophhcoekeeaghfiipglo';

interface ExtensionAnswer {
  ok: boolean;
  content?: string;
  error?: string;
  version?: string;
}

interface ChromeRuntime {
  sendMessage(id: string, message: unknown, callback: (answer: ExtensionAnswer | undefined) => void): void;
  lastError?: { message?: string };
}

/** `chrome.runtime` exists in a page only when an installed extension lists the page's origin as one that may message it. */
const runtime = (): ChromeRuntime | null => (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime ?? null;

function send(message: unknown, timeoutMs: number): Promise<ExtensionAnswer | null> {
  const rt = runtime();
  if (!rt?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      rt.sendMessage(BROWSER_EXTENSION_ID, message, (answer) => {
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

let present = false;
let checking: Promise<boolean> | null = null;

/** Whether the extension answers; asked once, then again only when asked to (`recheck`). */
export function checkBrowserExtension(recheck = false): Promise<boolean> {
  if (!checking || recheck) checking = send({ type: 'ping' }, 1500).then((a) => (present = !!a?.ok));
  return checking;
}

/** What the last check found: the context of the next request says so. */
export const browserExtensionPresent = (): boolean => present;

export const isWebTool = (name: string): boolean => BROWSER_TOOLS.has(name);

/** Run one browser_* call in the extension; its text, or a WebToolError the assistant is told. */
export async function runWebTool(call: ClientToolCall): Promise<string> {
  // A page load can take a while (the extension waits up to 20 s), and a click then reads the page.
  const answer = await send({ type: 'call', name: call.name, input: call.input }, 60_000);
  if (!answer) {
    present = false;
    throw new WebToolError('The FreeFlow browser extension did not answer: it may have been removed or turned off. Tell the user.');
  }
  if (!answer.ok) throw new WebToolError(answer.error ?? 'The browser tool failed.');
  return answer.content ?? '';
}
