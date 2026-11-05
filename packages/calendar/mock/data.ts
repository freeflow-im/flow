// Sample calendars for `dev:mock` (mock/plugin.ts): an iCloud account with Personal, Work and a read-only Holidays
// calendar, and a Fastmail one, with events around today: repeating meetings (one occurrence moved, one skipped), an
// invitation not answered yet, a video call, all-day and multi-day events. Times are local, as the views are.
import type { Attendee, CalendarAccount, CalendarInfo } from '../src/api';

export interface MockRule { freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'; interval: number; byday: number[]; count?: number; until?: number }
export interface MockEvent {
  uid: string; calendarId: string; summary: string; location: string | null; description: string | null;
  start: number; durationMs: number; allDay: boolean; timezone: string | null;
  rule: MockRule | null; exdates: Set<number>; overrides: Map<number, Partial<Pick<MockEvent, 'summary' | 'location' | 'description'>> & { start: number; durationMs: number }>;
  organizer: Attendee | null; attendees: Attendee[]; myResponse?: Attendee['response']; conference?: { url: string; label: string }; reminders: number[]; etag: number;
}
export interface MockState { accounts: CalendarAccount[]; calendars: CalendarInfo[]; events: MockEvent[] }

const ME = 'ann@icloud.com';
const day = (offset: number, h = 0, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); d.setDate(d.getDate() + offset); return +d; };
const date = (offset: number) => day(offset);
const HOUR = 3_600_000;
const monday = () => { const d = new Date(); return -((d.getDay() + 6) % 7); };

