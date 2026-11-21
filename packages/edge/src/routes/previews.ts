// A mail attachment previewed in Docs (packages/docs/server/previews.ts): POST /api/previews/mail names the attachment, and
// the Worker gets its bytes from the Mail object of the caller's account in the organization the caller named (Mail's
// selected organization, else their first) and hands them to that organization's Docs object, each as the caller. The browser never uploads the file.
// Opening the same attachment again finds the preview already made before any bytes are fetched.
import { Hono, type Context } from 'hono';
import type { Mail } from '../imap/object';
import { filenameFromDisposition } from '../imap/convert';
import { directory, resolveCaller } from './auth';
import { who, type C, type DocsRouteEnv } from './docs';
import { TIMING_HEADER } from '../imap/rules';
import { isolate, parseParts, rayOf, coloOf, type Parts } from '../perf';

export interface PreviewRouteEnv extends DocsRouteEnv { MAIL: DurableObjectNamespace<Mail> }

/** The largest attachment previewed (Docs' MAX_PREVIEW_BYTES). */
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

export const previewRoutes = new Hono<{ Bindings: PreviewRouteEnv }>();

const fail = (status: number, error: string) => Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });

/**
 * Where a preview's time went, step by step (scripts/perf/README.md § Stored logs): `lookup` (asking Docs for one made
 * already), `auth` (the caller's Mail account), `mail` (reading the attachment from the Mail object: its `lock` wait and
 * `imap` time inside it, `read` and `bytes`), `store` (Docs keeping it, and converting what is not a PDF).
 */
interface Steps { lookup?: number; auth?: number; mail?: number; store?: number; found?: boolean; kind?: string; parts: Parts }

async function step<T>(steps: Steps, name: 'lookup' | 'auth' | 'mail' | 'store', run: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try { return await run(); } finally { steps[name] = (steps[name] ?? 0) + Date.now() - start; }
}

/** The `Server-Timing` header of a preview: its total, each step, and the Mail object's split of its step. */
export function previewTiming(totalMs: number, s: Steps, ray: string | null): string {
  const items = [`total;dur=${totalMs}`];
  for (const k of ['lookup', 'auth', 'mail', 'store'] as const) if (s[k] !== undefined) items.push(`${k};dur=${s[k]}`);
  if (s.parts.wait !== undefined) items.push(`lock;dur=${s.parts.wait}`);
  if (s.parts.imap !== undefined) items.push(`imap;dur=${s.parts.imap}`);
  if (s.parts.read) items.push(`read;desc=${s.parts.read}`);
  if (s.parts.bytes !== undefined) items.push(`bytes;desc=${s.parts.bytes}`);
  if (s.found) items.push('cache;desc=hit');
  if (ray && /^[\w-]+$/.test(ray)) items.push(`ray;desc=${ray}`);
  return items.join(', ');
}

previewRoutes.post('/api/previews/mail', async (c) => {
  const start = Date.now();
  const steps: Steps = { parts: {} };
  let status = 500;
  try {
    const res = await preview(c, steps);
    status = res.status;
    res.headers.set('Server-Timing', previewTiming(Date.now() - start, steps, rayOf(c.req.raw)));
    return res;
  } finally {
    const ms = Date.now() - start;
    const { parts, ...rest } = steps;
    const split = ['lookup', 'auth', 'mail', 'store'].filter((k) => rest[k as 'mail'] !== undefined).map((k) => `${k} ${rest[k as 'mail']}ms`).join(', ');
    console.log({
      message: `[previews] POST /api/previews/mail ${status} ${ms}ms (${split}${parts.bytes !== undefined ? `, ${parts.bytes} bytes` : ''}${steps.found ? ', made already' : ''})`,
      perf: 'request', app: 'mail', route: 'POST /api/previews/mail', status, ms, ...rest, ...parts, ray: rayOf(c.req.raw), colo: coloOf(c.req.raw), ...isolate(),
    });
  }
});

