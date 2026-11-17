import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChannelDTO, MeetingChatDTO, WorkspaceMemberDTO } from '@flow/shared';
import { MobileNavContext } from '../state';
import { meetingChatOf, meetingMentions } from '../hooks';
import { MeetingsList, meetingDay, peopleLine } from './MeetingsView';

const chat = (code: string, over: Partial<MeetingChatDTO> = {}, mentions = 0): MeetingChatDTO => ({
  channel: {
    id: `ch-${code}`, workspaceId: 'w1', name: null, kind: 'meeting', topic: null, isPrivate: true, createdBy: 'u1', createdAt: '2026-11-01T00:00:00.000Z',
    archivedAt: null, isMember: true, lastReadMsgId: null, unreadCount: 0, unreadNotifications: mentions, meeting: { code, title: `Room ${code}` },
  } as ChannelDTO,
  meeting: { id: `m-${code}`, code, workspaceId: 'w1', title: `Room ${code}`, createdBy: 'u1', createdAt: '2026-11-01T00:00:00.000Z', channelId: null, locked: false, chatChannelId: `ch-${code}` },
  peopleIds: ['u1', 'u2'],
  lastSessionAt: '2026-11-10T15:00:00.000Z',
  lastMessageAt: '2026-11-10T15:20:00.000Z',
  live: false,
  livePeople: [],
  ...over,
});

const member = (userId: string, displayName: string) => ({ userId, displayName, avatarUrl: null }) as WorkspaceMemberDTO;

describe('Meetings in Chat', () => {
  it('dates a meeting by its last session', () => {
    const now = new Date('2026-11-16T12:00:00');
    expect(meetingDay(chat('a', { lastSessionAt: '2026-11-16T09:00:00' }), now)).toBe('Today');
    expect(meetingDay(chat('a', { lastSessionAt: '2026-11-15T09:00:00' }), now)).toBe('Yesterday');
    expect(meetingDay(chat('a', { lastSessionAt: '2026-11-10T09:00:00' }), now)).toMatch(/10/);
    expect(meetingDay(chat('a', { lastSessionAt: null, lastMessageAt: null }), now)).toMatch(/1/);
  });

  it('names who was in it, you last', () => {
    const names = { u1: 'Ann', u2: 'Bob', u3: 'Cy', u4: 'Di' };
    expect(peopleLine(['u1', 'me'], names, 'me')).toBe('Ann and you');
    expect(peopleLine(['u1', 'u2', 'u3'], names, 'me')).toBe('Ann, Bob and Cy');
    expect(peopleLine(['u1', 'u2', 'u3', 'u4', 'me'], names, 'me')).toBe('Ann, Bob and 3 others');
    expect(peopleLine(['me'], names, 'me')).toBe('you');
  });

  it('badges only the mentions, and finds a meeting chat by its channel', () => {
    const chats = [chat('a', {}, 2), chat('b'), chat('c', {}, 1)];
    expect(meetingMentions(chats)).toBe(3);
    expect(meetingMentions(undefined)).toBe(0);
    expect(meetingChatOf(chats, 'ch-b')?.meeting.code).toBe('b');
    expect(meetingChatOf(chats, 'nope')).toBeUndefined();
  });

  it('lists live meetings with Join, and each with its mentions', () => {
    const html = renderToStaticMarkup(
      <MobileNavContext.Provider value={{ isMobile: false, drawerOpen: false, openDrawer: () => {}, closeDrawer: () => {} }}>
        <MeetingsList
          chats={[chat('liv-eeee-now', { live: true, livePeople: [{ userId: 'u1', name: 'Ann' }] }), chat('old-mmmm-tng', {}, 2)]}
          loading={false}
          members={[member('u1', 'Ann'), member('u2', 'Bob')]}
          me="u2"
          roomUrl={(code) => `/meet/${code}`}
          onOpen={() => {}}
        />
      </MobileNavContext.Provider>,
    );
    expect(html).toContain('data-testid="meeting-join-liv-eeee-now" href="/meet/liv-eeee-now"');
    expect(html).not.toContain('meeting-join-old-mmmm-tng');
    expect(html).toContain('Room liv-eeee-now');
    expect(html).toContain('1 in it now');
    expect(html).toMatch(/data-testid="meeting-mentions"[^>]*>2</);
    expect(html).toContain('Ann and you');
  });

  it('says so when there are none', () => {
    const html = renderToStaticMarkup(
      <MobileNavContext.Provider value={{ isMobile: false, drawerOpen: false, openDrawer: () => {}, closeDrawer: () => {} }}>
        <MeetingsList chats={[]} loading={false} members={[]} me="u1" roomUrl={(c) => c} onOpen={() => {}} />
      </MobileNavContext.Provider>,
    );
    expect(html).toContain('data-testid="meetings-empty"');
  });
});
