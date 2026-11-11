import { describe, expect, it } from 'vitest';
import { LANES, queueState, schedule } from './thumbQueue.ts';

/** A load that finishes when told to, and notes whether it was cancelled. */
function load() {
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const job = { started: false, aborted: false, finish };
  const run = (signal: AbortSignal) => {
    job.started = true;
    signal.addEventListener('abort', () => (job.aborted = true));
    return done;
  };
  return { job, run };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('thumbQueue', () => {
  it('runs at most LANES loads at once, the newest waiting one first', async () => {
    const loads = Array.from({ length: LANES + 2 }, load);
    const cancels = loads.map((l) => schedule(l.run));
    expect(loads.map((l) => l.job.started)).toEqual([true, true, true, false, false]);
    expect(queueState()).toEqual({ waiting: 2, running: LANES });
    loads[0]!.job.finish();
    await tick();
    // The last one queued (what just scrolled in) goes before the one queued earlier.
    expect(loads.map((l) => l.job.started)).toEqual([true, true, true, false, true]);
    for (const l of loads) l.job.finish();
    await tick();
    expect(queueState().running).toBe(0);
    cancels.forEach((c) => c());
  });

  it('drops a cancelled load before its turn, and aborts one that is running', async () => {
    const loads = Array.from({ length: LANES + 1 }, load);
    const cancels = loads.map((l) => schedule(l.run));
    cancels[LANES]!();
    expect(queueState().waiting).toBe(0);
    cancels[0]!();
    expect(loads[0]!.job.aborted).toBe(true);
    loads.forEach((l) => l.job.finish());
    await tick();
    expect(loads[LANES]!.job.started).toBe(false);
    expect(queueState().running).toBe(0);
  });

  it('frees the lane when a load fails', async () => {
    const failing = schedule(() => Promise.reject(new Error('no')));
    await tick();
    expect(queueState().running).toBe(0);
    failing();
  });
});