async function preview(c: Context<{ Bindings: PreviewRouteEnv }>, steps: Steps): Promise<Response> {
  const caller = await who(c as unknown as C);
  if (!caller.userId) return fail(401, 'Not signed in');
  const b = (await c.req.json().catch(() => null)) as { account?: unknown; folder?: unknown; uid?: unknown; index?: unknown; workspace?: unknown } | null;
  const { account, folder, uid, index } = b ?? {};
  if (typeof account !== 'string' || !account || typeof folder !== 'string' || !folder || !Number.isInteger(uid) || (uid as number) < 1 || !Number.isInteger(index) || (index as number) < 0) {
    return fail(400, 'Name the attachment: account, folder, uid and index.');
  }
  const named = typeof b?.workspace === 'string' && b.workspace ? b.workspace : null;
  const organization = named ?? (await directory(c, 'organizationsOf', caller.userId))[0] ?? null;
  if (!organization) return fail(409, 'Previews open in Workspace, which needs an organization. Create or join one, or download the file.');

  const origin = new URL(c.req.url).origin;
  const docs = c.env.DOCS.get(c.env.DOCS.idFromName(organization));
  const key = `mail:${account}:${folder}:${uid}:${index}`;
  const docsCall = (path: string, params: Record<string, string>, init?: RequestInit) =>
    docs.handle(new Request(`${origin}${path}?${new URLSearchParams({ workspace: organization, ...params })}`, init), caller, organization);
  const read = async (res: Response) => ({ res, body: (await res.json().catch(() => ({ error: 'Docs did not answer.' }))) as Record<string, unknown> });
  const answer = ({ res, body }: Awaited<ReturnType<typeof read>>) =>
    Response.json(res.ok ? { ...body, workspace: organization } : body, { status: res.status, headers: { 'cache-control': 'no-store' } });

  // Made already (this attachment, this hour): no need to read it from the mail server again. Docs also refuses here an
  // organization the caller is not in.
  const found = await step(steps, 'lookup', async () => read(await docsCall('/api/previews', { key })));
  if (found.body.preview) steps.found = true;
  if (!found.res.ok || found.body.preview) return answer(found);

  // Mail is the account's, in the same organization (platform.md §3.6).
  const mailCaller = await step(steps, 'auth', () => resolveCaller(c, organization));
  if (!mailCaller.account) return fail(403, 'Join an organization to use Mail.');
  // The bytes are read inside the step too: the object streams them.
  let bytes = new Uint8Array();
  const mail = await step(steps, 'mail', async () => {
    const res = await c.env.MAIL.get(c.env.MAIL.idFromName(mailCaller.account!.id)).handle(
      new Request(`${origin}/v1/mail/accounts/${encodeURIComponent(account)}/messages/${uid}/attachments/${index}?${new URLSearchParams({ folder })}`),
      mailCaller,
    );
    steps.parts = parseParts(res.headers.get(TIMING_HEADER));
    if (res.ok && !(Number(res.headers.get('content-length')) > MAX_PREVIEW_BYTES)) bytes = new Uint8Array(await res.arrayBuffer());
    return res;
  });
  if (!mail.ok) {
    const err = (await mail.json().catch(() => null)) as { error?: { message?: string } } | null;
    return fail(mail.status, err?.error?.message ?? 'The attachment could not be read from the mail server.');
  }
  const declared = Number(mail.headers.get('content-length'));
  if (declared > MAX_PREVIEW_BYTES) return fail(413, 'This file is too large to preview (25 MB maximum). Download it instead.');
  if (bytes.length > MAX_PREVIEW_BYTES) return fail(413, 'This file is too large to preview (25 MB maximum). Download it instead.');
  const filename = filenameFromDisposition(mail.headers.get('content-disposition')) ?? `attachment-${(index as number) + 1}`;
  const type = (mail.headers.get('content-type') ?? '').split(';')[0]!.trim();
  steps.kind = type || undefined;
  return answer(await step(steps, 'store', async () => read(await docsCall('/api/previews', { key, filename, type }, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes }))));
}
