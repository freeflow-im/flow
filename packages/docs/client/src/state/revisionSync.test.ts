import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkdownDoc } from '../../../shared/markdown.ts';
import type { SheetMeta } from '../../../shared/types.ts';
import { ApiError } from '../api.ts';
import { MarkdownController } from '../markdown/controller.ts';
import { RevisionSync, takenMessage, type Taken } from './revisionSync.ts';

/** A stored Markdown file: saves that name an old revision are refused, as the server does. */
function server(text: string) {
  const s = { rev: 'r1', text, saves: 0, loads: 0 };
  let n = 1;
  return Object.assign(s, {
    async save(doc: MarkdownDoc, rev: string) {
      if (rev !== s.rev) throw new ApiError(409, 'changed elsewhere');
      s.saves++;
      s.text = doc.text;
      s.rev = `r${++n}`;
      return { meta: { updatedAt: s.rev } as SheetMeta };
    },
    async load() {
      s.loads++;
      return { meta: { updatedAt: s.rev } as SheetMeta, doc: { version: 1 as const, text: s.text } };
    },
    /** A save from somewhere else (another tab, the ChatGPT plugin). */
    elsewhere(next: string) {
      s.text = next;
      s.rev = `r${++n}`;
    },
  });
}

function open(srv: ReturnType<typeof server>) {
  const sync = new RevisionSync<MarkdownDoc>('m1', srv.rev, srv);
  const ctl = new MarkdownController({ version: 1, text: srv.text }, sync.save);
  sync.attach(ctl);
  const taken: Taken[] = [];
  sync.onTaken((t) => taken.push(t));
  return { sync, ctl, taken };
}

describe('RevisionSync', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('loads a revision announced while the editor has nothing unsaved, without writing it back', async () => {
    const srv = server('a');
    const { sync, ctl, taken } = open(srv);
    srv.elsewhere('b');
    await sync.heard(JSON.stringify({ rev: srv.rev }));
    expect(ctl.text).toBe('b');
    expect(taken).toMatchObject([{ changed: true, lostEdits: false }]);
    expect(takenMessage(taken[0])).toMatch(/^Updated with changes saved somewhere else/);
    expect(ctl.saver.hasUnsavedChanges()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.saves).toBe(0);
    // The editor's next edit saves under the revision it loaded.
    ctl.setText('bc');
    await vi.advanceTimersByTimeAsync(1000);
    expect(srv.text).toBe('bc');
  });

  it('ignores its own revision and leaves an editor with unsaved changes to its save', async () => {
    const srv = server('a');
    const { sync, ctl, taken } = open(srv);
    await sync.heard(JSON.stringify({ rev: srv.rev }));
    expect(srv.loads).toBe(0);
    ctl.setText('mine');
    srv.elsewhere('theirs');
    await sync.heard(JSON.stringify({ rev: srv.rev }));
    expect(srv.loads).toBe(0);
    // The save is refused and the editor takes the newer version.
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctl.text).toBe('theirs');
    expect(taken).toMatchObject([{ changed: true, lostEdits: true }]);
    expect(takenMessage(taken[0])).toMatch(/before your last edit was saved/);
    expect(ctl.saver.status).toBe('saved');
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.saves).toBe(0);
  });

  it('does not replace an edit made while the announced version was loading', async () => {
    const srv = server('a');
    const { sync, ctl } = open(srv);
    srv.elsewhere('b');
    const heard = sync.heard(JSON.stringify({ rev: srv.rev }));
    ctl.setText('typed');
    await heard;
    expect(ctl.text).toBe('typed');
  });
});
