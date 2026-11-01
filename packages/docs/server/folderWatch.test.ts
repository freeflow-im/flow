import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SheetMeta } from '../shared/types.ts';
import { buildApp } from './app.ts';
import { DirWatchers } from './folderWatch.ts';

// The desktop app follows changes other programs make in its folder (server/folderWatch.ts).
let folder: string;
let dataDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let address: string;

beforeAll(async () => {
  folder = mkdtempSync(path.join(tmpdir(), 'sheetsweb-watch-'));
  dataDir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-watchdata-'));
  writeFileSync(path.join(folder, 'notes.md'), '# Notes\n');
  app = await buildApp({ dataDir, local: { dir: folder } });
  address = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
  rmSync(folder, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

/** The events of a server-sent event stream, one at a time, and how to stop it. */
async function stream(url: string) {
  const abort = new AbortController();
  const res = await fetch(`${address}${url}`, { signal: abort.signal });
  expect(res.headers.get('content-type')).toBe('text/event-stream');
  const reader = res.body!.getReader();
  let buffered = '';
  return {
    async next(): Promise<unknown> {
      for (;;) {
        // Complete events only (the last piece may be half of one); pings are skipped.
        const events = buffered.split('\n\n');
        const at = events.slice(0, -1).findIndex((e) => e.startsWith('data: '));
        if (at >= 0) {
          buffered = events.slice(at + 1).join('\n\n');
          return JSON.parse(events[at].slice('data: '.length));
        }
        buffered += new TextDecoder().decode((await reader.read()).value);
      }
    },
    async stop() {
      abort.abort();
      await reader.cancel().catch(() => {});
    },
  };
}

describe('changes made outside the desktop app', () => {
  it('reach the editors open on the file as a new revision', async () => {
    const [meta] = (await app.inject({ method: 'GET', url: '/api/markdown' })).json().docs as SheetMeta[];
    const feed = await stream(`/api/revisions/${meta.id}`);
    expect(await feed.next()).toEqual({ rev: meta.updatedAt });

    let later = 5000;
    const edit = () => {
      writeFileSync(path.join(folder, 'notes.md'), '# Notes\n\nEdited elsewhere\n');
      utimesSync(path.join(folder, 'notes.md'), new Date(), new Date(Date.now() + (later += 1000)));
    };
    const writing = setInterval(edit, 300);
    edit();
    const { rev } = (await feed.next()) as { rev: string };
    clearInterval(writing);
    expect(rev).not.toBe(meta.updatedAt);

    // The editor loads that revision, and can save over it.
    const loaded = (await app.inject({ method: 'GET', url: `/api/markdown/${meta.id}` })).json() as { meta: SheetMeta; doc: { text: string } };
    expect(loaded.meta.updatedAt).toBe(rev);
    expect(loaded.doc.text).toContain('Edited elsewhere');
    const saved = await app.inject({ method: 'PUT', url: `/api/markdown/${meta.id}`, payload: { doc: { version: 1, text: 'mine' }, rev } });
    expect(saved.statusCode).toBe(200);
    await feed.stop();
  });

  it('reach the list showing the folder', async () => {
    const feed = await stream('/api/local/folder-changes');
    // The system's watch can take a moment to start (FSEvents on macOS): the file is written until it is heard.
    let n = 0;
    const writing = setInterval(() => writeFileSync(path.join(folder, 'fresh.md'), `new ${n++}`), 300);
    writeFileSync(path.join(folder, 'fresh.md'), 'new');
    expect(await feed.next()).toEqual({});
    clearInterval(writing);
    expect(((await app.inject({ method: 'GET', url: '/api/library' })).json().docs as SheetMeta[]).map((d) => d.title)).toContain('fresh.md');
    await feed.stop();
  });
});

describe('DirWatchers', () => {
  it('watches a directory once for everyone, tells each of them, and stops with the last', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-dirs-'));
    const watchers = new DirWatchers((d) => path.join(dir, d), 50);
    const heard: (Set<string> | null)[] = [];
    let other = 0;
    const stopA = watchers.watch('', (names) => heard.push(names));
    const stopB = watchers.watch('', () => other++);
    expect(watchers.size).toBe(1);
    // The system's watch can take a moment to start, and its events come when they come (FSEvents on macOS
    // batches them): the file is written until both have heard.
    for (let waited = 0; (!heard.length || !other) && waited < 5000; waited += 100) {
      if (waited % 300 === 0) writeFileSync(path.join(dir, 'a.txt'), String(waited));
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(heard.length).toBeGreaterThan(0);
    expect(other).toBeGreaterThan(0);
    if (heard[0]) expect([...heard[0]]).toContain('a.txt');
    stopA();
    expect(watchers.size).toBe(1);
    stopB();
    expect(watchers.size).toBe(0);
    // A directory that is not there is not watched, and stopping is still fine.
    watchers.watch('missing', () => {})();
    expect(watchers.size).toBe(0);
    watchers.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
