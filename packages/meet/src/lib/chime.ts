// The "you're in" chime (Meet room, Room.tsx): two soft rising notes, played once the join to RealtimeKit has finished,
// so a person knows they are in the meeting. It is made with Web Audio rather than shipped as a file, as Chat's ringtone
// is (packages/web IncomingHuddle.tsx). A browser may refuse to play before the page was clicked (a huddle opened
// straight from Chat); then there is no chime, and nothing else changes.

/** The two notes (E5, then A5), each this long, the second starting this much after the first. */
export const CHIME_NOTES = [659.25, 880] as const;
const NOTE_S = 0.35;
const GAP_S = 0.12;
const VOLUME = 0.12;

type Ctx = Pick<AudioContext, 'currentTime' | 'destination' | 'createOscillator' | 'createGain' | 'resume' | 'close'>;

/** Plays the chime. `make` is for tests; it defaults to the browser's AudioContext. Never throws. */
export async function playJoinChime(make: () => Ctx = () => new AudioContext()): Promise<void> {
  let ctx: Ctx;
  try {
    ctx = make();
  } catch {
    return;
  }
  try {
    await ctx.resume();
    const start = ctx.currentTime;
    CHIME_NOTES.forEach((freq, i) => {
      const at = start + i * GAP_S;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, at);
      // A quick rise and a soft fade, so the notes do not click.
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(VOLUME, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_S);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + NOTE_S + 0.05);
    });
    const done = (GAP_S * (CHIME_NOTES.length - 1) + NOTE_S + 0.2) * 1000;
    setTimeout(() => void ctx.close().catch(() => {}), done);
  } catch {
    void ctx.close().catch(() => {});
  }
}
