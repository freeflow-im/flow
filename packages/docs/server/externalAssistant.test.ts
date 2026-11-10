// Hosted with an assistant of the host's own (host.assistant, the FreeFlow suite's Assistant object, platform.md §5.5):
// this app serves none of the assistant's routes but the jobs', and answers the three routes the host's assistant's
// tools call for what they did in-process here: a chat file's name and root, a PDF saved beside a file, and bytes imported.
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';

const members: Record<string, string[]> = { alice: ['harbor'], bob: ['harbor'] };
let dir: string;
let host: ReturnType<typeof Fastify>;
const keysAsked: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'docs-external-assistant-'));
  host = Fastify();
  await buildApp({
    dataDir: dir,
    blob: null,
    pdf: null,
    host: {
      app: host,
      basePath: '/docs',
      authenticate: async (req) => {
        const id = req.headers['x-user'];
        return typeof id === 'string' && id in members ? { id, email: `${id}@x.test` } : null;
      },
      signOut: async () => {},
      userForCookie: async () => null,
      isMember: async (userId, workspaceId) => members[userId]?.includes(workspaceId) ?? false,
      organizationsOf: async (userId) => (members[userId] ?? []).map((id) => ({ id, name: id })),
      assistant: {
        openaiKey: async (req) => {
          keysAsked.push(String(req.headers['x-user']));
          return null;
        },
      },
    },
  });
  await host.ready();
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (who: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object | Buffer, type?: string) => {
  const res = await host.inject({ method, url, headers: { 'x-user': who, ...(type ? { 'content-type': type } : {}) }, ...(payload ? { payload } : {}) });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
};

describe('an assistant the host runs', () => {
  it('serves no chat, turn or assistant settings here, and keeps the jobs', async () => {
    expect((await call('alice', 'GET', '/api/agent?scope=home')).status).toBe(404);
    expect((await call('alice', 'POST', '/api/agent/turn', { message: 'hi', context: { page: 'home' } })).status).toBe(404);
    expect((await call('alice', 'POST', '/api/agent/reset', {})).status).toBe(404);
    expect((await call('alice', 'GET', '/api/settings/assistant')).status).toBe(404);
    expect((await call('alice', 'GET', '/api/agent/jobs')).status).toBe(200);
  });

  it('gives a chat file’s name and root: the organization’s files for a shared one, only to whoever can open it', async () => {
    const shared = (await call('alice', 'POST', '/api/docs?workspace=harbor&shared=1', { title: 'Plan' })).body.doc;
    const mine = (await call('alice', 'POST', '/api/docs?workspace=harbor', { title: 'Diary' })).body.doc;
    expect((await call('bob', 'GET', `/api/places/${shared.id}`)).body).toEqual({ title: 'Plan', kind: 'doc', role: 'editor', place: { workspace: 'harbor', shared: true } });
    expect((await call('alice', 'GET', `/api/places/${mine.id}`)).body).toEqual({ title: 'Diary', kind: 'doc', role: 'owner', place: { workspace: 'harbor', shared: false } });
    expect((await call('bob', 'GET', `/api/places/${mine.id}`)).status).toBe(404);
  });

  it('imports bytes into the root the request names, as import_file did in-process', async () => {
    const made = await call('alice', 'POST', '/api/import/bytes?workspace=harbor&shared=1&filename=notes.md', Buffer.from('# Notes\n\nHello'), 'application/octet-stream');
    expect(made.status).toBe(200);
    expect(made.body.sheet).toMatchObject({ kind: 'markdown', title: 'Notes', workspaceId: 'harbor', shared: true });
    expect((await call('alice', 'POST', '/api/import/bytes?workspace=harbor', Buffer.alloc(0), 'application/octet-stream')).status).toBe(400);
  });

  it('says a PDF cannot be made without the renderer, and asks the host for the person’s OpenAI key to edit a picture', async () => {
    const doc = (await call('alice', 'POST', '/api/docs?workspace=harbor', { title: 'Print me' })).body.doc;
    expect(await call('alice', 'POST', `/api/files/${doc.id}/pdf`, { paper: 'a4' })).toEqual({ status: 400, body: { error: 'PDFs cannot be made here.' } });
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const file = (await host.inject({ method: 'POST', url: '/api/files?workspace=harbor', headers: { 'x-user': 'alice', 'content-type': 'image/png', 'x-filename': 'dot.png' }, payload: png })).json().file;
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const res = await call('alice', 'POST', `/api/files/${file.id}/edit-image`, { prompt: 'make it blue' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/OpenAI API key/);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
    expect(keysAsked).toEqual(['alice']);
  });
});
