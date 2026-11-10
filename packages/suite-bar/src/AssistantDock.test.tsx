import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { AssistantDock, AssistantDockControls, IDLE_CLOSE_MS, useAssistantDock, useAssistantDockState, useIdleMinimize, useNewChatOnClose } from './AssistantDock';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

/** An app around the dock: its open state, its panel with the header buttons and a draft, as Mail or Calendar have. */
function App({ hold = false, activity = [] as unknown[], shortcut }: { hold?: boolean; activity?: unknown[]; shortcut?: string }) {
  const [open, setOpen] = useState(false);
  const state = useAssistantDockState('test.assistant', open, setOpen);
  return (
    <AssistantDock state={state} shortcut={shortcut}>
      <Panel hold={hold} activity={activity} />
    </AssistantDock>
  );
}

function Panel({ hold, activity }: { hold: boolean; activity: unknown[] }) {
  const { placement, expanded } = useAssistantDock();
  const [draft, setDraft] = useState('');
  useIdleMinimize([draft, ...activity], hold);
  return (
    <aside data-testid="panel" data-placement={placement} data-expanded={expanded}>
      <AssistantDockControls />
      <textarea aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
    </aside>
  );
}

const dock = () => screen.getByTestId('assistant-dock');

describe('AssistantDock', () => {
  it('is the pill until opened, then the floating panel, and the pill again when minimized', () => {
    render(<App shortcut="⌘K" />);
    expect(dock().className).toBe('assistant-dock closed');
    expect(screen.queryByTestId('panel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Assistant (⌘K)' }));
    expect(dock().className).toBe('assistant-dock open');
    expect(screen.getByTestId('panel').dataset.placement).toBe('floating');
    fireEvent.click(screen.getByRole('button', { name: 'Minimize to the launcher' }));
    expect(dock().className).toBe('assistant-dock closed');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open Assistant (⌘K)' }));
  });

  it('anchors and floats again, remembering the placement and the size', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Assistant' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand the panel' }));
    expect(dock().className).toBe('assistant-dock expanded');
    expect(localStorage.getItem('test.assistant-expanded')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Anchor the panel beside the page' }));
    expect(dock().className).toBe('assistant-dock docked');
    expect(screen.getByTestId('panel').dataset.placement).toBe('docked');
    expect(localStorage.getItem('test.assistant-placement')).toBe('docked');
    expect(screen.queryByRole('button', { name: 'Expand the panel' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Float the panel' }));
    expect(dock().className).toBe('assistant-dock expanded');
    expect(localStorage.getItem('test.assistant-placement')).toBe('floating');
  });

  it('closing the docked panel brings the pill back, and it opens docked again', () => {
    localStorage.setItem('test.assistant-placement', 'docked');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Assistant' }));
    expect(dock().className).toBe('assistant-dock docked');
    fireEvent.click(screen.getByRole('button', { name: 'Close assistant' }));
    expect(dock().className).toBe('assistant-dock closed');
    fireEvent.click(screen.getByRole('button', { name: 'Open Assistant' }));
    expect(dock().className).toBe('assistant-dock docked');
  });

  it('keeps the panel (and its draft) when anchoring and floating', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Assistant' }));
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anchor the panel beside the page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Float the panel' }));
    expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('Hello');
  });
});

describe('useIdleMinimize', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('minimizes the floating panel after the idle time, counted from the last text', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Assistant' }));
    act(() => vi.advanceTimersByTime(IDLE_CLOSE_MS - 1000));
    expect(dock().className).toBe('assistant-dock open');
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'H' } });
    act(() => vi.advanceTimersByTime(IDLE_CLOSE_MS - 1000));
    expect(dock().className).toBe('assistant-dock open');
    act(() => vi.advanceTimersByTime(1000));
    expect(dock().className).toBe('assistant-dock closed');
  });

  it('holds while the app says so, and never when docked', () => {
    const { rerender } = render(<App hold />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Assistant' }));
    act(() => vi.advanceTimersByTime(IDLE_CLOSE_MS * 2));
    expect(dock().className).toBe('assistant-dock open');
    rerender(<App hold={false} />);
    act(() => vi.advanceTimersByTime(IDLE_CLOSE_MS));
    expect(dock().className).toBe('assistant-dock closed');

    fireEvent.click(screen.getByRole('button', { name: 'Open Assistant' }));
    fireEvent.click(screen.getByRole('button', { name: 'Anchor the panel beside the page' }));
    act(() => vi.advanceTimersByTime(IDLE_CLOSE_MS * 2));
    expect(dock().className).toBe('assistant-dock docked');
  });
});

describe('useNewChatOnClose', () => {
  function Chat({ open, running, reset }: { open: boolean; running: boolean; reset: () => void }) {
    useNewChatOnClose(open, running, reset);
    return null;
  }

  it('resets the chat when the panel closes, not on the first draw or while it stays open', () => {
    const reset = vi.fn();
    const { rerender } = render(<Chat open={false} running={false} reset={reset} />);
    expect(reset).not.toHaveBeenCalled();
    rerender(<Chat open running={false} reset={reset} />);
    rerender(<Chat open running={false} reset={reset} />);
    expect(reset).not.toHaveBeenCalled();
    rerender(<Chat open={false} running={false} reset={reset} />);
    expect(reset).toHaveBeenCalledTimes(1);
    rerender(<Chat open={false} running={false} reset={reset} />);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('waits for a running turn to finish, unless the panel is opened again first', () => {
    const reset = vi.fn();
    const { rerender } = render(<Chat open running reset={reset} />);
    rerender(<Chat open={false} running reset={reset} />);
    expect(reset).not.toHaveBeenCalled();
    rerender(<Chat open={false} running={false} reset={reset} />);
    expect(reset).toHaveBeenCalledTimes(1);

    rerender(<Chat open running reset={reset} />);
    rerender(<Chat open={false} running reset={reset} />);
    rerender(<Chat open running reset={reset} />);
    rerender(<Chat open running={false} reset={reset} />);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