export function sampleState(): MockState {
  const now = new Date().toISOString();
  const accounts: CalendarAccount[] = [
    { id: 'icloud', kind: 'caldav', email: ME, displayName: 'Ann Lee', server: { url: 'https://caldav.icloud.com/', username: ME }, status: 'ok' },
    { id: 'fastmail', kind: 'caldav', email: 'ann@fastmail.com', displayName: 'Ann (side project)', server: { url: 'https://caldav.fastmail.com/', username: 'ann@fastmail.com' }, status: 'ok' },
  ];
  const calendars: CalendarInfo[] = [
    { id: 'personal', accountId: 'icloud', name: 'Personal', color: '#039be5', timezone: null, role: 'owner', hidden: false, isDefault: true, syncedAt: now },
    { id: 'work', accountId: 'icloud', name: 'Work', color: '#f4511e', timezone: null, role: 'owner', hidden: false, isDefault: false, syncedAt: now },
    { id: 'holidays', accountId: 'icloud', name: 'US Holidays', color: '#0b8043', timezone: null, role: 'reader', hidden: false, isDefault: false, syncedAt: now },
    { id: 'side', accountId: 'fastmail', name: 'Side project', color: '#8e24aa', timezone: null, role: 'owner', hidden: false, isDefault: false, syncedAt: now },
  ];
  const bo: Attendee = { name: 'Bo Chen', email: 'bo@acme.test', role: 'required', response: 'accepted' };
  const me = (response: Attendee['response']): Attendee => ({ name: 'Ann Lee', email: ME, role: 'required', response, self: true });
  const ev = (o: Partial<MockEvent> & Pick<MockEvent, 'uid' | 'calendarId' | 'summary' | 'start' | 'durationMs'>): MockEvent => ({
    location: null, description: null, allDay: false, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, rule: null, exdates: new Set(), overrides: new Map(), organizer: null, attendees: [], reminders: [10], etag: 1, ...o,
  });
  const mon = monday();
  const standup = ev({ uid: 'standup', calendarId: 'work', summary: 'Standup', start: day(mon - 14, 9, 30), durationMs: HOUR / 4, rule: { freq: 'WEEKLY', interval: 1, byday: [1, 3, 5] }, location: 'https://meet.google.com/abc-defg-hij', conference: { url: 'https://meet.google.com/abc-defg-hij', label: 'Google Meet' }, organizer: bo, attendees: [bo, me('accepted')], myResponse: 'accepted' });
  standup.exdates.add(day(mon + 2, 9, 30));
  standup.overrides.set(day(mon + 4, 9, 30), { start: day(mon + 4, 11), durationMs: HOUR / 4, summary: 'Standup (late, after the review)' });
  const events: MockEvent[] = [
    standup,
    ev({ uid: 'one-on-one', calendarId: 'work', summary: '1:1 with Bo', start: day(mon - 7 + 1, 14), durationMs: HOUR / 2, rule: { freq: 'WEEKLY', interval: 1, byday: [2] }, organizer: { ...me('accepted'), role: 'required' }, attendees: [me('accepted'), bo] }),
    ev({ uid: 'planning', calendarId: 'work', summary: 'Q1 planning', start: day(mon + 3, 10), durationMs: 90 * 60_000, location: 'Room 4B', description: 'Agenda:\n1. What shipped\n2. What is next\n3. Hiring', conference: { url: 'https://acme.zoom.us/j/123456789', label: 'Zoom' }, organizer: bo, attendees: [bo, me('needs-action'), { name: 'Cy Diaz', email: 'cy@acme.test', role: 'optional', response: 'tentative' }], myResponse: 'needs-action' }),
    ev({ uid: 'offsite', calendarId: 'work', summary: 'Team offsite', start: date(mon + 8), durationMs: 2 * 24 * HOUR, allDay: true, timezone: null, location: 'Lake Placid', reminders: [] }),
    ev({ uid: 'stakeholder', calendarId: 'work', summary: 'Stakeholder Sync', start: day(mon + 3, 10), durationMs: HOUR, rule: { freq: 'WEEKLY', interval: 2, byday: [4] }, reminders: [10],
      conference: { url: 'https://meet.google.com/gvq-yykt-idt', label: 'Google Meet' }, organizer: { name: 'Raeven Moon', email: 'raeven@acme.test', role: 'required', response: 'accepted' }, myResponse: 'needs-action',
      description: ['Monthly read-out for the pilot partners: where we are, what is blocked, what we need from you. Notes: https://docs.example.com/stakeholders', '',
        '-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-', 'Join with Google Meet: https://meet.google.com/gvq-yykt-idt', 'Or dial: (US) +1 413-752-4874 PIN: 522324683#',
        'More phone numbers: https://tel.meet/gvq-yykt-idt?pin=3144435762968&hs=7', '', 'Learn more about Meet at: https://support.google.com/a/users/answer/9282720', '', 'Please do not edit this section.',
        '-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-'].join('\n'),
      attendees: [
        { name: 'Raeven Moon', email: 'raeven@acme.test', role: 'required', response: 'accepted' }, me('needs-action'), bo,
        { name: 'Jennifer Steinke', email: 'jennifer.steinke@modernatx.test', role: 'required', response: 'accepted' },
        { name: null, email: 'jsteinke0868@gmail.com', role: 'required', response: 'needs-action' },
        { name: null, email: 'valerielayman@gmail.com', role: 'required', response: 'needs-action' },
        { name: 'Cy Diaz', email: 'cy@acme.test', role: 'optional', response: 'declined' },
        { name: 'Dee Park', email: 'dee@acme.test', role: 'required', response: 'accepted' },
        { name: 'Eli Ross', email: 'eli@acme.test', role: 'required', response: 'needs-action' },
        { name: 'Fay Wu', email: 'fay@acme.test', role: 'required', response: 'declined' },
        { name: 'Michael Cain', email: 'michaelc@caintravel.test', role: 'required', response: 'accepted' },
      ] }),
    ev({ uid: 'dentist', calendarId: 'personal', summary: 'Dentist', start: day(1, 8, 30), durationMs: HOUR, location: '120 Main St' }),
    ev({ uid: 'gym', calendarId: 'personal', summary: 'Gym', start: day(mon - 21, 7), durationMs: HOUR, rule: { freq: 'WEEKLY', interval: 1, byday: [1, 3, 5] }, reminders: [] }),
    ev({ uid: 'lunch', calendarId: 'personal', summary: 'Lunch with Priya', start: day(2, 12, 30), durationMs: HOUR, organizer: { name: 'Priya Shah', email: 'priya@example.com', role: 'required', response: 'accepted' }, attendees: [{ name: 'Priya Shah', email: 'priya@example.com', role: 'required', response: 'accepted' }, me('needs-action')], myResponse: 'needs-action' }),
    ev({ uid: 'birthday', calendarId: 'personal', summary: "Mum's birthday", start: date(5), durationMs: 24 * HOUR, allDay: true, timezone: null, rule: { freq: 'YEARLY', interval: 1, byday: [] }, reminders: [1440] }),
    ev({ uid: 'thanksgiving', calendarId: 'holidays', summary: 'Thanksgiving Day', start: date(22), durationMs: 24 * HOUR, allDay: true, timezone: null, reminders: [] }),
    ev({ uid: 'release', calendarId: 'side', summary: 'Ship v0.3', start: day(4, 16), durationMs: HOUR, description: 'Tag, build, write the notes.' }),
    ev({ uid: 'late', calendarId: 'side', summary: 'Server move', start: day(0, 22), durationMs: 3 * HOUR }),
  ];
  return { accounts, calendars, events };
}
