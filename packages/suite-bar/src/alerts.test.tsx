import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callLinkOf, isMyMeeting, meetingAlertsAt, SuiteAlerts, startsLine, type AlertEvent } from './alerts';
import { SuiteBar } from './SuiteBar';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
beforeEach(() => localStorage.clear());

const T0 = Date.parse('2026-11-19T15:00:00Z');
const min = 60_000;
const event = (over: Partial<AlertEvent> = {}): AlertEvent => ({
  id: 'cal1:abc', summary: 'Design review', location: null, description: null,
  start: new Date(T0).toISOString(), end: new Date(T0 + 30 * min).toISOString(), allDay: false, status: 'confirmed',
  organizer: null, attendees: [{ self: true }, {}], myResponse: 'accepted', ...over,
});

describe('meeting alerts (task 12)', () => {
  it('shows an accepted meeting from 2 minutes before its start until 5 minutes after', () => {
    const at = (offset: number) => meetingAlertsAt([event()], T0 + offset, new Set()).length;
    expect(at(-2 * min - 1)).toBe(0);
    expect(at(-2 * min)).toBe(1);
    expect(at(0)).toBe(1);
    expect(at(5 * min - 1)).toBe(1);
    expect(at(5 * min)).toBe(0);
  });

  it('for every timed event the person has not declined', () => {
    expect(isMyMeeting(event())).toBe(true);
    expect(isMyMeeting(event({ myResponse: 'needs-action' }))).toBe(true);
    expect(isMyMeeting(event({ myResponse: 'tentative' }))).toBe(true);
    // An event of the person's own, with no guests and no call.
    expect(isMyMeeting(event({ myResponse: undefined, organizer: null, attendees: [] }))).toBe(true);
    expect(isMyMeeting(event({ myResponse: 'declined' }))).toBe(false);
    expect(isMyMeeting(event({ allDay: true }))).toBe(false);
    expect(isMyMeeting(event({ status: 'cancelled' }))).toBe(false);
  });

  it('has a Join link for its call, and Open in Calendar', () => {
    const [a] = meetingAlertsAt([event({ conference: { url: 'https://zoom.us/j/123', label: 'Zoom' } })], T0 - min, new Set());
    expect(a).toMatchObject({ id: 'meeting:cal1:abc', kind: 'Meeting', title: 'Design review' });
    expect(a!.lines[0]).toMatch(/^Starts in 1 min · /);
    expect(a!.actions).toEqual([{ label: 'Join', href: 'https://zoom.us/j/123', primary: true }, { label: 'Open in Calendar', href: '/calendar/?event=cal1%3Aabc' }]);
    expect(callLinkOf({ description: 'Join with FreeFlow Meet: https://app.freeflow.im/meet/abc-defg-hij', location: null })).toBe('https://app.freeflow.im/meet/abc-defg-hij');
    expect(callLinkOf({ description: null, location: 'Room 4' })).toBeNull();
    const [room] = meetingAlertsAt([event({ location: 'Room 4' })], T0, new Set());
    expect(room!.lines).toEqual([expect.stringMatching(/^Starting now/), 'Room 4']);
    expect(room!.actions.map((x) => x.label)).toEqual(['Open in Calendar']);
  });

  it('leaves out a closed one, and the same meeting in two calendars shows once', () => {
    expect(meetingAlertsAt([event()], T0, new Set(['meeting:cal1:abc']))).toEqual([]);
    expect(meetingAlertsAt([event(), event({ id: 'cal2:abc' })], T0, new Set())).toHaveLength(1);
    expect(startsLine(T0, T0 + 3 * min)).toBe('Started 3 min ago');
  });
});

