import { describe, expect, it } from 'vitest';
import { queueDone, queueFinished, runImports, type ImportQueue } from './importQueue.ts';

const file = (name: string) => new File(['x'], name);

describe('several-file import queue', () => {
  it('imports one file at a time, in order, reporting each step', async () => {
    const order: string[] = [];
    let running = 0;
    const steps: ImportQueue[] = [];
    const q = await runImports(
      [file('a.md'), file('b.csv'), file('c.pdf')],
      async (f) => {
        running++;
        expect(running).toBe(1);
        await new Promise((r) => setTimeout(r, 1));
        order.push(f.name);
        running--;
      },
      (s) => steps.push(s),
    );
    expect(order).toEqual(['a.md', 'b.csv', 'c.pdf']);
    expect(q.map((i) => i.state)).toEqual(['done', 'done', 'done']);
    expect(steps[0].map((i) => i.state)).toEqual(['queued', 'queued', 'queued']);
    expect(steps[1].map((i) => i.state)).toEqual(['uploading', 'queued', 'queued']);
    expect(steps.at(-1)).toBe(q);
    expect(queueFinished(q)).toBe(true);
  });

  it('marks a failed file with its reason and carries on with the rest', async () => {
    const q = await runImports(
      [file('a.md'), file('bad.exe'), file('c.md')],
      async (f) => {
        if (f.name === 'bad.exe') throw new Error('Not a file that can be imported.');
      },
      () => {},
    );
    expect(q.map((i) => i.state)).toEqual(['done', 'failed', 'done']);
    expect(q[1].error).toBe('Not a file that can be imported.');
    expect(queueDone(q)).toBe(3);
  });

  it('counts a queue still running as not finished', () => {
    const q: ImportQueue = [{ name: 'a', state: 'done' }, { name: 'b', state: 'uploading' }, { name: 'c', state: 'queued' }];
    expect(queueDone(q)).toBe(1);
    expect(queueFinished(q)).toBe(false);
  });
});
