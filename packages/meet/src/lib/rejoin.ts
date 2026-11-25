// A person who comes back to a room after their page died (a crash, a lost network, a sleeping laptop) has two
// connections for a while: RealtimeKit keeps the old one until it times out, and nothing told it to drop it. The room
// would draw the person twice. So a page remembers its connection in this browser, and when it joins the same room
// again it tells the room which old connection it replaces; every page then leaves that one out.
//
// The claim is only believed when both connections are the same participant (the same RealtimeKit custom id), so
// nobody can hide someone else. A member's id is their user id on every device, which is why the rule cannot simply be
// "one tile per id": a person on a laptop and a phone is two tiles. A page that is told it was replaced but is still
// open (the same room in two tabs) answers that it is alive, and is drawn again.

/** Broadcast by a page that joined again: `{ peerId: <the old connection>, by: <the new one> }`. */
export const REPLACES = 'flow.replaces';
/** Broadcast by a page that was named in REPLACES but is still open: `{ peerId: <its connection> }`. */
export const ALIVE = 'flow.alive';

/** How long a remembered connection is worth naming: far longer than RealtimeKit keeps a dead one. */
const MAX_AGE_MS = 5 * 60_000;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function browserStore(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null; // storage is blocked (some private modes): there is no rejoin to tell, and the room works as before
  }
}

const keyOf = (code: string) => `meet.peer.${code}`;

/** This browser's last connection to the room, if it is recent enough to still be in it. */
export function lastPeer(code: string, now = Date.now(), store: Store | null = browserStore()): string | null {
  try {
    const kept = JSON.parse(store?.getItem(keyOf(code)) ?? 'null') as { peerId?: unknown; at?: unknown } | null;
    if (!kept || typeof kept.peerId !== 'string' || typeof kept.at !== 'number') return null;
    return now - kept.at <= MAX_AGE_MS ? kept.peerId : null;
  } catch {
    return null;
  }
}

/** Remember this page's connection to the room, for the next join from this browser. */
export function notePeer(code: string, peerId: string, now = Date.now(), store: Store | null = browserStore()): void {
  try {
    store?.setItem(keyOf(code), JSON.stringify({ peerId, at: now }));
  } catch {
    // a full or blocked store: the next join names nothing
  }
}

/**
 * A secret this browser keeps for joining as a guest. The server makes the guest's participant id from it, so a guest
 * who comes back is the same participant as before, and the others cannot work the secret out from the id.
 */
export function guestKey(store: Store | null = browserStore()): string | undefined {
  try {
    const kept = store?.getItem('meet.guestKey');
    if (kept && /^[A-Za-z0-9-]{16,64}$/.test(kept)) return kept;
    const made = crypto.randomUUID();
    store?.setItem('meet.guestKey', made);
    return store ? made : undefined;
  } catch {
    return undefined;
  }
}

export interface Connection {
  id: string;
  customParticipantId?: string;
}

/**
 * The other people to draw: every connection except one that a newer connection of the same participant replaced.
 * `replaced` maps an old connection to the one that said it replaces it.
 */
export function withoutReplaced<T extends Connection>(self: Connection, others: readonly T[], replaced: ReadonlyMap<string, string>): T[] {
  if (!replaced.size) return [...others];
  const byId = new Map<string, Connection>([self, ...others].map((p) => [p.id, p]));
  return others.filter((p) => {
    const newer = byId.get(replaced.get(p.id) ?? '');
    return !(newer && newer.id !== p.id && !!p.customParticipantId && newer.customParticipantId === p.customParticipantId);
  });
}

/** What a broadcast says about replaced connections, or null for any other message. */
export function readRejoin(type: string, payload: unknown): { kind: 'replaces'; peerId: string; by: string } | { kind: 'alive'; peerId: string } | null {
  const p = (payload ?? {}) as { peerId?: unknown; by?: unknown };
  if (typeof p.peerId !== 'string' || !p.peerId) return null;
  if (type === REPLACES && typeof p.by === 'string' && p.by) return { kind: 'replaces', peerId: p.peerId, by: p.by };
  if (type === ALIVE) return { kind: 'alive', peerId: p.peerId };
  return null;
}
