// Huddle client controller (Meet phase 2, docs/specs/meetings.md): a conversation's huddle is its Meet room, which opens
// in its own browser tab, so Chat no longer holds any call media. What stays here is starting a huddle (the server makes
// the room and rings the conversation's people; this opens /meet/<code>) and the ring: the incoming-call card, its
// answer on another device, and "X isn't available". Mounted once in Main.tsx, alongside the WS socket.
//
// Who is in a huddle rides the channel-list cache via `huddle.updated` events (lib/channelCache.ts applyHuddle); the
// Meet room's join and leave are what move it on the server.
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { HuddleInviteDTO, HuddleStartDTO } from '@flow/shared';
import { useBoundApi } from './lib/useBoundApi';
import { ringEffect } from './lib/huddleRing';

export interface HuddleState {
  /** A huddle is being started or answered: the request is in flight. */
  starting: boolean;
  /** A one-line note for the person ("Ben isn't available", or why a huddle could not start). */
  notice: string | null;
  dismissNotice(): void;

  // ---- the ring (#436) ----
  /** A ring aimed at us, if one is live. Drives the incoming-call overlay. */
  incoming: HuddleInviteDTO | null;
  /** Set when another of our devices answered, so this one can say so. */
  answeredElsewhere: boolean;
  dismissAnsweredElsewhere(): void;

  /** Start (or join) a conversation's huddle: rings its people and opens its Meet room in a new tab. */
  start(channelId: string): Promise<void>;
  acceptIncoming(): Promise<void>;
  declineIncoming(): Promise<void>;
  /** Main.tsx feeds `huddle.invite` events in here. */
  applyInviteEvent(invite: HuddleInviteDTO, meta: { selfId: string; answeredBySessionId?: string; unavailable?: string[] }): void;
  /** Main.tsx hands over the WS session id from the `hello` frame. */
  setSessionId(sessionId: string | null): void;
}

/** Huddles start only in a conversation this small (ruling R5); the server says the same (409 room_too_large). */
export const HUDDLE_MAX_PEOPLE = 6;

const HuddleContext = createContext<HuddleState | null>(null);

export function useHuddle(): HuddleState {
  const v = useContext(HuddleContext);
  if (!v) throw new Error('HuddleContext missing');
  return v;
}

/** The address of a Meet room on the server this Chat is connected to (Meet is the suite's /meet app). */
export const meetRoomUrl = (origin: string, code: string) => `${origin.replace(/\/$/, '')}/meet/${code}`;

/**
 * Opens a tab at once and sends it to the room when the server answers: a tab opened after an await is blocked as a
 * pop-up. If the browser refuses the tab, the room opens in this one.
 */
async function openRoom(make: () => Promise<string>): Promise<void> {
  const tab = window.open('', '_blank');
  try {
    const url = await make();
    if (tab) tab.location.href = url;
    else window.location.assign(url);
  } catch (err) {
    tab?.close();
    throw err;
  }
}

function messageOf(err: unknown): string {
  const e = err as { message?: string; body?: { error?: { message?: string } } };
  return e?.body?.error?.message ?? e?.message ?? 'The huddle could not start.';
}

const unavailableLine = (names: string[]) =>
  names.length === 1 ? `${names[0]} isn't available right now.` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} aren't available right now.`;

export function HuddleProvider({ children }: { children: React.ReactNode }) {
  const { api, serverOrigin } = useBoundApi();
  const sessionIdRef = useRef<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<HuddleInviteDTO | null>(null);
  const [answeredElsewhere, setAnsweredElsewhere] = useState(false);

  const run = useCallback(
    async (request: () => Promise<HuddleStartDTO>) => {
      setStarting(true);
      setNotice(null);
      try {
        await openRoom(async () => {
          const res = await request();
          if (res.unavailable.length > 0) setNotice(unavailableLine(res.unavailable));
          return meetRoomUrl(serverOrigin || window.location.origin, res.meeting.code);
        });
      } catch (err) {
        setNotice(messageOf(err));
      } finally {
        setStarting(false);
      }
    },
    [serverOrigin],
  );

  const start = useCallback(
    (channelId: string) => run(() => api<HuddleStartDTO>('POST', `/v1/channels/${channelId}/huddle/join`)),
    [api, run],
  );

  const acceptIncoming = useCallback(async () => {
    const invite = incoming;
    if (!invite) return;
    setIncoming(null);
    await run(() => api<HuddleStartDTO>('POST', `/v1/huddle/invites/${invite.id}/accept`, { sessionId: sessionIdRef.current ?? undefined }));
  }, [api, incoming, run]);

  const declineIncoming = useCallback(async () => {
    const invite = incoming;
    if (!invite) return;
    setIncoming(null);
    try {
      await api('POST', `/v1/huddle/invites/${invite.id}/decline`, { sessionId: sessionIdRef.current ?? undefined });
    } catch {
      /* the 30s timeout retires it anyway */
    }
  }, [api, incoming]);

  /**
   * Fold a `huddle.invite` event into ring state. One event type covers both directions, so the rule is written once
   * here: the overlay is up only while the invite is ringing *and* our own target row still says ringing. That is
   * what dismisses a second device when the first one answers — and when the answer came from a sibling device rather
   * than this one, it says so.
   */
  const applyInviteEvent = useCallback<HuddleState['applyInviteEvent']>((invite, meta) => {
    const effect = ringEffect(invite, { ...meta, mySessionId: sessionIdRef.current });
    switch (effect.kind) {
      case 'ring':
        setIncoming(effect.invite);
        break;
      case 'answered-elsewhere':
        setIncoming((cur) => (cur?.id === invite.id ? null : cur));
        setAnsweredElsewhere(true);
        break;
      case 'dismiss':
        setIncoming((cur) => (cur?.id === invite.id ? null : cur));
        break;
      case 'outgoing':
        if (effect.unavailable.length > 0) setNotice(unavailableLine(effect.unavailable));
        break;
      case 'ignore':
        break;
    }
  }, []);

  const setSessionId = useCallback((id: string | null) => {
    sessionIdRef.current = id;
  }, []);

  const value = useMemo<HuddleState>(
    () => ({
      starting,
      notice,
      dismissNotice: () => setNotice(null),
      incoming,
      answeredElsewhere,
      dismissAnsweredElsewhere: () => setAnsweredElsewhere(false),
      start,
      acceptIncoming,
      declineIncoming,
      applyInviteEvent,
      setSessionId,
    }),
    [starting, notice, incoming, answeredElsewhere, start, acceptIncoming, declineIncoming, applyInviteEvent, setSessionId],
  );

  return <HuddleContext.Provider value={value}>{children}</HuddleContext.Provider>;
}
