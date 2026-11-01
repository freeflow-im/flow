import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileHub, RESULT_IMAGES, ToolError, type FileService } from '../plugin/server/files.ts';
import { openDb } from './db.ts';
import { WindowTools, type WindowToolCall } from './windowTools.ts';

describe('WindowTools', () => {
  it('sends a call to the window showing the file, and gives back its answer', async () => {
    const tools = new WindowTools();
    const calls: WindowToolCall[] = [];
    tools.connect('w1', (c) => calls.push(c));
    // No window shows the file yet: run it elsewhere.
    expect(await tools.run({ kind: 'sheet', id: 's1' }, 'write_range', {})).toBeNull();

    tools.showing('w1', 's1');
    const result = tools.run({ kind: 'sheet', id: 's1' }, 'write_range', { range: 'A1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'sheet', fileId: 's1', name: 'write_range', input: { range: 'A1' } });
    expect(tools.answer(calls[0].id, { content: '{"ok":true}', images: [{ mediaType: 'image/png', data: 'AA==' }] })).toBe(true);
    expect(await result).toEqual({ content: '{"ok":true}', images: [{ mediaType: 'image/png', data: 'AA==' }] });
    // Answered once only.
    expect(tools.answer(calls[0].id, { content: 'again' })).toBe(false);
  });

  it('runs it elsewhere when the window no longer has the file open', async () => {
    const tools = new WindowTools();
    const calls: WindowToolCall[] = [];
    tools.connect('w1', (c) => calls.push(c));
    tools.showing('w1', 's1');
    const result = tools.run({ kind: 'sheet', id: 's1' }, 'read_range', {});
    tools.answer(calls[0].id, { unavailable: true });
    expect(await result).toBeNull();
  });

  it('uses the window brought forward last, and forgets one that disconnects', async () => {
    const tools = new WindowTools();
    const one: WindowToolCall[] = [];
    const two: WindowToolCall[] = [];
    const leaveOne = tools.connect('w1', (c) => one.push(c));
    tools.connect('w2', (c) => two.push(c));
    tools.showing('w1', 'd1');
    tools.showing('w2', 'd1');
    void tools.run({ kind: 'doc', id: 'd1' }, 'read_doc', {});
    expect([one.length, two.length]).toEqual([0, 1]);
    // w2 moves to another page: d1 is only shown in w1 once it says so again.
    tools.showing('w2', null);
    tools.showing('w1', 'd1');
    const pending = tools.run({ kind: 'doc', id: 'd1' }, 'insert_content', {});
    expect(one).toHaveLength(1);
    leaveOne();
    await expect(pending).rejects.toThrow(ToolError);
    expect(await tools.run({ kind: 'doc', id: 'd1' }, 'read_doc', {})).toBeNull();
  });

  it('runs a tool on a stored picture in the window in front, whatever it shows', async () => {
    const tools = new WindowTools();
    expect(await tools.runInFront('p1', 'transform_image', {})).toBeNull();
    const one: WindowToolCall[] = [];
    const two: WindowToolCall[] = [];
    tools.connect('w1', (c) => one.push(c));
    tools.connect('w2', (c) => two.push(c));
    tools.showing('w2', null);
    const result = tools.runInFront('p1', 'transform_image', { file_id: 'p1', operations: [{ op: 'remove_background' }] });
    expect(one).toHaveLength(0);
    expect(two[0]).toMatchObject({ kind: 'file', fileId: 'p1', name: 'transform_image', input: { operations: [{ op: 'remove_background' }] } });
    tools.answer(two[0].id, { content: '{"edited":true}' });
    expect(await result).toEqual({ content: '{"edited":true}' });
  });

  it('puts calls close together in one undo group', async () => {
    vi.useFakeTimers();
    try {
      const tools = new WindowTools();
      const calls: WindowToolCall[] = [];
      tools.connect('w1', (c) => calls.push(c));
      tools.showing('w1', 's1');
      void tools.run({ kind: 'sheet', id: 's1' }, 'write_range', {});
      vi.advanceTimersByTime(20_000);
      void tools.run({ kind: 'sheet', id: 's1' }, 'format_range', {});
      vi.advanceTimersByTime(61_000);
      void tools.run({ kind: 'sheet', id: 's1' }, 'sort_range', {});
      expect(calls[0].group).toBe(calls[1].group);
      expect(calls[2].group).not.toBe(calls[1].group);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the MCP edit tools with a window', () => {
  let dir: string;
  let svc: FileService;
  let tools: WindowTools;
  let calls: WindowToolCall[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'window-tools-'));
    const db = openDb(path.join(dir, 'app.db'));
    db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'a@example.com', 'x', new Date().toISOString());
    const hub = new FileHub({ db, dataDir: dir, publicUrl: null });
    await hub.init();
    tools = new WindowTools();
    hub.live = tools;
    svc = hub.forUser('u1');
    calls = [];
    tools.connect('w1', (c) => calls.push(c));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('run in the window on the open file, and on the stored file otherwise', async () => {
    const doc = await svc.createDoc('Plan', 'One.\n');
    const other = await svc.createDoc('Notes', 'Two.\n');
    svc.setOpen({ kind: 'doc', id: doc.id });
    tools.showing('w1', doc.id);

    const live = svc.editDoc(doc.id, 'insert_content', { markdown: 'Added.' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ kind: 'doc', fileId: doc.id, name: 'insert_content', input: { markdown: 'Added.' } });
    tools.answer(calls[0].id, { content: JSON.stringify({ inserted: 1 }) });
    expect(await live).toEqual({ doc_id: doc.id, title: 'Plan', inserted: 1 });
    // A file that is not open is read here, without asking the window.
    expect((await svc.editDoc(other.id, 'read_doc', {})).block_count).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('pass on what the window said: its error, its pictures, or that it does not have the file', async () => {
    const deck = await svc.createDeck('Talk', undefined, [{ layout: 'title', title: 'Hello' }]);
    svc.setOpen({ kind: 'deck', id: deck.id });
    tools.showing('w1', deck.id);

    const failed = svc.editDeck(deck.id, 'delete_slides', { slides: [1] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    tools.answer(calls[0].id, { content: 'The user declined this action.', isError: true });
    await expect(failed).rejects.toThrow('The user declined this action.');

    const read = svc.editDeck(deck.id, 'read_deck', {});
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    tools.answer(calls[1].id, { content: '{"slide_count":1}', images: [{ mediaType: 'image/png', data: 'AA==' }] });
    const r = await read;
    expect(r.slide_count).toBe(1);
    expect(r[RESULT_IMAGES as unknown as string]).toEqual([{ mediaType: 'image/png', data: 'AA==' }]);

    const headless = svc.editDeck(deck.id, 'read_deck', {});
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    tools.answer(calls[2].id, { unavailable: true });
    expect((await headless).deck_id).toBe(deck.id);
  });
});
