import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertEvent, SuiteAlert } from './alerts';
import { claimNotification, useAlertNotifications, type DesktopPermission } from './desktopNotify';
import { SuiteBar } from './SuiteBar';

/** A stand-in for the browser's Notification: records every banner, its permission set per test. */
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static made: FakeNotification[] = [];
  static requestPermission = vi.fn(async () => { FakeNotification.permission = 'granted'; return 'granted' as NotificationPermission; });
  onclick: (() => void) | null = null;
  closed = false;
  title: string;
  options: NotificationOptions;
  constructor(title: string, options: NotificationOptions) { this.title = title; this.options = options; FakeNotification.made.push(this); }
  close() { this.closed = true; }
}

beforeEach(() => {
  localStorage.clear();
  FakeNotification.permission = 'granted';
  FakeNotification.made = [];
  FakeNotification.requestPermission.mockClear();
  vi.stubGlobal('Notification', FakeNotification);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const meeting = (over: Partial<SuiteAlert> = {}): SuiteAlert => ({
  id: 'meeting:cal1:abc', kind: 'Meeting', title: 'Design review', lines: ['Starts in 2 min · 3:00 PM – 3:30 PM'],
  actions: [{ label: 'Join', href: 'https://meet.google.com/abc-defg-hij', primary: true }, { label: 'Open in Calendar', href: '/calendar/?event=x' }],
  ...over,
});

/** One "tab": the hook on its own, with the alerts and permission it is given. */
function Tab({ alerts, permission = 'granted' }: { alerts: SuiteAlert[]; permission?: DesktopPermission }) {
  useAlertNotifications(alerts, permission);
  return null;
}

describe('desktop notifications for alerts (task 15)', () => {
  it('claims an alert once across tabs', async () => {
    expect(await claimNotification('meeting:a')).toBe(true);
    expect(await claimNotification('meeting:a')).toBe(false);
    expect(await claimNotification('meeting:b')).toBe(true);
  });

  it('raises one banner per alert however many tabs show it, and only once per tab', async () => {
    const alerts = [meeting()];
    const one = render(<Tab alerts={alerts} />);
    render(<Tab alerts={alerts} />);
    await flush();
    one.rerender(<Tab alerts={[...alerts]} />);
    await flush();
    expect(FakeNotification.made).toHaveLength(1);
    const [banner] = FakeNotification.made;
    expect(banner!.title).toBe('Design review');
    expect(banner!.options).toMatchObject({ tag: 'meeting:cal1:abc', body: 'Meeting\nStarts in 2 min · 3:00 PM – 3:30 PM' });
  });

  it('opens the Join link and focuses the tab on click', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    render(<Tab alerts={[meeting()]} />);
    await flush();
    FakeNotification.made[0]!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('https://meet.google.com/abc-defg-hij', '_blank', 'noopener');
    expect(FakeNotification.made[0]!.closed).toBe(true);
  });

  it('only focuses the tab when the meeting has no call', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    render(<Tab alerts={[meeting({ actions: [{ label: 'Open in Calendar', href: '/calendar/?event=x' }] })]} />);
    await flush();
    FakeNotification.made[0]!.onclick!();
    expect(open).not.toHaveBeenCalled();
  });

  it('shows nothing without permission, and later once it is granted', async () => {
    const { rerender } = render(<Tab alerts={[meeting()]} permission="default" />);
    await flush();
    expect(FakeNotification.made).toHaveLength(0);
    // Not claimed while it could not show: granting it in the alert's time still notifies.
    expect(localStorage.getItem('suite-alerts-notified')).toBeNull();
    rerender(<Tab alerts={[meeting()]} permission="granted" />);
    await flush();
    expect(FakeNotification.made).toHaveLength(1);
  });

  it('takes the banner down when its alert goes', async () => {
    const { rerender } = render(<Tab alerts={[meeting()]} />);
    await flush();
    rerender(<Tab alerts={[]} />);
    expect(FakeNotification.made[0]!.closed).toBe(true);
  });
});

describe('asking for permission in the suite bar', () => {
  const account = { name: 'Ann Lee', email: 'ann@x.test', onProfile() {}, onSettings() {}, onLogout() {} };
  const organization = { name: 'Acme', entries: [{ id: 'org1', name: 'Acme', unread: 0, active: true }], onSelect() {}, onAdd() {} };
  const T0 = Date.parse('2026-11-19T15:00:00Z');
  const event: AlertEvent = {
    id: 'cal1:abc', summary: 'Design review', location: null, description: null, start: new Date(T0).toISOString(),
    end: new Date(T0 + 30 * 60_000).toISOString(), allDay: false, status: 'confirmed', organizer: null, attendees: [{ self: true }, {}], myResponse: 'accepted',
  };

  it('never asks on load; the account menu and the meeting card ask on a click, then the meeting notifies', async () => {
    FakeNotification.permission = 'default';
    vi.useFakeTimers({ now: T0 - 60_000, toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ events: [event] }), { status: 200 })));
    render(<SuiteBar tabs={[]} organization={organization} account={account} />);
    await flush();
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(FakeNotification.made).toHaveLength(0);

    fireEvent.click(screen.getByTestId('suite-account-button'));
    expect(screen.getByTestId('suite-desktop-notifications').textContent).toContain('Turn on desktop notifications');
    fireEvent.click(screen.getByTestId('suite-account-button'));

    fireEvent.click(screen.getByTestId('suite-alert-desktop'));
    await flush();
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(FakeNotification.made).toHaveLength(1);
    // Granted: the offers are gone.
    expect(screen.queryByTestId('suite-alert-desktop')).toBeNull();
    fireEvent.click(screen.getByTestId('suite-account-button'));
    expect(screen.queryByTestId('suite-desktop-notifications')).toBeNull();
  });

  it('offers nothing where the browser has no notifications', async () => {
    vi.stubGlobal('Notification', undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    render(<SuiteBar tabs={[]} organization={organization} account={account} />);
    fireEvent.click(screen.getByTestId('suite-account-button'));
    expect(screen.queryByTestId('suite-desktop-notifications')).toBeNull();
  });
});
