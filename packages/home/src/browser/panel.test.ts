// FreeFlow Browser's side panel (panel.ts): which messages the page trusts, what a message carries, and how browser calls run.
import { describe, expect, it, vi } from 'vitest';
import { panelContext, panelExtensionId, panelMessage, runPanelCalls, shortAddress } from './panel';

const DEV = 'gnmcgiakoiplophhcoekeeaghfiipglo';
const parent = {};

describe('the browser side panel page', () => {
  it('is in the panel only when FreeFlow Browser frames it', () => {
    expect(panelExtensionId([`chrome-extension://${DEV}`])).toBe(DEV);
    expect(panelExtensionId(['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])).toBeNull();
    expect(panelExtensionId(['https://evil.example'])).toBeNull();
    expect(panelExtensionId([])).toBeNull();
  });

  it('takes the panel page\'s messages only from its origin and its own window', () => {
    const tab = { id: 5, title: 'Docs', url: 'https://example.com/', readable: true };
    expect(panelMessage({ origin: `chrome-extension://${DEV}`, source: parent, data: { type: 'flow-panel', key: 'k', window: 3 } }, DEV, parent)).toEqual({ type: 'flow-panel', key: 'k', window: 3 });
    expect(panelMessage({ origin: `chrome-extension://${DEV}`, source: parent, data: { type: 'flow-tab', tab } }, DEV, parent)).toEqual({ type: 'flow-tab', tab });
    expect(panelMessage({ origin: `chrome-extension://${DEV}`, source: parent, data: { type: 'flow-tab', tab: { ...tab, agent: true } } }, DEV, parent)).toEqual({ type: 'flow-tab', tab: { ...tab, agent: true } });
    expect(panelMessage({ origin: 'https://evil.example', source: parent, data: { type: 'flow-tab', tab } }, DEV, parent)).toBeNull();
    expect(panelMessage({ origin: `chrome-extension://${DEV}`, source: {}, data: { type: 'flow-tab', tab } }, DEV, parent)).toBeNull();
    expect(panelMessage({ origin: `chrome-extension://${DEV}`, source: parent, data: { type: 'flow-tab', tab: { id: 'x' } } }, DEV, parent)).toBeNull();
  });

  it('sends the page with a message unless the person took it off', async () => {
    const read = vi.fn(async () => ({ page: { tab: 5, url: 'https://example.com/', title: 'Example', text: 'Hi' } }));
    expect(await panelContext({ key: 'k', window: 3 }, read, async () => true)).toEqual({ browser: true, webPage: { tab: 5, url: 'https://example.com/', title: 'Example', text: 'Hi' } });
    expect(read).toHaveBeenCalledWith('k', 3);
    expect(await panelContext(null, read, async () => true)).toEqual({ browser: true });
    // A page that cannot be read goes without it; the message is still sent.
    expect(await panelContext({ key: 'k', window: 3 }, async () => ({ error: 'no' }), async () => false)).toEqual({});
  });

  it('runs the web tools in the extension, with their pictures, and refuses the apps\' own tools', async () => {
    const run = vi.fn(async (call: { name: string }, attach?: (img: { mediaType: 'image/jpeg'; data: string }) => boolean) => {
      if (call.name === 'browser_screenshot') attach?.({ mediaType: 'image/jpeg', data: 'AAAA' });
      if (call.name === 'browser_click') throw new Error('Tab 5 is the user\'s own tab');
      return `did ${call.name}`;
    });
    const answer = await runPanelCalls(
      [{ id: 'a', name: 'browser_read', input: { tab: 5 } }, { id: 'b', name: 'browser_screenshot', input: { tab: 5 } }, { id: 'c', name: 'browser_click', input: { tab: 5, ref: '1' } }, { id: 'd', name: 'open_sheet' }],
      run as never,
      (n) => n.startsWith('browser_'),
    );
    expect(answer.toolResults).toEqual([
      { id: 'a', content: 'did browser_read' },
      { id: 'b', content: 'did browser_screenshot' },
      { id: 'c', isError: true, content: 'Tab 5 is the user\'s own tab' },
      { id: 'd', isError: true, content: expect.stringContaining('works only on its app') },
    ]);
    expect(answer.images).toEqual([{ mediaType: 'image/jpeg', data: 'AAAA' }]);
    expect(answer.message).toContain('browser_screenshot');
    expect(answer.pictures).toEqual({ b: 'data:image/jpeg;base64,AAAA' });
  });

  it('shows a short address on the chip', () => {
    expect(shortAddress('https://developers.cloudflare.com/r2/pricing/')).toBe('developers.cloudflare.com/r2/pricing/');
    expect(shortAddress('https://example.com/')).toBe('example.com');
  });
});
