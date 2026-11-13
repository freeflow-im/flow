import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SuiteMenuPicker } from '@flow/suite-bar';
import { Sidebar, appLinks } from './Sidebar';

const picker: SuiteMenuPicker = {
  items: [
    { id: 'account:a', label: 'me@x.test', icon: 'user', href: '/mail/?account=a' },
    { id: 'account:b', label: 'me@y.test', icon: 'user', href: '/mail/?account=b' },
  ],
  selected: 'account:a',
  label: 'x.test',
};

function draw(p: SuiteMenuPicker | undefined, onPickerItem = vi.fn()) {
  render(
    <Sidebar
      apps={appLinks({ mailUnread: 1, chatUnread: 0, admin: false })}
      active="home"
      activeChannel={null}
      channels={[]}
      agents={[]}
      onOpenAgent={() => {}}
      addAgentHref={null}
      menus={{ mail: { items: [{ id: 'folder:INBOX', label: 'Inbox', icon: 'inbox' }], selected: 'folder:INBOX', ...(p ? { picker: p } : {}) } }}
      onMenuItem={() => {}}
      onPickerItem={onPickerItem}
    />,
  );
  return onPickerItem;
}

afterEach(cleanup);

describe('the Mail row picker', () => {
  it('opens the accounts from Mail ▾ and hands the choice to Mail', () => {
    const pick = draw(picker);
    expect(screen.getByTestId('home-app-mail').getAttribute('href')).toBe('/mail/');
    expect(screen.queryByTestId('home-picker-list-mail')).toBeNull();
    expect(screen.getByTestId('home-picker-label-mail').textContent).toBe('x.test');
    fireEvent.click(screen.getByTestId('home-picker-mail'));
    const options = screen.getAllByRole('menuitemradio');
    expect(options.map((o) => [o.textContent, o.getAttribute('aria-checked')])).toEqual([
      ['me@x.test', 'true'],
      ['me@y.test', 'false'],
    ]);
    fireEvent.click(options[1]!);
    expect(pick).toHaveBeenCalledWith('mail', picker.items[1]);
    expect(screen.queryByTestId('home-picker-list-mail')).toBeNull();
  });

  it('is not drawn without a picker or with one account', () => {
    draw(undefined);
    expect(screen.queryByTestId('home-picker-mail')).toBeNull();
    cleanup();
    draw({ items: [picker.items[0]!], selected: 'account:a' });
    expect(screen.queryByTestId('home-picker-mail')).toBeNull();
  });
});

describe('the sections', () => {
  it('lists Agents before Channels', () => {
    draw(undefined);
    const nav = screen.getByTestId('home-sidebar').textContent ?? '';
    expect(nav.indexOf('Agents')).toBeGreaterThan(-1);
    expect(nav.indexOf('Agents')).toBeLessThan(nav.indexOf('Channels'));
  });
});
