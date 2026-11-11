import { describe, expect, it } from 'vitest';
import type { ChannelDTO, WorkspaceMemberDTO } from '@flow/shared';
import type { CalendarEvent } from '../api';
import { agentsOf, chatUnread, dmWith, fileAddress, greeting, inboxOf, messageLine, sidebarChannels, summaryLine, threadAddress, todayRange, todaysEvents } from './home';

const ME = '00000000-0000-4000-8000-000000000001';
const AGENT = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';

const channel = (over: Partial<ChannelDTO>): ChannelDTO => ({
  id: over.id ?? 'c',
  workspaceId: 'w',
  name: 'general',
  kind: 'standard',
  topic: null,
  isPrivate: false,
  createdBy: ME,
  createdAt: '2026-11-01T00:00:00Z',
  archivedAt: null,
  isMember: true,
  lastReadMsgId: null,
  unreadCount: 0,
  unreadNotifications: 0,
  unreadThreadRootIds: [],
  notifyLevel: 'mentions',
  parentId: null,
  ...over,
}) as ChannelDTO;

const member = (userId: string, displayName: string, isAgent: boolean) => ({ userId, displayName, isAgent }) as WorkspaceMemberDTO;

const event = (over: Partial<CalendarEvent>): CalendarEvent => ({ id: 'e', summary: 'x', start: '2026-11-11T09:00:00Z', end: '2026-11-11T10:00:00Z', allDay: false, status: 'confirmed', attendees: [], ...over });

describe('greeting', () => {
  it('uses the first name and the part of the day', () => {
    expect(greeting('Andy Chen', new Date(2026, 10, 11, 8))).toBe('Good morning, Andy');
    expect(greeting('Andy', new Date(2026, 10, 11, 14))).toBe('Good afternoon, Andy');
    expect(greeting('', new Date(2026, 10, 11, 20))).toBe('Good evening');
  });
});

describe('todayRange', () => {
  it('runs from this midnight to the next, in local time', () => {
    const { from, to } = todayRange(new Date(2026, 10, 11, 15, 30));
    expect(new Date(from)).toEqual(new Date(2026, 10, 11));
    expect(new Date(to)).toEqual(new Date(2026, 10, 12));
  });
});

describe('todaysEvents', () => {
  it('puts all-day events first, sorts by start and drops cancelled ones', () => {
    const list = todaysEvents([
      event({ id: 'late', start: '2026-11-11T15:00:00Z' }),
      event({ id: 'gone', status: 'cancelled' }),
      event({ id: 'early', start: '2026-11-11T08:00:00Z' }),
      event({ id: 'day', allDay: true, start: '2026-11-11' }),
    ]);
    expect(list.map((e) => e.id)).toEqual(['day', 'early', 'late']);
  });
});

describe('inboxOf', () => {
  it('prefers the folder marked inbox, else INBOX by name', () => {
    expect(inboxOf([{ path: 'Sent', specialUse: 'sent', unread: 0 }, { path: 'Mail/In', specialUse: 'inbox', unread: 3 }])?.path).toBe('Mail/In');
    expect(inboxOf([{ path: 'INBOX', specialUse: null, unread: 1 }])?.path).toBe('INBOX');
    expect(inboxOf([])).toBeNull();
  });
});

describe('the sidebar', () => {
  it('lists the standard channels the person is in, the ones that need them first', () => {
    const list = sidebarChannels([
      channel({ id: 'a', name: 'alpha' }),
      channel({ id: 'z', name: 'zeta', unreadNotifications: 2 }),
      channel({ id: 'm', name: 'middle', unreadCount: 4 }),
      channel({ id: 'out', name: 'outside', isMember: false }),
      channel({ id: 'old', name: 'old', archivedAt: '2026-11-02T00:00:00Z' }),
      channel({ id: 'dm', name: null, kind: 'dm' }),
    ]);
    expect(list.map((c) => c.id)).toEqual(['z', 'm', 'a']);
  });

  it('counts Chat as its badge does: notifications in the channels the person is in', () => {
    expect(chatUnread([channel({ unreadNotifications: 2 }), channel({ kind: 'dm', unreadNotifications: 1 }), channel({ isMember: false, unreadNotifications: 9 })])).toBe(3);
  });

  it('lists the agents by name and finds the DM with one', () => {
    expect(agentsOf([member(OTHER, 'Zed', false), member(AGENT, 'Wren', true), member('a', 'Juno', true)]).map((m) => m.displayName)).toEqual(['Juno', 'Wren']);
    const dm = channel({ id: 'dm', kind: 'dm', name: null, memberIds: [ME, AGENT] });
    const group = channel({ id: 'g', kind: 'dm', name: null, memberIds: [ME, AGENT, OTHER] });
    expect(dmWith([group, dm], ME, AGENT)?.id).toBe('dm');
    expect(dmWith([group], ME, AGENT)).toBeNull();
  });
});

describe('messageLine', () => {
  it('names mentions and folds whitespace', () => {
    const names = new Map([[ME, 'Andy']]);
    expect(messageLine(`<@${ME}> can you\n\nsign off <!here>?`, names)).toBe('@Andy can you sign off @here?');
    expect(messageLine(`hi <@${OTHER}>`, names)).toBe('hi @someone');
  });
});

describe('addresses', () => {
  it('opens a file in its editor, or as a stored file', () => {
    expect(fileAddress({ id: 'd1', name: 'Plan', kind: 'doc', lastUsed: '' })).toBe('/docs/doc/d1');
    expect(fileAddress({ id: 's1', name: 'Budget', kind: 'sheet', lastUsed: '' })).toBe('/docs/s/s1');
    expect(fileAddress({ id: 'p1', name: 'Deck.pdf', kind: 'pdf', lastUsed: '' })).toBe('/docs/f/p1');
    expect(fileAddress({ name: 'local', kind: 'doc', lastUsed: '' })).toBeNull();
  });

  it('opens a conversation in Mail with its account and folder', () => {
    expect(threadAddress('acc', 'INBOX', 't 1')).toBe('/mail/?account=acc&folder=INBOX&thread=t+1');
  });
});

describe('summaryLine', () => {
  it('names only what is waiting', () => {
    const now = new Date(2026, 9, 30, 9);
    const day = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    expect(summaryLine(now, { meetings: 3, unread: 12, mentions: 1 })).toBe(`${day} · 3 meetings · 12 unread · 1 mention`);
    expect(summaryLine(now, { meetings: 0, unread: null, mentions: 0 })).toBe(day);
  });
});
