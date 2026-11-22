import { describe, expect, it } from 'vitest';
import { chatPathFor, parseChatPath, resolveChannelRef } from './chatPath';
import { ACTIVITY_VIEW_ID, DIRECTORY_VIEW_ID } from '../state';

const DM = '01a2050d-bd59-768a-8512-150242b9c641';

describe('chatPathFor', () => {
  it('names a channel by its name, a DM by its id, a view by its segment', () => {
    expect(chatPathFor('locked-in', { channelId: 'c1', name: 'general' })).toBe('/chat/locked-in/general');
    expect(chatPathFor('locked-in', { channelId: DM, name: null })).toBe(`/chat/locked-in/${DM}`);
    expect(chatPathFor('locked-in', { channelId: ACTIVITY_VIEW_ID })).toBe('/chat/locked-in/~activity');
    expect(chatPathFor('locked-in', { channelId: DIRECTORY_VIEW_ID })).toBe('/chat/locked-in/~people');
    expect(chatPathFor('locked-in', { channelId: null })).toBe('/chat/locked-in');
  });

  it('adds an open thread', () => {
    expect(chatPathFor('acme', { channelId: 'c1', name: 'eng', threadRootId: 'm1' })).toBe('/chat/acme/eng/thread/m1');
  });
});

describe('parseChatPath', () => {
  it('reads what chatPathFor writes', () => {
    for (const open of [
      { channelId: 'c1', name: 'general' },
      { channelId: DM, name: null },
      { channelId: 'c1', name: 'eng', threadRootId: 'm1' },
      { channelId: ACTIVITY_VIEW_ID },
    ]) {
      const t = parseChatPath(chatPathFor('acme', open));
      expect(t?.slug).toBe('acme');
      if (open.channelId.startsWith('__')) expect(t?.channel).toEqual({ view: open.channelId });
      else expect(t?.channel).toEqual({ ref: open.name ?? open.channelId });
      expect(t?.threadRootId).toBe(open.threadRootId ?? null);
    }
  });

  it('reads the organization alone, case-blind, with a trailing slash', () => {
    expect(parseChatPath('/chat/Acme/')).toEqual({ slug: 'acme', channel: null, threadRootId: null });
  });

  it('is not an organization address for Chat itself, its own pages or nonsense', () => {
    for (const p of ['/chat', '/chat/', '/docs/acme/x', '/chat/visit/abcdefghijklmnopq', '/chat/meeting/x', '/chat/a/general',
      '/chat/acme/~nope', '/chat/acme/~activity/x', '/chat/acme/eng/replies/m1', '/chat/acme/eng/thread', '/chat/acme/eng/thread/m1/x',
      '/chat/acme/%E0%A4%A']) {
      expect(parseChatPath(p), p).toBeNull();
    }
  });
});

describe('resolveChannelRef', () => {
  const channels = [{ id: 'c1', name: 'general' }, { id: DM, name: null }, { id: 'c3', name: 'c1' }];
  it('prefers a name, then an id', () => {
    expect(resolveChannelRef('General', channels)?.id).toBe('c1');
    expect(resolveChannelRef(DM, channels)?.id).toBe(DM);
    expect(resolveChannelRef('c1', channels)?.id).toBe('c3');
    expect(resolveChannelRef('gone', channels)).toBeNull();
  });
});
