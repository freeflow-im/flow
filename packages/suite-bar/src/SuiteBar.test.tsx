import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSuiteSearch, SuiteBar, type SuiteBarProps, type SuiteTab } from './SuiteBar';
import { StatusDialog } from './StatusDialog';
import { AWAY_STATUS, isAway, statusPatch, STATUS_OPTIONS } from './status';
import { APP_MANIFESTS } from '@flow/shared/manifests';
import { suiteTabsFrom } from './tabs';

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
      { id: 'docs', label: 'Docs', href: '/docs', onSelect: calls.docs },
      { id: 'chat', label: 'Chat', href: '/chat', active: true, badge: 3, onSelect: calls.chat },
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

  it('opens another app in its own browser tab, and names this tab for its app', () => {
    setup({
      tabs: [
        { id: 'home', label: 'Home', href: '/home/', active: true },
        { id: 'mail', label: 'Mail', href: '/mail/' },
      ],
    });
    expect(screen.getByTestId('suite-tab-mail').getAttribute('target')).toBe('freeflow-mail');
    expect(screen.getByTestId('suite-tab-home').getAttribute('target')).toBeNull();
    expect(window.name).toBe('freeflow-home');
  });

  it("the logo goes to the app's home", () => {
    const home = vi.fn();
    setup({ home: { href: '/docs/', onSelect: home } });
    const link = screen.getByTestId('suite-home');
    expect(link.getAttribute('href')).toBe('/docs/');
    fireEvent.click(link);
    expect(home).toHaveBeenCalledTimes(1);
    // A click for a new tab is the browser's.
    fireEvent.click(link, { metaKey: true });
    expect(home).toHaveBeenCalledTimes(1);
  });

  it("without a home, the logo is the active tab's link", () => {
    setup();
    expect(screen.getByTestId('suite-home').getAttribute('href')).toBe('/chat');
  });

  it('draws no badge for nothing unread', () => {
    setup({ tabs: [{ id: 'chat', label: 'Chat', href: '/chat', active: true, badge: 0 }] });
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

  it('offers the booking page in the account menu: copy its link when it is on, create it when it is not, nothing without Calendar', async () => {
    const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    vi.stubGlobal('fetch', answer(200, { url: 'https://app.test/calendar/book/k7mq-x3vd-p9tr', page: { enabled: true } }));
    setup();
    fireEvent.click(screen.getByTestId('suite-account-button'));
    const copy = await screen.findByTestId('suite-booking-copy');
    expect(String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toMatch(/^\/v1\/calendar\/scheduler\?/);
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith('https://app.test/calendar/book/k7mq-x3vd-p9tr');
    expect(screen.getByTestId('suite-booking-copy').textContent).toContain('Link copied');
    cleanup();

    vi.stubGlobal('fetch', answer(200, { url: null, page: { enabled: false } }));
    setup();
    fireEvent.click(screen.getByTestId('suite-account-button'));
    expect((await screen.findByTestId('suite-booking-create')).textContent).toContain('Create booking page');
    expect(screen.queryByTestId('suite-booking-copy')).toBeNull();
    cleanup();

    // A guest account (no calendar) or a host without Calendar: no row.
    vi.stubGlobal('fetch', answer(403, { error: { code: 'no_account' } }));
    setup();
    fireEvent.click(screen.getByTestId('suite-account-button'));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('suite-booking-copy')).toBeNull();
    expect(screen.queryByTestId('suite-booking-create')).toBeNull();
    vi.unstubAllGlobals();
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

// The tabs each app's bar drew by hand before the manifests (phase 6.1): the same, from APP_MANIFESTS.
describe('suiteTabsFrom', () => {
  const home = () => {};

  /** The four apps' tabs as they were before Home's came first, without the ⌘ digit each now carries. */
  const fourApps = (tabs: SuiteTab[]) => tabs.filter((t) => t.id !== 'home').slice(0, 4).map(({ shortcut: _, ...t }) => t);

  it('puts Home first, with no ⌘ digit, and keeps ⌘1–⌘4 on Docs, Chat, Mail and Calendar', () => {
    const tabs = suiteTabsFrom(APP_MANIFESTS, 'home', {}, { activeHref: '/home/' });
    expect(tabs[0]).toMatchObject({ id: 'home', label: 'Home', href: '/home/', active: true });
    render(<SuiteBar {...setupProps({ tabs })} />);
    expect(screen.getByTestId('suite-tab-home').getAttribute('title')).toBe('Home');
    expect(screen.getByTestId('suite-tab-docs').getAttribute('title')).toBe('Docs (⌘1)');
    expect(screen.getByTestId('suite-tab-calendar').getAttribute('title')).toBe('Calendar (⌘4)');
  });

  it("draws Chat's bar as it was, and its tabs off for an organization on another server", () => {
    expect(fourApps(suiteTabsFrom(APP_MANIFESTS, 'chat', { 'chat-unread': 5 }))).toEqual([
      { id: 'docs', label: 'Docs', href: '/docs' },
      { id: 'chat', label: 'Chat', href: '/chat', active: true, badge: 5 },
      { id: 'mail', label: 'Mail', href: '/mail' },
      { id: 'calendar', label: 'Calendar', href: '/calendar' },
    ]);
    const away = suiteTabsFrom(APP_MANIFESTS, 'chat', { 'chat-unread': 0 }, { unavailable: (t) => `${t.label} is not available for an organization on another server yet` });
    expect(fourApps(away).map((t) => [t.id, !!t.disabled, t.title])).toEqual([
      ['docs', true, 'Docs is not available for an organization on another server yet'],
      ['chat', false, undefined],
      ['mail', true, 'Mail is not available for an organization on another server yet'],
      ['calendar', true, 'Calendar is not available for an organization on another server yet'],
    ]);
  });

  it("draws Docs', Mail's and Calendar's bars as they were", () => {
    expect(fourApps(suiteTabsFrom(APP_MANIFESTS, 'docs', { 'chat-unread': 2 }, { activeHref: '/docs/', onSelect: home }))).toEqual([
      { id: 'docs', label: 'Docs', href: '/docs/', active: true, onSelect: home },
      { id: 'chat', label: 'Chat', href: '/chat', badge: 2 },
      { id: 'mail', label: 'Mail', href: '/mail' },
      { id: 'calendar', label: 'Calendar', href: '/calendar' },
    ]);
    expect(fourApps(suiteTabsFrom(APP_MANIFESTS, 'mail', { 'chat-unread': 2, 'mail-unread': 7 }, { activeHref: '/mail/', onSelect: home }))).toEqual([
      { id: 'docs', label: 'Docs', href: '/docs' },
      { id: 'chat', label: 'Chat', href: '/chat', badge: 2 },
      { id: 'mail', label: 'Mail', href: '/mail/', active: true, badge: 7, onSelect: home },
      { id: 'calendar', label: 'Calendar', href: '/calendar' },
    ]);
    expect(fourApps(suiteTabsFrom(APP_MANIFESTS, 'calendar', { 'chat-unread': 0 }, { activeHref: '/calendar/', onSelect: home }))).toEqual([
      { id: 'docs', label: 'Docs', href: '/docs' },
      { id: 'chat', label: 'Chat', href: '/chat', badge: 0 },
      { id: 'mail', label: 'Mail', href: '/mail' },
      { id: 'calendar', label: 'Calendar', href: '/calendar/', active: true, onSelect: home },
    ]);
  });

  it('orders the tabs by shortcut, whatever the manifests\' order, and leaves out an app without a tab', () => {
    const tabs = suiteTabsFrom([...APP_MANIFESTS].reverse(), 'docs');
    const withTabs = APP_MANIFESTS.filter((m) => m.tab).sort((a, b) => a.tab!.shortcut.localeCompare(b.tab!.shortcut));
    expect(tabs.map((t) => t.id)).toEqual(withTabs.map((m) => m.name));
    expect(tabs.slice(0, 5).map((t) => t.id)).toEqual(['home', 'docs', 'chat', 'mail', 'calendar']);
    render(<SuiteBar {...setupProps({ tabs })} />);
    const links = screen.getAllByRole('link').filter((a) => a.classList.contains('sb-tab'));
    expect(links.slice(0, 5).map((a) => [a.textContent, a.getAttribute('title')])).toEqual([
      ['Home', 'Home'],
      ['Docs', 'Docs (⌘1)'],
      ['Chat', 'Chat (⌘2)'],
      ['Mail', 'Mail (⌘3)'],
      ['Calendar', 'Calendar (⌘4)'],
    ]);
    expect(links.map((a) => a.getAttribute('title'))).toEqual(withTabs.map((m) => (/^[1-9]$/.test(m.tab!.shortcut) ? `${m.tab!.label} (⌘${m.tab!.shortcut})` : m.tab!.label)));
  });

  it('gives every bar every app’s tab, and an app without one (Contacts, reached from Mail) no tab anywhere', () => {
    const withTabs = APP_MANIFESTS.filter((m) => m.tab);
    expect(withTabs.map((m) => m.name)).toEqual(['chat', 'docs', 'mail', 'calendar', 'home']);
    for (const bar of withTabs) {
      const tabs = suiteTabsFrom(APP_MANIFESTS, bar.name);
      expect(tabs.map((t) => t.id).sort()).toEqual(withTabs.map((m) => m.name).sort());
      expect(tabs.filter((t) => t.active).map((t) => t.id)).toEqual([bar.name]);
    }
    // The bar of an app without a tab shows the others, none active.
    expect(suiteTabsFrom(APP_MANIFESTS, 'contacts').filter((t) => t.active)).toEqual([]);
  });
});
