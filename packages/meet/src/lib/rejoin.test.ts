import { describe, expect, it } from 'vitest';
import { ALIVE, guestKey, lastPeer, notePeer, readRejoin, REPLACES, withoutReplaced } from './rejoin';

function memoryStore() {
  const kept = new Map<string, string>();
  return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
}

describe('a connection that was replaced', () => {
  const self = { id: 'peer-me', customParticipantId: 'user-me' };
  const annOld = { id: 'peer-ann-1', customParticipantId: 'user-ann' };
  const annNew = { id: 'peer-ann-2', customParticipantId: 'user-ann' };
  const bob = { id: 'peer-bob', customParticipantId: 'user-bob' };

  it('is left out once the same participant’s newer connection names it', () => {
    expect(withoutReplaced(self, [annOld, annNew, bob], new Map([['peer-ann-1', 'peer-ann-2']]))).toEqual([annNew, bob]);
  });

  it('stays while nothing names it: a person on two devices is two tiles', () => {
    expect(withoutReplaced(self, [annOld, annNew, bob], new Map())).toEqual([annOld, annNew, bob]);
  });

  it('stays when another participant names it, so nobody hides someone else', () => {
    expect(withoutReplaced(self, [annOld, bob], new Map([['peer-ann-1', 'peer-bob']]))).toEqual([annOld, bob]);
  });

  it('stays when the connection that named it is not in the room', () => {
    expect(withoutReplaced(self, [annOld, bob], new Map([['peer-ann-1', 'peer-gone']]))).toEqual([annOld, bob]);
  });

  it('is left out for the person themselves too: their own old connection', () => {
    const mineOld = { id: 'peer-me-old', customParticipantId: 'user-me' };
    expect(withoutReplaced(self, [mineOld, bob], new Map([['peer-me-old', 'peer-me']]))).toEqual([bob]);
  });
});

describe('what this browser remembers of a room', () => {
  it('is its last connection, for a few minutes', () => {
    const store = memoryStore();
    expect(lastPeer('abc-defg-hij', 1_000, store)).toBeNull();
    notePeer('abc-defg-hij', 'peer-1', 1_000, store);
    expect(lastPeer('abc-defg-hij', 61_000, store)).toBe('peer-1');
    expect(lastPeer('abc-defg-hij', 1_000 + 6 * 60_000, store)).toBeNull();
    expect(lastPeer('zzz-zzzz-zzz', 2_000, store)).toBeNull();
  });

  it('is nothing when storage is blocked or holds something else', () => {
    expect(lastPeer('abc-defg-hij', 1_000, null)).toBeNull();
    const store = memoryStore();
    store.setItem('meet.peer.abc-defg-hij', 'not json');
    expect(lastPeer('abc-defg-hij', 1_000, store)).toBeNull();
  });

  it('keeps one guest key', () => {
    const store = memoryStore();
    const key = guestKey(store);
    expect(key).toMatch(/^[A-Za-z0-9-]{16,64}$/);
    expect(guestKey(store)).toBe(key);
    expect(guestKey(null)).toBeUndefined();
  });
});

describe('a broadcast about rejoining', () => {
  it('is read only when it is well formed', () => {
    expect(readRejoin(REPLACES, { peerId: 'a', by: 'b' })).toEqual({ kind: 'replaces', peerId: 'a', by: 'b' });
    expect(readRejoin(ALIVE, { peerId: 'a' })).toEqual({ kind: 'alive', peerId: 'a' });
    expect(readRejoin(REPLACES, { peerId: 'a' })).toBeNull();
    expect(readRejoin(REPLACES, { peerId: 7, by: 'b' })).toBeNull();
    expect(readRejoin('spotlight', { peerId: 'a', by: 'b' })).toBeNull();
    expect(readRejoin(ALIVE, null)).toBeNull();
  });
});
