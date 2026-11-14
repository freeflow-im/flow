import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_TAB, readSidePanelState, SidePanel, sidePanelsOf } from './SidePanel';

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

  describe('the anchored assistant', () => {
    /** Mail around the panel: whether its assistant is open, which its suite bar button toggles. */
    function Host({ initial = false }: { initial?: boolean }) {
      const [open, setOpen] = useState(initial);
      return (
        <>
          <button type="button" onClick={() => setOpen(!open)}>Toggle assistant</button>
          <output data-testid="assistant-open">{String(open)}</output>
          <SidePanel host="mail" panels={PANELS} assistant={{ label: 'Ada', open, setOpen, content: <textarea aria-label="Draft" /> }} />
        </>
      );
    }
    const isOpen = () => screen.getByTestId('assistant-open').textContent;

    it('is the last tab, and opening it opens the assistant', () => {
      render(<Host />);
      fireEvent.click(screen.getByRole('button', { name: 'Show Ada' }));
      expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Calendar', 'Docs', 'Ada']);
      expect(screen.getByRole('tab', { name: 'Ada' }).getAttribute('aria-selected')).toBe('true');
      expect(isOpen()).toBe('true');
      expect(readSidePanelState('mail').tab).toBe(ASSISTANT_TAB);
    });

    it('shows when the app opens the assistant, and closes the panel when the app closes it', () => {
      render(<Host />);
      fireEvent.click(screen.getByRole('button', { name: 'Toggle assistant' }));
      expect(screen.getByRole('tab', { name: 'Ada' }).getAttribute('aria-selected')).toBe('true');
      fireEvent.click(screen.getByRole('button', { name: 'Toggle assistant' }));
      expect(screen.queryByRole('tablist')).toBeNull();
    });

    it('stays open and mounted, hidden, under another tab; closing the panel closes it', () => {
      render(<Host initial />);
      const draft = screen.getByLabelText('Draft') as HTMLTextAreaElement;
      fireEvent.change(draft, { target: { value: 'half a question' } });
      fireEvent.click(screen.getByRole('tab', { name: 'Calendar' }));
      expect(isOpen()).toBe('true');
      expect(draft.closest('[hidden]')).not.toBeNull();
      fireEvent.click(screen.getByRole('tab', { name: 'Ada' }));
      expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('half a question');
      fireEvent.click(screen.getByRole('button', { name: 'Close the side panel' }));
      expect(isOpen()).toBe('false');
    });

    it('leaves another tab showing when the app closes the assistant', () => {
      render(<Host initial />);
      fireEvent.click(screen.getByRole('tab', { name: 'Docs' }));
      fireEvent.click(screen.getByRole('button', { name: 'Toggle assistant' }));
      expect(screen.getByRole('tab', { name: 'Docs' }).getAttribute('aria-selected')).toBe('true');
    });
  });
});
