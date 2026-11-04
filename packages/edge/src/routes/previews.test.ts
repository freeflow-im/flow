// POST /api/previews/mail (routes/previews.ts): the Worker reads the attachment from the caller's Mail object and hands it to
// the Docs object of their organization, both as the caller; a preview made already is reused without reading it again.
import { describe, expect, it } from 'vitest';
import app, { type Env } from '../index';
import { contentDisposition } from '../imap/convert';

interface Call { object: string; method: string; url: URL; caller?: { userId: string | null }; org?: string; body?: Uint8Array }

function env(opts: { existing?: boolean; attachment?: { status?: number; bytes?: Uint8Array; filename?: string; type?: string } } = {}) {
  const calls: Call[] = [];
  const users: Record<string, { id: string; email: string }> = { 'tok-ann': { id: 'ann', email: 'ann@x.test' }, 'tok-bo': { id: 'bo', email: 'bo@x.test' } };
  const e = {
    ORIGIN_URL: 'https://origin.example',
    EDGE_ORIGIN_SECRET: 's',
    ASSET_HOSTS: '',
    PORTED_HOSTS: 'app.example',
    WEB_URL_BASE: 'https://app.example',
    ORG: {} as never,
    BLOBS: {} as never,
    ASSETS: {} as never,
    DIRECTORY: {
      idFromName: (n: string) => n,
      get: () => ({
        call: async (method: string, args: unknown[]) => {
          if (method === 'authenticate') {
            const user = users[args[0] as string];
            return user ? { ok: true, value: { user, kind: 'session' } } : { ok: false, status: 401, code: 'unauthorized', message: 'no' };
          }
          if (method === 'organizationsOf') return { ok: true, value: args[0] === 'ann' ? ['harbor', 'juniper'] : [] };
          return { ok: true, value: null };
        },
      }),
    },
    MAIL: {
      idFromName: (n: string) => n,
      get: (id: string) => ({
        handle: async (req: Request) => {
          calls.push({ object: `mail:${id}`, method: req.method, url: new URL(req.url) });
          const a = opts.attachment ?? {};
          if (a.status && a.status !== 200) return Response.json({ error: { code: 'not_found', message: 'no such attachment' } }, { status: a.status });
          return new Response((a.bytes ?? new TextEncoder().encode('a,b\n1,2\n')) as Uint8Array<ArrayBuffer>, { headers: { 'content-type': a.type ?? 'text/csv', 'content-disposition': contentDisposition('attachment', a.filename ?? 'Q3 numbers.csv') } });
        },
      }),
    },
    DOCS: {
      idFromName: (n: string) => n,
      get: (id: string) => ({
        handle: async (req: Request, caller: { userId: string | null }, org: string) => {
          calls.push({ object: `docs:${id}`, method: req.method, url: new URL(req.url), caller, org, body: req.method === 'POST' ? new Uint8Array(await req.arrayBuffer()) : undefined });
          if (req.method === 'GET') return Response.json({ preview: opts.existing ? { id: 'old', kind: 'sheet' } : null });
          return Response.json({ preview: { id: 'new', kind: 'sheet' } });
        },
      }),
    },
  };
  return { env: e as unknown as Env, calls };
}

const post = (e: Env, body: unknown, token: string | null = 'tok-ann') =>
  app.request('https://app.example/api/previews/mail', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }, e, { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext);

const ATTACHMENT = { account: 'acc1', folder: 'INBOX', uid: 7, index: 1 };

describe('previewing a mail attachment', () => {
  it('reads the bytes from the caller’s Mail object and gives them to Docs in the organization named, as the caller', async () => {
    const { env: e, calls } = env();
    const res = await post(e, { ...ATTACHMENT, workspace: 'juniper' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ preview: { id: 'new', kind: 'sheet' }, workspace: 'juniper' });
    expect(calls.map((c) => `${c.object} ${c.method} ${c.url.pathname}`)).toEqual(['docs:juniper GET /api/previews', 'mail:ann GET /v1/mail/accounts/acc1/messages/7/attachments/1', 'docs:juniper POST /api/previews']);
    expect(calls[1].url.searchParams.get('folder')).toBe('INBOX');
    const made = calls[2];
    expect(made.caller?.userId).toBe('ann');
    expect(made.org).toBe('juniper');
    expect(Object.fromEntries(made.url.searchParams)).toEqual({ workspace: 'juniper', key: 'mail:acc1:INBOX:7:1', filename: 'Q3 numbers.csv', type: 'text/csv' });
    expect(new TextDecoder().decode(made.body)).toBe('a,b\n1,2\n');
  });

  it('uses the caller’s first organization when none is named, and reuses a preview made already without reading the mail again', async () => {
    const { env: e, calls } = env({ existing: true });
    const res = await post(e, ATTACHMENT);
    expect(await res.json()).toEqual({ preview: { id: 'old', kind: 'sheet' }, workspace: 'harbor' });
    expect(calls.map((c) => c.object)).toEqual(['docs:harbor']);
  });

  it('refuses a stranger, a bad request, someone in no organization, a missing attachment and one too large', async () => {
    expect((await post(env().env, ATTACHMENT, null)).status).toBe(401);
    expect((await post(env().env, { ...ATTACHMENT, uid: 0 })).status).toBe(400);
    expect((await post(env().env, ATTACHMENT, 'tok-bo')).status).toBe(409);
    let res = await post(env({ attachment: { status: 404 } }).env, ATTACHMENT);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such attachment' });
    const big = env({ attachment: { bytes: new Uint8Array(25 * 1024 * 1024 + 1) } });
    res = await post(big.env, ATTACHMENT);
    expect(res.status).toBe(413);
    expect(big.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});
