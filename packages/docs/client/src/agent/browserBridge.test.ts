import { afterEach, describe, expect, it } from 'vitest';
import { BROWSER_EXTENSION_DEV_ID, checkBrowserExtension, browserExtensionPresent, runWebTool, WebToolError } from './browserBridge.ts';

type Answer = Record<string, unknown> | undefined;

/** A stand-in for chrome.runtime, answering every message with `reply`. */
function fakeExtension(reply: (message: { type: string; name?: string }) => Answer) {
  const sent: { id: string; message: unknown }[] = [];
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage(id: string, message: { type: string }, callback: (a: Answer) => void) {
        sent.push({ id, message });
        queueMicrotask(() => callback(reply(message)));
      },
    },
  };
  return sent;
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('the browser bridge (prototype)', () => {
  it('finds the extension by its fixed id, and says so', async () => {
    const sent = fakeExtension(() => ({ ok: true, version: '0.0.3' }));
    expect(await checkBrowserExtension(true)).toBe(true);
    expect(browserExtensionPresent()).toBe(true);
    expect(sent[0]).toEqual({ id: BROWSER_EXTENSION_DEV_ID, message: { type: 'ping' } });
  });

  it('finds nothing where no extension lets the page message it', async () => {
    expect(await checkBrowserExtension(true)).toBe(false);
    expect(browserExtensionPresent()).toBe(false);
  });

  it('returns a tool’s text, and passes a screenshot to `attach`', async () => {
    fakeExtension((m) => (m.name === 'browser_screenshot' ? { ok: true, content: 'A screenshot is attached.', image: { mediaType: 'image/jpeg', data: 'AAAA' } } : { ok: true, content: 'Tab 7: Example' }));
    expect(await runWebTool({ id: '1', name: 'browser_read', input: { tab: 7 } })).toBe('Tab 7: Example');
    const pictures: unknown[] = [];
    expect(await runWebTool({ id: '2', name: 'browser_screenshot', input: { tab: 7 } }, (img) => pictures.push(img) > 0)).toBe('A screenshot is attached.');
    expect(pictures).toEqual([{ mediaType: 'image/jpeg', data: 'AAAA' }]);
  });

  it('says so when the picture cannot be attached, and passes the extension’s refusals on', async () => {
    fakeExtension((m) => (m.name === 'browser_screenshot' ? { ok: true, content: 'x', image: { mediaType: 'image/jpeg', data: 'AAAA' } } : { ok: false, error: 'Tab 9 is not one of your tabs.' }));
    await expect(runWebTool({ id: '1', name: 'browser_screenshot', input: { tab: 7 } }, () => false)).rejects.toThrow(/could not be attached/);
    await expect(runWebTool({ id: '2', name: 'browser_read', input: { tab: 9 } })).rejects.toEqual(new WebToolError('Tab 9 is not one of your tabs.'));
  });
});
