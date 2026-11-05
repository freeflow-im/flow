import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InviteAnswer, ThreadDetail, ThreadMessage } from '../api';
import { InviteCard, InviteCardView, type InviteCardViewProps } from './InviteCard';
import { ThreadView } from './ThreadView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const ann = { name: 'Ann Lee', email: 'ann@gmail.com', role: 'required' as const, response: 'accepted' as const };
const me = { name: null, email: 'scott@example.com', role: 'required' as const, response: 'needs-action' as const, self: true as const };
// Local times, so the card reads the same in any zone the tests run in.
const start = new Date(2026, 10, 5, 10, 0).toISOString(), end = new Date(2026, 10, 5, 11, 0).toISOString();
const request = (extra: Partial<InviteAnswer> = {}): InviteAnswer => ({
  action: 'request', organizerIsMe: false, onCalendar: null,
  event: { uid: 'u1', summary: 'Planning', location: 'Room 4', description: null, start, end, allDay: false, timezone: 'America/New_York', status: 'confirmed', organizer: ann, attendees: [ann, me, { ...me, email: 'bo@example.org', self: undefined } as never], myResponse: 'needs-action', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'], sequence: 0, conference: { url: 'https://meet.google.com/abc', label: 'Google Meet' } },
  calendars: [{ id: 'work', name: 'Work', color: '#3b82f6', isDefault: true }, { id: 'home', name: 'Home', color: '#10b981', isDefault: false }],
  ...extra,
});

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const view = (props: Partial<InviteCardViewProps> & { answer: InviteAnswer }) => act(() => root.render(createElement(InviteCardView, { onRespond() {}, onRemove() {}, ...props })));
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent?.trim());

describe('InviteCardView', () => {
  it('an invitation: title, when, repeat, place, call, organizer, guests, Yes · No · Maybe and the calendar to put it on', async () => {
    const answered: [string, string | undefined][] = [];
    await view({ answer: request(), onRespond: (r, c) => answered.push([r, c]) });
    const text = host.textContent ?? '';
    expect(host.querySelector('h3')?.textContent).toBe('Planning');
    expect(text).toContain('Thursday, November 5 · 10:00 – 11:00am');
    expect(text).toContain('Weekly on Thursday');
    expect(text).toContain('Room 4');
    expect(text).toContain('Join Google Meet');
    expect(text).toContain('Organizer: Ann Lee');
    expect(text).toContain('3 guests');
    expect(text).toContain('Going?');
    expect(buttons()).toEqual(['Yes', 'No', 'Maybe']);
    const select = host.querySelector('select')!;
    expect([...select.options].map((o) => o.value)).toEqual(['work', 'home']);
    await act(() => { select.value = 'home'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(() => host.querySelectorAll('button')[0]!.click());
    expect(answered).toEqual([['accepted', 'home']]);
  });

  it('on the calendar already: the answer filled in, no calendar to choose', async () => {
    await view({ answer: request({ onCalendar: { calendarId: 'work', id: 'work:u1', eventId: 'work:u1', myResponse: 'tentative', cancelled: false } }) });
    expect(host.textContent).toContain('On your calendar · Maybe');
    expect(host.querySelector('select')).toBeNull();
    expect([...host.querySelectorAll('button')].map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
  });

  it('with no calendar connected it says where to connect one', async () => {
    await view({ answer: request({ calendars: [] }) });
    expect(host.textContent).toContain('Connect a calendar to answer this invitation.');
    expect(buttons()).toEqual([]);
  });

  it('a cancellation: Remove from calendar, or Not on your calendar; a reply: who answered', async () => {
    let removed = 0;
    const cancel = request({ action: 'cancel', onCalendar: { calendarId: 'work', id: 'work:u1', eventId: 'work:u1', myResponse: 'accepted', cancelled: false } });
    await view({ answer: cancel, onRemove: () => removed++ });
    expect(host.textContent).toContain('This event was cancelled');
    await act(() => host.querySelector('button')!.click());
    expect(removed).toBe(1);
    await view({ answer: { ...cancel, onCalendar: null } });
    expect(host.textContent).toContain('Not on your calendar');
    await view({ answer: request({ action: 'reply', organizerIsMe: true, reply: { name: 'Ann Lee', email: 'ann@gmail.com', response: 'accepted' } }) });
    expect(host.textContent).toContain('Ann Lee accepted');
    expect(host.textContent).toContain('Organizer: you');
    expect(buttons()).toEqual([]);
  });
});

describe('InviteCard', () => {
  it('asks Calendar about the part, answers, updates and says so', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const answered = request({ onCalendar: { calendarId: 'work', id: 'work:u1', eventId: 'work:u1', myResponse: 'accepted', cancelled: false } });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(url.endsWith('/respond') ? { ...answered, replied: 'email' } : request()), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const notices: string[] = [];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(InviteCard, { invite: { account: 'acc', folder: 'INBOX', uid: 7, part: 1 }, onNotice: (t: string) => notices.push(t) }))));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls[0]).toEqual({ url: '/v1/calendar/invites', body: { account: 'acc', messageId: { folder: 'INBOX', uid: 7 }, part: 1 } });
    expect(host.textContent).toContain('Going?');
    await act(() => host.querySelectorAll('button')[0]!.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls[1]).toEqual({ url: '/v1/calendar/invites/respond', body: { account: 'acc', messageId: { folder: 'INBOX', uid: 7 }, part: 1, response: 'accepted', calendarId: 'work' } });
    expect(host.textContent).toContain('On your calendar · Going');
    expect(notices).toEqual(["You're going. Ann Lee was emailed your answer."]);
  });

  it('shows nothing when Calendar cannot read the part', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'bad_request', message: 'not an invitation' } }), { status: 400 })));
    const qc = new QueryClient();
    await act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(InviteCard, { invite: { account: 'acc', folder: 'INBOX', uid: 7, part: 1 }, onNotice() {} }))));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(host.querySelector('section')).toBeNull();
  });
});

