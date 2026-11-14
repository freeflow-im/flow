import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSidePanelState, SidePanel, sidePanelsOf } from './SidePanel';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const PANELS = sidePanelsOf('mail');
const frames = () => [...document.querySelectorAll('iframe')];

describe('SidePanel', () => {
  it('shows Mail the Calendar and Docs panels its manifest names', () => {
    expect(PANELS.map((p) => [p.app, p.path])).toEqual([['calendar', '/calendar/panel'], ['docs', '/docs/panel']]);
  });

  it('is a pill with a button per panel until one is chosen, then that tab in a frame', () => {
    render(<SidePanel host="mail" panels={PANELS} />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(frames()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Show Docs' }));
    expect(screen.getByRole('tab', { name: 'Docs' }).getAttribute('aria-selected')).toBe('true');
    expect(frames().map((f) => f.getAttribute('src'))).toEqual(['/docs/panel?host=mail']);
  });

  it('keeps a tab it showed, hidden, when another shows', () => {
    render(<SidePanel host="mail" panels={PANELS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Calendar' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Docs' }));
    expect(frames().map((f) => [f.title, f.hidden])).toEqual([['Calendar', true], ['Docs', false]]);
  });

  it('remembers the tab and closes back to the pill, per host', () => {
    const { unmount } = render(<SidePanel host="mail" panels={PANELS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Docs' }));
    unmount();
    expect(readSidePanelState('mail')).toMatchObject({ open: true, tab: 'docs' });
    expect(readSidePanelState('calendar')).toMatchObject({ open: false, tab: null });
    render(<SidePanel host="mail" panels={PANELS} />);
    expect(screen.getByRole('tab', { name: 'Docs' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Close the side panel' }));
    expect(screen.getByRole('button', { name: 'Show Calendar' })).toBeTruthy();
    expect(readSidePanelState('mail').open).toBe(false);
  });

  it('follows an address only its own frames ask for', () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, origin: window.location.origin });
    render(<SidePanel host="mail" panels={PANELS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Calendar' }));
    const frame = frames()[0]!;
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'flow:open', href: '/calendar/day/2026-11-13' }, origin: window.location.origin, source: window }));
    expect(assign).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'flow:open', href: '/calendar/day/2026-11-13' }, origin: window.location.origin, source: frame.contentWindow }));
    expect(assign).toHaveBeenCalledWith('/calendar/day/2026-11-13');
    vi.unstubAllGlobals();
  });

  it('draws nothing for a host with no panels', () => {
    render(<SidePanel host="chat" panels={sidePanelsOf('chat')} />);
    expect(screen.queryByTestId('side-panel')).toBeNull();
  });
});
