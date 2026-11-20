import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultRect, fitRect, SCRATCHPAD_PATH } from './Scratchpad';
import { SuiteBar } from './SuiteBar';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const bar = (scratchpad?: false) =>
  render(
    <SuiteBar
      tabs={[{ id: 'chat', label: 'Chat', href: '/chat', active: true }]}
      notifications={{ onOpen() {} }}
      account={{ name: 'Ada Lovelace', email: 'ada@x.com', onProfile() {}, onSettings() {}, onLogout() {} }}
      meetingAlerts={false}
      {...(scratchpad === false ? { scratchpad } : {})}
    />,
  );

describe('scratchpad', () => {
  it('sits beside the bell and opens the scratchpad page in a popup, kept (hidden) when closed', () => {
    bar();
    const button = screen.getByTestId('suite-scratchpad');
    expect(button.nextElementSibling).toBe(screen.getByTestId('suite-notifications'));
    expect(screen.queryByTestId('suite-scratchpad-popup')).toBeNull();

    fireEvent.click(button);
    const popup = screen.getByTestId('suite-scratchpad-popup');
    expect(popup.hidden).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(popup.querySelector('iframe')!.getAttribute('src')).toBe(SCRATCHPAD_PATH);

    fireEvent.click(screen.getByRole('button', { name: 'Close scratchpad' }));
    expect(popup.hidden).toBe(true);
    expect(popup.querySelector('iframe')).not.toBeNull();
    fireEvent.click(button);
    expect(popup.hidden).toBe(false);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(popup.hidden).toBe(true);
  });

  it('can be left out', () => {
    bar(false);
    expect(screen.queryByTestId('suite-scratchpad')).toBeNull();
  });

  it('opens at the top right and stays on screen', () => {
    const view = { w: 1440, h: 900 };
    expect(defaultRect(view)).toEqual({ x: 1440 - 760 - 16, y: 64, w: 760, h: 540 });
    expect(fitRect({ x: 5000, y: -20, w: 100, h: 5000 }, view)).toEqual({ x: 1440 - 360, y: 0, w: 360, h: 900 - 64 - 16 });
  });
});
