import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoClose } from './AutoClose';

describe('AutoClose', () => {
  let close: ReturnType<typeof vi.fn<() => void>>;
  let assign: ReturnType<typeof vi.fn<(url: string) => void>>;
  beforeEach(() => {
    vi.useFakeTimers();
    close = vi.fn<() => void>();
    assign = vi.fn<(url: string) => void>();
    vi.spyOn(window, 'close').mockImplementation(close);
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
  const tick = (s: number) => { for (let i = 0; i < s; i++) act(() => { vi.advanceTimersByTime(1000); }); };

  it('counts down, closes the tab, and goes to Meet when the browser keeps it open', () => {
    render(<AutoClose fallbackUrl="/meet/" seconds={3} />);
    expect(screen.getByText(/closes in 3 s/)).toBeTruthy();
    tick(1);
    expect(screen.getByText(/closes in 2 s/)).toBeTruthy();
    tick(2);
    expect(close).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(300); });
    expect(assign).toHaveBeenCalledWith('/meet/');
  });

  it('Keep it open stops the countdown', () => {
    render(<AutoClose fallbackUrl="/meet/" seconds={3} />);
    fireEvent.click(screen.getByText('Keep it open'));
    tick(5);
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByText(/closes in/)).toBeNull();
  });

  it('a guest with nowhere to go is told the tab can be closed', () => {
    render(<AutoClose fallbackUrl={null} seconds={1} />);
    tick(1);
    act(() => { vi.advanceTimersByTime(300); });
    expect(close).toHaveBeenCalled();
    expect(screen.getByText('You can close this tab.')).toBeTruthy();
  });
});