describe('ThreadView with an invitation', () => {
  const msg = (uid: number, extra: Partial<ThreadMessage> = {}): ThreadMessage => ({
    uid, folder: 'INBOX', messageId: `<m${uid}@x>`, from: { name: 'Ann Lee', address: 'ann@gmail.com' }, to: [{ name: 'Scott', address: 'scott@example.com' }], cc: [{ name: 'Bo', address: 'bo@example.org' }], replyTo: [], bcc: [], subject: 'Invitation: Planning',
    snippet: '', date: '2026-11-01T10:00:00.000Z', seen: false, flagged: false, answered: false, hasAttachments: true, size: 10, inReplyTo: null, references: [], html: null, text: 'You are invited',
    attachments: [{ index: 0, filename: 'attachment-1', mimeType: 'text/calendar', size: 900, contentId: null, inline: false }, { index: 1, filename: 'invite.ics', mimeType: 'application/ics', size: 900, contentId: null, inline: false }, { index: 2, filename: 'agenda.pdf', mimeType: 'application/pdf', size: 9000, contentId: null, inline: false }],
    ...extra,
  });
  it('shows the card above the body, hides the iCalendar chips, and Create event opens Calendar with the subject and the people', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return new Response(JSON.stringify(request()), { status: 200 }); }));
    const opened: string[] = [];
    const thread: ThreadDetail = { threadId: 't', messages: [msg(1)] };
    const qc = new QueryClient();
    await act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ThreadView, {
      accountId: 'acc', me: 'scott@example.com', folder: 'INBOX', thread, loading: false, error: null, folders: [], canArchive: true,
      onReply() {}, onReplyAll() {}, onForward() {}, onArchive() {}, onMove() {}, onDelete() {}, onToggleSeen() {}, onToggleFlag() {}, onFlagMessage() {}, onNeedBody() {}, onOpenCalendar: (u: string) => opened.push(u),
    }))));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls).toEqual(['/v1/calendar/invites']);
    const card = host.querySelector('section[aria-label="Invitation"]');
    expect(card?.textContent).toContain('Planning');
    expect(host.textContent).toContain('1 attachment');
    expect(host.textContent).toContain('agenda.pdf');
    expect(host.textContent).not.toContain('invite.ics');
    // The thread's ⋮ menu (Radix opens it on pointerdown).
    const more = host.querySelector<HTMLButtonElement>('button[aria-label="More"]')!;
    await act(() => { more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes('Create event'))!;
    await act(() => item.click());
    expect(opened).toHaveLength(1);
    const url = new URL(opened[0]!, 'https://x');
    expect(url.searchParams.get('new')).toBe('Invitation: Planning');
    expect(url.searchParams.get('guests')).toBe('Ann Lee <ann@gmail.com>,Bo <bo@example.org>');
  });
});
