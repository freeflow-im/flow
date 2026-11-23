// The join chime (lib/chime.ts): a low chord, each note faded in and out, and the audio closed after; a browser that
// refuses audio leaves no error behind.
import { describe, expect, it, vi } from 'vitest';
import { CHIME_NOTES, playJoinChime } from './chime';

function fakeCtx() {
  const started: number[] = [], freqs: number[] = [];
  const param = () => ({ setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  const ctx = {
    currentTime: 10,
    destination: {},
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    createGain: () => ({ gain: param(), connect: (d: unknown) => d }),
    createOscillator: () => {
      const frequency = { setValueAtTime: (f: number) => void freqs.push(f) };
      return { type: '', frequency, connect: (g: unknown) => g, start: (t: number) => void started.push(t), stop: vi.fn() };
    },
  };
  return { ctx, started, freqs };
}

describe('playJoinChime', () => {
  it('plays the chord, its notes together, then closes the audio', async () => {
    vi.useFakeTimers();
    const { ctx, started, freqs } = fakeCtx();
    await playJoinChime(() => ctx as never);
    expect(freqs).toEqual([440, 659.25, 880]);
    expect(CHIME_NOTES).toHaveLength(3);
    expect(started.every((t) => t >= 10 && t < 10.1)).toBe(true);
    expect(ctx.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(ctx.close).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does nothing, and throws nothing, when the browser refuses audio', async () => {
    await expect(playJoinChime(() => { throw new Error('no audio'); })).resolves.toBeUndefined();
    const { ctx } = fakeCtx();
    ctx.resume = vi.fn(async () => { throw new Error('not allowed'); });
    await expect(playJoinChime(() => ctx as never)).resolves.toBeUndefined();
    expect(ctx.close).toHaveBeenCalled();
  });
});
