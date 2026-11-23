// The "you're in" chime (Meet room, Room.tsx): a soft, low chord (A4 and E5, with a quiet A5 on top), played once the
// join to RealtimeKit has finished, so a person knows they are in the meeting. Scott picked it from seven candidates
// (2026-11-23). It is made with Web Audio rather than shipped as a file, as Chat's ringtone is (packages/web
// IncomingHuddle.tsx). A browser may refuse to play before the page was clicked (a huddle opened straight from Chat);
// then there is no chime, and nothing else changes.

/** The chord's notes: frequency (Hz), start after the chord starts (s), length (s), volume. */
export const CHIME_NOTES = [
  { freq: 440, at: 0, length: 0.9, volume: 0.12 },
  { freq: 659.25, at: 0, length: 0.9, volume: 0.08 },
  { freq: 880, at: 0.02, length: 0.5, volume: 0.03 },
] as const;

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
    for (const note of CHIME_NOTES) {
      const at = start + note.at;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(note.freq, at);
      // A quick rise and a soft fade, so the notes do not click.
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(note.volume, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + note.length);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + note.length + 0.05);
    }
    const done = (Math.max(...CHIME_NOTES.map((n) => n.at + n.length)) + 0.2) * 1000;
    setTimeout(() => void ctx.close().catch(() => {}), done);
  } catch {
    void ctx.close().catch(() => {});
  }
}
