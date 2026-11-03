import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSuiteSearch, SuiteBar, type SuiteBarProps } from './SuiteBar';
import { StatusDialog } from './StatusDialog';
import { AWAY_STATUS, isAway, statusPatch, STATUS_OPTIONS } from './status';

afterEach(cleanup);

function setup(overrides: Partial<SuiteBarProps> = {}) {
  const { props, calls } = build(overrides);
  render(<SuiteBar {...props} />);
  return calls;
}

/** The props a test renders with, without rendering them. */
const setupProps = (overrides: Partial<SuiteBarProps> = {}) => build(overrides).props;

function build(overrides: Partial<SuiteBarProps>) {
  const calls = {
    docs: vi.fn(),
    chat: vi.fn(),
    selectOrg: vi.fn(),
    addOrg: vi.fn(),
    orgSettings: vi.fn(),
    invite: vi.fn(),
    search: vi.fn(),
    assistant: vi.fn(),
    notifications: vi.fn(),
    presence: vi.fn(),
    setStatus: vi.fn(),
    profile: vi.fn(),
    settings: vi.fn(),
    logout: vi.fn(),
    help: vi.fn(),
  };
  const props: SuiteBarProps = {
    tabs: [
      { id: 'docs', label: 'Docs', href: '/workspace', onSelect: calls.docs },
      { id: 'chat', label: 'Chat', href: '/', active: true, badge: 3, onSelect: calls.chat },
      { id: 'mail', label: 'Mail', href: '', disabled: true },
      { id: 'calendar', label: 'Calendar', href: '', disabled: true },
    ],
    organization: {
      name: 'Locked In',
      entries: [
        { id: 'li', name: 'Locked In', unread: 0, active: true },
        { id: 'tx', name: 'Taxed', unread: 2, active: false },
      ],
      onSelect: calls.selectOrg,
      onAdd: calls.addOrg,
      addBadge: 1,
      onSettings: calls.orgSettings,
      onInvite: calls.invite,
    },
    search: { placeholder: 'Search messages', onSubmit: calls.search },
    assistant: { onOpen: calls.assistant },
    notifications: { onOpen: calls.notifications },
    account: {
      name: 'Scott Persinger',
      email: 'scott@example.com',
      presence: { active: true, onToggle: calls.presence },
      onSetStatus: calls.setStatus,
      onProfile: calls.profile,
      onSettings: calls.settings,
      onLogout: calls.logout,
      extra: [{ label: 'Help', onSelect: calls.help }],
    },
    ...overrides,
  };
  return { props, calls };
}

