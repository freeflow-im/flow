import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AccessCodeCard, copiedCode } from './AccessCodeCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('AccessCodeCard', () => {
  it('copies the code without spaces or dashes', () => {
    expect(copiedCode('482 913')).toBe('482913');
    expect(copiedCode('AB-12-CD')).toBe('AB12CD');
  });

  it('shows the code and copies it on Copy code', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const onNotice = vi.fn();
    act(() => root.render(createElement(AccessCodeCard, { code: '482 913', onNotice })));
    const card = host.querySelector('[aria-label="Code requested"]')!;
    expect(card.textContent).toContain('Code Requested');
    // One box per character, the space a gap; the whole code is the group's label.
    expect([...card.querySelectorAll('[role="text"] > span')].map((b) => b.textContent)).toEqual(['4', '8', '2', '', '9', '1', '3']);
    expect(card.querySelector('[role="text"]')?.getAttribute('aria-label')).toBe('482 913');
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Copy code'))!;
    await act(async () => { button.click(); });
    expect(writeText).toHaveBeenCalledWith('482913');
    expect(onNotice).toHaveBeenCalledWith({ text: 'Code copied' });
    expect(button.textContent).toContain('Copied');
  });
});
