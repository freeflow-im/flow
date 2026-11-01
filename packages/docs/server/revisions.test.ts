import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDeck } from '../shared/deck.ts';
import { newDoc } from '../shared/doc.ts';
import { newWorkbook } from '../shared/types.ts';
import { buildApp } from './app.ts';
import { mailbox, signUp } from './testing.ts';

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
const box = mailbox();

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-rev-'));
  app = await buildApp({ dataDir: dir, sendMail: box.send });
  cookie = (await signUp(app, box, 'rev@x.com')).cookie;
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('saves that name the revision they loaded', () => {
  it('refuses a document save after someone else saved, and accepts one with the current revision', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Plan' } });
    const id = created.json().doc.id as string;
    const rev = created.json().doc.updatedAt as string;
    await new Promise((r) => setTimeout(r, 5));
    const other = await app.inject({ method: 'PUT', url: `/api/docs/${id}`, headers: { cookie }, payload: { doc: newDoc() } });
    expect(other.statusCode).toBe(200);
    const stale = await app.inject({ method: 'PUT', url: `/api/docs/${id}`, headers: { cookie }, payload: { doc: newDoc(), rev } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().meta.updatedAt).toBe(other.json().meta.updatedAt);
    const fresh = await app.inject({ method: 'PUT', url: `/api/docs/${id}`, headers: { cookie }, payload: { doc: newDoc(), rev: other.json().meta.updatedAt } });
    expect(fresh.statusCode).toBe(200);
  });

  it('does the same for presentations, and still accepts saves without a revision', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/decks', headers: { cookie }, payload: { title: 'Pitch' } });
    const id = created.json().deck.id as string;
    const rev = created.json().deck.updatedAt as string;
    await new Promise((r) => setTimeout(r, 5));
    expect((await app.inject({ method: 'PUT', url: `/api/decks/${id}`, headers: { cookie }, payload: { deck: newDeck() } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: `/api/decks/${id}`, headers: { cookie }, payload: { deck: newDeck(), rev } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: `/api/decks/${id}`, headers: { cookie }, payload: { deck: newDeck() } })).statusCode).toBe(200);
  });
});

describe('spreadsheet saves that name the revision they loaded', () => {
  it('refuses one after someone else saved, CSV files too, and still accepts saves without a revision', async () => {
    for (const payload of [{ title: 'Budget' }, { title: 'Data', csv: 'a,b\n1,2\n' }]) {
      const created = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload });
      const id = created.json().sheet.id as string;
      const rev = created.json().sheet.updatedAt as string;
      await new Promise((r) => setTimeout(r, 5));
      const other = await app.inject({ method: 'PUT', url: `/api/sheets/${id}`, headers: { cookie }, payload: { workbook: newWorkbook('Sheet1') } });
      expect(other.statusCode).toBe(200);
      const stale = await app.inject({ method: 'PUT', url: `/api/sheets/${id}`, headers: { cookie }, payload: { workbook: newWorkbook('Sheet1'), rev } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().meta.updatedAt).toBe(other.json().sheet.updatedAt);
      const fresh = await app.inject({ method: 'PUT', url: `/api/sheets/${id}`, headers: { cookie }, payload: { workbook: newWorkbook('Sheet1'), rev: other.json().sheet.updatedAt } });
      expect(fresh.statusCode).toBe(200);
    }
  });
});

describe('the revision feed', () => {
  it('sends the current revision, then each new one from saves and renames, and stops when the editor goes', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Notes' } });
    const id = created.json().doc.id as string;
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const abort = new AbortController();
    const res = await fetch(`${address}/api/revisions/${id}`, { headers: { cookie }, signal: abort.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    let buffered = '';
    const next = async (): Promise<string> => {
      while (!buffered.includes('\n\n')) buffered += new TextDecoder().decode((await reader.read()).value);
      const [event, ...rest] = buffered.split('\n\n');
      buffered = rest.join('\n\n');
      return (JSON.parse(event.replace(/^data: /, '')) as { rev: string }).rev;
    };
    expect(await next()).toBe(created.json().doc.updatedAt);

    await new Promise((r) => setTimeout(r, 5));
    const saved = await app.inject({ method: 'PUT', url: `/api/docs/${id}`, headers: { cookie }, payload: { doc: newDoc() } });
    expect(await next()).toBe(saved.json().meta.updatedAt);
    await new Promise((r) => setTimeout(r, 5));
    const renamed = await app.inject({ method: 'PATCH', url: `/api/docs/${id}`, headers: { cookie }, payload: { title: 'Notes 2' } });
    expect(await next()).toBe(renamed.json().meta.updatedAt);

    abort.abort();
    await reader.cancel().catch(() => {});
  });

  it('refuses a file that is not the user’s', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/revisions/nope', headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/revisions/nope' })).statusCode).toBe(401);
  });
});