describe('SuiteBar', () => {
  it('shows the brand, the organization and the account', () => {
    setup();
    expect(screen.getByRole('img', { name: 'FreeFlow' })).toBeTruthy();
    expect(screen.getByText('FreeFlow')).toBeTruthy();
    expect(screen.getByTestId('suite-org-button').textContent).toBe('Locked In');
    expect(screen.getByTestId('suite-account-button').textContent).toContain('Scott');
    expect(screen.getByTestId('suite-account-button').textContent).toContain('SP');
  });

  it('marks the active tab and shows its unread badge', () => {
    setup();
    const chat = screen.getByTestId('suite-tab-chat');
    expect(chat.getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('suite-tab-docs').getAttribute('aria-current')).toBeNull();
    expect(chat.textContent).toBe('Chat3');
    expect(screen.getByLabelText('3 unread')).toBeTruthy();
  });

  it('draws no badge for nothing unread', () => {
    setup({ tabs: [{ id: 'chat', label: 'Chat', href: '/', active: true, badge: 0 }] });
    expect(screen.getByTestId('suite-tab-chat').textContent).toBe('Chat');
  });

  it('leaves the placeholders grey and not clickable', () => {
    const calls = setup();
    const mail = screen.getByTestId('suite-tab-mail');
    expect(mail.getAttribute('aria-disabled')).toBe('true');
    expect(mail.getAttribute('href')).toBeNull();
    expect(mail.getAttribute('title')).toBe('Coming soon');
    fireEvent.click(mail);
    fireEvent.keyDown(document, { key: '3', metaKey: true });
    expect(calls.docs).not.toHaveBeenCalled();
    expect(calls.chat).not.toHaveBeenCalled();
  });

  it('switches apps with a click and with ⌘1 / ⌘2', () => {
    const calls = setup();
    fireEvent.click(screen.getByTestId('suite-tab-docs'));
    expect(calls.docs).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: '2', metaKey: true });
    expect(calls.chat).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: '1', ctrlKey: true });
    expect(calls.docs).toHaveBeenCalledTimes(2);
    // Not without the modifier, and not when the page already took the key.
    fireEvent.keyDown(document, { key: '2' });
    const taken = new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true, cancelable: true });
    taken.preventDefault();
    document.dispatchEvent(taken);
    expect(calls.chat).toHaveBeenCalledTimes(1);
  });

  it('opens the search in place, submits it, and collapses it on Esc', () => {
    const calls = setup();
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.click(screen.getByTestId('suite-search'));
    const box = screen.getByRole('searchbox') as HTMLInputElement;
    expect(document.activeElement).toBe(box);
    expect(box.placeholder).toBe('Search messages');
    fireEvent.change(box, { target: { value: 'budget' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByTestId('suite-search')).toBeTruthy();
    expect(calls.search).not.toHaveBeenCalled();

    // ⌘K opens it too; Enter searches and puts the icon back.
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    const again = screen.getByRole('searchbox');
    fireEvent.change(again, { target: { value: '  budget ' } });
    fireEvent.submit(again.closest('form')!);
    expect(calls.search).toHaveBeenCalledWith('budget');
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('collapses the search on a click elsewhere', () => {
    setup();
    fireEvent.click(screen.getByTestId('suite-search'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('a live search reports each change, stays open while it has text, and clears on Esc', () => {
    let value = '';
    const change = vi.fn((q: string) => { value = q; });
    const submit = vi.fn();
    const live = () => ({ search: { placeholder: 'Search files', onSubmit: submit, value, onChange: change } });
    const { rerender } = render(<SuiteBar {...setupProps(live())} />);
    fireEvent.click(screen.getAllByTestId('suite-search')[0]!);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'plan' } });
    expect(change).toHaveBeenLastCalledWith('plan');
    rerender(<SuiteBar {...setupProps(live())} />);
    // A click elsewhere keeps the text that is filtering the page in view; Enter searches and keeps it too.
    fireEvent.mouseDown(document.body);
    const box = screen.getByRole('searchbox') as HTMLInputElement;
    expect(box.value).toBe('plan');
    fireEvent.submit(box.closest('form')!);
    expect(submit).toHaveBeenCalledWith('plan');
    expect(screen.getByRole('searchbox')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(change).toHaveBeenLastCalledWith('');
    rerender(<SuiteBar {...setupProps(live())} />);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('opens from elsewhere on the page with what was typed there', () => {
    let value = '';
    const change = vi.fn((q: string) => { value = q; });
    render(<SuiteBar {...setupProps({ search: { placeholder: 'Search files', onSubmit: vi.fn(), value, onChange: change } })} />);
    act(() => openSuiteSearch('b'));
    expect(change).toHaveBeenCalledWith('b');
    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
  });

  it('opens the organization menu, with unread counts, and its rows act', () => {
    const calls = setup();
    fireEvent.click(screen.getByTestId('suite-org-button'));
    const menu = screen.getByTestId('suite-org-menu');
    expect(menu.textContent).toContain('Your organizations');
    expect(screen.getByTestId('suite-org-li').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('suite-org-tx').textContent).toBe('TTaxed2');
    expect(screen.getByLabelText('1 invitation')).toBeTruthy();

    fireEvent.click(screen.getByTestId('suite-org-tx'));
    expect(calls.selectOrg).toHaveBeenCalledWith('tx');
    expect(screen.queryByTestId('suite-org-menu')).toBeNull();

    // Selecting the organization you are in does nothing but close the menu.
    fireEvent.click(screen.getByTestId('suite-org-button'));
    fireEvent.click(screen.getByTestId('suite-org-li'));
    expect(calls.selectOrg).toHaveBeenCalledTimes(1);

    for (const [id, fn] of [['suite-org-add', calls.addOrg], ['suite-org-settings', calls.orgSettings], ['suite-org-invite', calls.invite]] as const) {
      fireEvent.click(screen.getByTestId('suite-org-button'));
      fireEvent.click(screen.getByTestId(id));
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it('groups organizations by server when there is more than one', () => {
    setup({
      organization: {
        name: 'Locked In',
        entries: [
          { id: 'a', name: 'Locked In', unread: 0, active: true, group: 'app.freeflow.im' },
          { id: 'b', name: 'Lab', unread: 0, active: false, group: 'flow.example.com' },
        ],
        onSelect: () => {},
        onAdd: () => {},
      },
    });
    fireEvent.click(screen.getByTestId('suite-org-button'));
    expect(screen.getByRole('group', { name: 'app.freeflow.im' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'flow.example.com' })).toBeTruthy();
    // No settings or invite rows for someone who may not.
    expect(screen.queryByTestId('suite-org-settings')).toBeNull();
    expect(screen.queryByTestId('suite-org-invite')).toBeNull();
  });

  it('opens the account menu, and every row acts', () => {
    const calls = setup();
    fireEvent.click(screen.getByTestId('suite-account-button'));
    const menu = screen.getByTestId('suite-account-menu');
    expect(menu.textContent).toContain('Scott Persinger');
    expect(menu.textContent).toContain('scott@example.com');
    expect(screen.getByTestId('suite-presence').textContent).toBe('ActiveSet away');
    const rows: [string, ReturnType<typeof vi.fn>][] = [
      ['suite-presence', calls.presence],
      ['suite-set-status', calls.setStatus],
      ['suite-profile', calls.profile],
      ['suite-settings', calls.settings],
      ['suite-logout', calls.logout],
    ];
    for (const [id, fn] of rows) {
      if (!screen.queryByTestId('suite-account-menu')) fireEvent.click(screen.getByTestId('suite-account-button'));
      fireEvent.click(screen.getByTestId(id));
      expect(fn).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('suite-account-menu')).toBeNull();
    }
    fireEvent.click(screen.getByTestId('suite-account-button'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Help' }));
    expect(calls.help).toHaveBeenCalledTimes(1);
  });

  it('closes a menu on Esc and on a click elsewhere', () => {
    setup();
    fireEvent.click(screen.getByTestId('suite-account-button'));
    fireEvent.keyDown(screen.getByTestId('suite-profile'), { key: 'Escape' });
    expect(screen.queryByTestId('suite-account-menu')).toBeNull();
    fireEvent.click(screen.getByTestId('suite-org-button'));
    act(() => {
      fireEvent.mouseDown(document.body);
    });
    expect(screen.queryByTestId('suite-org-menu')).toBeNull();
  });

  it('reads Away, with Set active, while away', () => {
    setup({
      account: { name: 'Ann', email: '', presence: { active: false, onToggle: () => {} }, onProfile: () => {}, onSettings: () => {}, onLogout: () => {} },
    });
    fireEvent.click(screen.getByTestId('suite-account-button'));
    expect(screen.getByTestId('suite-presence').textContent).toBe('AwaySet active');
  });

  it('opens the Assistant and the notifications', () => {
    const calls = setup();
    fireEvent.click(screen.getByTestId('suite-assistant'));
    fireEvent.click(screen.getByTestId('suite-notifications'));
    expect(calls.assistant).toHaveBeenCalledTimes(1);
    expect(calls.notifications).toHaveBeenCalledTimes(1);
  });
});

describe('StatusDialog', () => {
  it('offers the statuses and Clear', () => {
    const pick = vi.fn();
    const clear = vi.fn();
    const close = vi.fn();
    render(<StatusDialog current={{ emoji: '🎧', text: 'Focusing' }} onPick={pick} onClear={clear} onClose={close} />);
    expect(screen.getAllByRole('button').filter((b) => b.className.includes('sb-status-option'))).toHaveLength(STATUS_OPTIONS.length);
    fireEvent.click(screen.getByTestId('suite-status-option-2'));
    expect(pick).toHaveBeenCalledWith(STATUS_OPTIONS[1]);
    fireEvent.click(screen.getByTestId('suite-status-clear'));
    expect(clear).toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalled();
  });
});

describe('status', () => {
  it('builds the PATCH /v1/me bodies', () => {
    expect(statusPatch(STATUS_OPTIONS[0]!)).toEqual({ statusEmoji: '🎧', statusText: 'Focusing', statusSuppressAlerts: true });
    expect(statusPatch(null)).toEqual({ statusEmoji: '', statusText: '', statusSuppressAlerts: false });
    expect(isAway(AWAY_STATUS)).toBe(true);
    expect(isAway({ emoji: '🎧', text: 'Focusing' })).toBe(false);
  });
});
