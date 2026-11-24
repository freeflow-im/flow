import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconnectNoticesOf, type AlertCalendarAccount } from './calendarAlerts';
import { SuiteBar } from './SuiteBar';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
beforeEach(() => localStorage.clear());

const acct = (over: Partial<AlertCalendarAccount> = {}): AlertCalendarAccount => ({ id: 'a1', kind: 'google', email: 'ann@gmail.com', status: 'auth_failed', ...over });

describe('reconnect labels (task 38)', () => {
  it('shows a label for each account that refuses FreeFlow, and none for one that is fine, unreachable, native or closed', () => {
    const shown = reconnectNoticesOf([acct(), acct({ id: 'a2', status: 'ok' }), acct({ id: 'a3', status: 'connect_failed' }), acct({ id: 'a4', kind: 'native' }), acct({ id: 'a5' })], new Set(['calendar-reconnect:a5']), () => {});
    expect(shown.map((a) => a.id)).toEqual(['calendar-reconnect:a1']);
    expect(shown[0]!.email).toBe('ann@gmail.com');
  });

  it('gives a Google account Reconnect, and a CalDAV account a way to Calendar', () => {
    const onReconnect = vi.fn();
    const [google, caldav] = reconnectNoticesOf([acct(), acct({ id: 'a2', kind: 'caldav', email: 'ann@icloud.com' })], new Set(), onReconnect);
    expect(google).toMatchObject({ label: 'Reconnect' });
    google!.onClick!();
    expect(onReconnect).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
    expect(caldav).toMatchObject({ label: 'Fix', href: '/calendar/' });
  });
});

describe('the reconnect label under the suite bar', () => {
  const account = { name: 'Ann Lee', email: 'ann@x.test', onProfile() {}, onSettings() {}, onLogout() {} };
  const organization = { name: 'Acme', entries: [{ id: 'org1', name: 'Acme', unread: 0, active: true }], onSelect() {}, onAdd() {} };

  it('reads the accounts, and Reconnect goes to Google’s consent page for that address, back to this page', async () => {
    const asked: string[] = [];
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, href: 'http://localhost:3000/mail/', origin: 'http://localhost:3000', assign });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      asked.push(url);
      if (url.startsWith('/v1/calendar/accounts')) return new Response(JSON.stringify({ accounts: [acct()] }), { status: 200 });
      if (url.startsWith('/v1/calendar/google/start')) return new Response(JSON.stringify({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }), { status: 200 });
      return new Response('{}', { status: 200 });
    }));
    render(<SuiteBar tabs={[]} organization={organization} account={account} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(asked.some((u) => u.startsWith('/v1/calendar/accounts?') && u.includes('workspace=org1'))).toBe(true);
    expect(screen.getByTestId('calendar-reconnect').textContent).toContain('Calendar disconnected · ann@gmail.com');
    expect(screen.queryByTestId('suite-alert')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reconnect' })); await new Promise((r) => setTimeout(r, 10)); });
    const start = new URL(asked.find((u) => u.startsWith('/v1/calendar/google/start'))!, 'http://x');
    expect(start.searchParams.get('email')).toBe('ann@gmail.com');
    expect(start.searchParams.get('return')).toBe('http://localhost:3000/mail/');
    expect(start.searchParams.get('workspace')).toBe('org1');
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1');
  });

  it('shows nothing on a page that asked for no calendar alerts', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { asked.push(url); return new Response(JSON.stringify({ accounts: [acct()] }), { status: 200 }); }));
    render(<SuiteBar tabs={[]} organization={organization} account={account} meetingAlerts={false} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(asked.some((u) => u.startsWith('/v1/calendar/accounts'))).toBe(false);
    expect(screen.queryByTestId('calendar-reconnect')).toBeNull();
  });

  it('shows nothing on Calendar’s own page, which has its own banner', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { asked.push(url); return new Response(JSON.stringify({ accounts: [acct()] }), { status: 200 }); }));
    render(<SuiteBar tabs={[{ id: 'calendar', label: 'Calendar', href: '/calendar/', active: true, onSelect() {} }]} organization={organization} account={account} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(asked.some((u) => u.startsWith('/v1/calendar/accounts'))).toBe(false);
    expect(screen.queryByTestId('calendar-reconnect')).toBeNull();
  });

  it('closes on ×, for a day, in every tab', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ accounts: [acct()] }), { status: 200 })));
    render(<SuiteBar tabs={[]} organization={organization} account={account} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('calendar-reconnect')).toBeNull();
    expect(JSON.parse(localStorage.getItem('suite-alerts-closed') ?? '{}')).toHaveProperty(['calendar-reconnect:a1']);
  });
});
