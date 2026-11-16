// The incoming-call card (#436) — Flow's whole answer to "someone is calling
// you", and deliberately only that. Accept opens the huddle's Meet room in a new
// tab (Meet phase 2). The same corner shows the huddle's one-line notices
// ("Ben isn't available", or why a huddle could not start). There is no lock-screen answer, no system
// call UI and no Recents entry: Track A rings a *live socket*, so this card
// exists exactly while the app is open, which is exactly when the ring reached
// you at all.
//
// The ringtone is generated rather than shipped as an asset: two sine tones on
// a 4-second loop through WebAudio. A file would need hosting, caching and a
// licence for something a dozen lines of oscillator does — and this way the
// tone stops precisely when the card unmounts, with no half-played audio
// element to chase.
import { useEffect, useRef } from 'react';
import { useHuddle } from '../huddle';
import { useMembers } from '../hooks';
import { Avatar } from './Avatar';

const RING_PERIOD_MS = 4000;

function useRingtone(active: boolean): void {
  const ctxRef = useRef<AudioContext | null>(null);
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    let stopped = false;
    // Browsers block audio until the page has been interacted with; a ring
    // that can't sound is not an error, the card still shows.
    let ctx: AudioContext;
    try {
      ctx = ctxRef.current ?? new AudioContext();
    } catch {
      return;
    }
    ctxRef.current = ctx;
    const beep = (at: number, freq: number): void => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      // Envelope, not a square edge — an abrupt gate on a sine is a click.
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.12, at + 0.05);
      gain.gain.linearRampToValueAtTime(0, at + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.45);
    };
    const ring = (): void => {
      if (stopped) return;
      const now = ctx.currentTime;
      beep(now, 660);
      beep(now + 0.5, 880);
      timer = window.setTimeout(ring, RING_PERIOD_MS);
    };
    void ctx.resume().then(ring, () => {});
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active]);
}

export default function IncomingHuddle() {
  const huddle = useHuddle();
  const invite = huddle.incoming;
  const members = useMembers(invite?.workspaceId ?? null);
  useRingtone(invite !== null);

  if (!invite && huddle.notice) {
    return (
      <div
        data-testid="huddle-notice"
        role="status"
        className="fixed bottom-6 right-6 z-50 max-w-[320px] rounded-lg border border-hairline bg-panel px-4 py-3 text-sm text-ink shadow-lg"
      >
        {huddle.notice}
        <button className="ml-3 text-faint hover:text-ink" aria-label="Dismiss" onClick={huddle.dismissNotice}>
          ✕
        </button>
      </div>
    );
  }

  if (huddle.answeredElsewhere) {
    return (
      <div
        data-testid="huddle-answered-elsewhere"
        className="fixed bottom-6 right-6 z-50 rounded-lg border border-hairline bg-panel px-4 py-3 text-sm text-muted shadow-lg"
      >
        Answered on another device
        <button className="ml-3 text-faint hover:text-ink" onClick={huddle.dismissAnsweredElsewhere}>
          ✕
        </button>
      </div>
    );
  }

  if (!invite) return null;
  const caller = (members.data ?? []).find((m) => m.userId === invite.startedBy);
  const name = caller?.displayName ?? 'Someone';

  return (
    <div
      data-testid="huddle-incoming"
      role="dialog"
      aria-label={`${name} is calling`}
      className="fixed bottom-6 right-6 z-50 w-[300px] rounded-xl border border-hairline bg-panel p-4 shadow-2xl"
    >
      <div className="flex items-center gap-3">
        <Avatar userId={invite.startedBy} name={name} avatarUrl={caller?.avatarUrl ?? null} size={44} radius={999} />
        <div className="min-w-0">
          <div className="truncate font-semibold text-ink">{name}</div>
          <div className="text-xs text-muted">is starting a huddle…</div>
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <button
          data-testid="huddle-decline"
          className="flex-1 rounded-lg bg-daypill px-3 py-2 text-sm font-semibold text-ink hover:bg-daypill/70"
          onClick={() => void huddle.declineIncoming()}
        >
          Decline
        </button>
        <button
          data-testid="huddle-accept"
          className="flex-1 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
          disabled={huddle.starting}
          onClick={() => void huddle.acceptIncoming()}
        >
          Join
        </button>
      </div>
    </div>
  );
}
