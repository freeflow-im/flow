// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { findMenuItem, isMenuMessage, isSelectMessage, useHomeMenu, type SuiteMenuItem } from './menu';

const embed = vi.hoisted(() => ({ inHome: false }));
vi.mock('./embed', () => ({ isInHome: () => embed.inHome }));

const ITEMS: SuiteMenuItem[] = [
  { id: 'compose', label: 'Compose', icon: 'pen' },
  { id: 'folder:INBOX', label: 'Inbox', icon: 'inbox', count: 3 },
  { id: 'more', label: 'More folders', children: [{ id: 'folder:hiring', label: 'hiring', icon: 'folder' }] },
];

function Menu(props: { items: SuiteMenuItem[]; selected: string | null; onSelect: (id: string) => void }) {
  useHomeMenu('mail', props.items, props.selected, props.onSelect);
  return null;
}

afterEach(() => {
  cleanup();
  embed.inHome = false;
  vi.restoreAllMocks();
});

describe('the menu messages', () => {
  it('knows its own messages', () => {
    expect(isMenuMessage({ type: 'flow:menu', v: 1, app: 'mail', items: [], selected: null })).toBe(true);
    expect(isMenuMessage({ type: 'flow:menu', v: 2, app: 'mail', items: [], selected: null })).toBe(false);
    expect(isSelectMessage({ type: 'flow:select', v: 1, app: 'mail', id: 'compose' })).toBe(true);
    expect(isSelectMessage({ type: 'flow:select', v: 1, app: 'mail' })).toBe(false);
  });

  it('finds an item among the children', () => {
    expect(findMenuItem(ITEMS, 'folder:hiring')?.label).toBe('hiring');
    expect(findMenuItem(ITEMS, 'nothing')).toBeNull();
  });
});

describe('useHomeMenu', () => {
  it('sends nothing outside Home', () => {
    const post = vi.spyOn(window, 'postMessage');
    render(<Menu items={ITEMS} selected="folder:INBOX" onSelect={() => {}} />);
    expect(post).not.toHaveBeenCalled();
  });

  it('inside Home, sends the menu once per change and hands Home\'s clicks to the app', () => {
    embed.inHome = true;
    // In the test the page is its own top window: what it posts "to Home" arrives here.
    const post = vi.spyOn(window, 'postMessage');
    const onSelect = vi.fn();
    const view = render(<Menu items={ITEMS} selected="folder:INBOX" onSelect={onSelect} />);
    view.rerender(<Menu items={[...ITEMS]} selected="folder:INBOX" onSelect={onSelect} />);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toMatchObject({ type: 'flow:menu', app: 'mail', selected: 'folder:INBOX' });
    view.rerender(<Menu items={ITEMS} selected="compose" onSelect={onSelect} />);
    expect(post).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, source: window, data: { type: 'flow:select', v: 1, app: 'mail', id: 'folder:hiring' } }));
    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, source: window, data: { type: 'flow:select', v: 1, app: 'docs', id: 'x' } }));
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://elsewhere.example', source: window, data: { type: 'flow:select', v: 1, app: 'mail', id: 'y' } }));
    expect(onSelect.mock.calls).toEqual([['folder:hiring']]);
  });
});
