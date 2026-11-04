import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Attachment, MessageDetail } from '../api';

vi.mock('../api', async (orig) => {
  const real = await orig<typeof import('../api')>();
  return {
    ...real,
    previewApi: {
      create: vi.fn(async () => ({ preview: { id: 'p1', kind: 'doc', filename: 'Plan.docx', size: 10, expiresAt: 0 }, workspace: 'harbor' })),
      save: vi.fn(async () => ({ saved: { kind: 'doc', id: 'd1', title: 'Plan', url: '/workspace/doc/d1' } })),
    },
  };
});
const { AttachmentPreview } = await import('./AttachmentPreview');
const { previewApi } = await import('../api');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const att = (index: number, filename: string, mimeType: string, size = 1000): Attachment => ({ index, filename, mimeType, size, contentId: null, inline: false });
const files = [att(0, 'photo.png', 'image/png'), att(1, 'Plan.docx', 'application/octet-stream'), att(2, 'setup.exe', 'application/octet-stream')];
let message = { uid: 7, folder: 'INBOX', attachments: files } as unknown as MessageDetail;

let root: Root, host: HTMLDivElement, index: number, closed: number;
const render = () =>
  act(() => root.render(createElement(AttachmentPreview, { accountId: 'acc', message, files, index, onIndex: (i: number) => ((index = i), render()), onClose: () => closed++ })));
const key = (k: string) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));
const dialog = () => document.querySelector('[role="dialog"]')!;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  index = 0;
  closed = 0;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe('the attachment preview', () => {
  it('shows a picture inline, with its name, size and type, and Download', async () => {
    await render();
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect(dialog().textContent).toContain('photo.png');
    expect(dialog().textContent).toContain('1000 B · PNG · 1 of 3');
    expect(dialog().querySelector('img')?.getAttribute('src')).toBe('/v1/mail/accounts/acc/messages/7/attachments/0?folder=INBOX&inline=1');
    expect(dialog().querySelector('a[aria-label="Download"]')?.getAttribute('href')).toBe('/v1/mail/accounts/acc/messages/7/attachments/0?folder=INBOX');
    expect(previewApi.create).not.toHaveBeenCalled();
  });

  it('steps with the arrow keys and closes with Escape', async () => {
    await render();
    await key('ArrowLeft');
    expect(index).toBe(0);
    await key('ArrowRight');
    expect(index).toBe(1);
    await key('ArrowRight');
    expect(index).toBe(2);
    await key('ArrowRight');
    expect(index).toBe(2);
    expect(dialog().textContent).toContain('No preview available');
    expect(dialog().querySelector('[aria-label="Next attachment (→)"]')).toBeNull();
    await key('Escape');
    expect(closed).toBe(1);
  });

  it('shows a Word file in Docs’ preview page, and saves it to Docs once asked', async () => {
    // Another message: the page keeps previews it made (the previous test stepped through this one's).
    message = { ...message, uid: 8 };
    index = 1;
    await render();
    await act(async () => {});
    expect(previewApi.create).toHaveBeenCalledWith('acc', 'INBOX', 8, 1, null);
    expect(dialog().querySelector('iframe')?.getAttribute('src')).toBe('/workspace/preview/p1?workspace=harbor');
    const save = [...dialog().querySelectorAll('button')].find((b) => b.textContent?.includes('Save to Docs'))!;
    await act(async () => save.click());
    expect(previewApi.save).toHaveBeenCalledWith('p1', 'harbor');
    const open = dialog().querySelector('a[title^="Open"]');
    expect(open?.getAttribute('href')).toBe('/workspace/doc/d1');
    expect(open?.textContent).toContain('Open in Docs');
    // The same attachment again is not asked of the server again.
    expect(previewApi.create).toHaveBeenCalledTimes(1);
  });
});