describe('the alerts under the suite bar', () => {
  const account = { name: 'Ann Lee', email: 'ann@x.test', onProfile() {}, onSettings() {}, onLogout() {} };
  const organization = { name: 'Acme', entries: [{ id: 'org1', name: 'Acme', unread: 0, active: true }], onSelect() {}, onAdd() {} };

  it('reads the calendar of the organization the bar shows, slides the meeting down, and closes it on ×', async () => {
    vi.useFakeTimers({ now: T0 - min, toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(url.startsWith('/v1/calendar/events') ? { events: [event({ location: 'https://meet.google.com/abc-defg-hij' })] } : {}), { status: 200 });
    }));
    render(<SuiteBar tabs={[]} organization={organization} account={account} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(asked.some((u) => u.startsWith('/v1/calendar/events?') && u.includes('workspace=org1'))).toBe(true);
    const card = screen.getByTestId('suite-alert');
    expect(card.textContent).toContain('Design review');
    expect(screen.getByRole('link', { name: 'Join' }).getAttribute('href')).toBe('https://meet.google.com/abc-defg-hij');
    expect(screen.getByRole('link', { name: 'Join' }).getAttribute('target')).toBe('_blank');
    fireEvent.click(screen.getByRole('button', { name: 'Close alert' }));
    expect(screen.queryByTestId('suite-alert')).toBeNull();
    expect(JSON.parse(localStorage.getItem('suite-alerts-closed') ?? '{}')).toHaveProperty(['meeting:cal1:abc']);
  });

  it('ends on its own five minutes after the start', async () => {
    vi.useFakeTimers({ now: T0 + 4 * min, toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ events: [event()] }), { status: 200 })));
    render(<SuiteBar tabs={[]} organization={organization} account={account} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByTestId('suite-alert')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(min + 15_000); });
    expect(screen.queryByTestId('suite-alert')).toBeNull();
  });

  it('takes other alerts from the page, and none at all when there are none', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const { rerender } = render(<SuiteAlerts alerts={[]} onClose={() => {}} />);
    expect(screen.queryByTestId('suite-alerts')).toBeNull();
    rerender(<SuiteAlerts alerts={[{ id: 'x', kind: 'Reminder', title: 'Send the report', lines: [], actions: [] }]} onClose={() => {}} />);
    expect(screen.getByTestId('suite-alert').textContent).toContain('Send the report');
  });
});

describe('the cards’ motion', () => {
  const card = (id: string, title: string) => ({ id, kind: 'Reminder', title, lines: [], actions: [] });
  const motion = (reduce: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }));

  it('slides a closed card up and out, in its place, before it goes', () => {
    vi.useFakeTimers();
    motion(false);
    const { rerender } = render(<SuiteAlerts alerts={[card('a', 'First'), card('b', 'Second')]} onClose={() => {}} />);
    rerender(<SuiteAlerts alerts={[card('b', 'Second')]} onClose={() => {}} />);
    const leaving = screen.getByTestId('suite-alert-leaving');
    expect(leaving.className).toContain('sb-alert-leaving');
    expect(leaving.textContent).toContain('First');
    // Still first in the stack while it slides out.
    expect(screen.getByTestId('suite-alerts').firstElementChild).toBe(leaving);
    // Gone once its slide is done (the browser's animationend; jsdom runs none, so the time limit stands in).
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.queryByTestId('suite-alert-leaving')).toBeNull();
    expect(screen.getAllByTestId('suite-alert')).toHaveLength(1);
  });

  it('goes anyway when no animation ends (a tab in the background), and at once for less motion', () => {
    vi.useFakeTimers();
    motion(false);
    const { rerender } = render(<SuiteAlerts alerts={[card('a', 'First')]} onClose={() => {}} />);
    rerender(<SuiteAlerts alerts={[]} onClose={() => {}} />);
    expect(screen.getByTestId('suite-alert-leaving')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.queryByTestId('suite-alerts')).toBeNull();
    cleanup();
    motion(true);
    const again = render(<SuiteAlerts alerts={[card('a', 'First')]} onClose={() => {}} />);
    again.rerender(<SuiteAlerts alerts={[]} onClose={() => {}} />);
    expect(screen.queryByTestId('suite-alerts')).toBeNull();
  });
});
