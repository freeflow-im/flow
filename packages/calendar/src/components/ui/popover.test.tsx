// The event's popover (AnchoredPopover): a click outside closes it, except in the assistant's dock (its pill and panel),
// which the person uses to ask about the event they have open.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnchoredPopover } from './popover';

afterEach(cleanup);

/** A mouse press as a browser sends it: Radix may wait for the click before it dismisses. */
const press = (el: Element) => {
  fireEvent.pointerDown(el, { pointerType: 'mouse' });
  fireEvent.mouseDown(el);
  fireEvent.pointerUp(el, { pointerType: 'mouse' });
  fireEvent.mouseUp(el);
  fireEvent.click(el);
};

describe('AnchoredPopover', () => {
  it('stays open when the assistant is used, and closes on any other click outside', async () => {
    const onClose = vi.fn();
    render(
      <>
        <section data-testid="assistant-dock"><button type="button">Ada</button></section>
        <button type="button">Elsewhere</button>
        <AnchoredPopover anchor={null} onClose={onClose} label="Event"><p>Lunch</p></AnchoredPopover>
      </>,
    );
    expect(screen.getByText('Lunch')).toBeTruthy();
    // Radix listens for outside clicks from the next tick after opening.
    await new Promise((r) => setTimeout(r, 10));
    press(screen.getByText('Ada'));
    fireEvent.focusIn(screen.getByText('Ada'));
    expect(onClose).not.toHaveBeenCalled();
    press(screen.getByText('Elsewhere'));
    expect(onClose).toHaveBeenCalled();
  });
});
