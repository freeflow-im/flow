// A mail attachment previewed in Docs (packages/docs/server/previews.ts): POST /api/previews/mail names the attachment, and
// the Worker gets its bytes from the caller's own Mail object and hands them to the Docs object of the organization the
// caller named (Mail's selected organization, else their first), each as the caller. The browser never uploads the file.
// Opening the same attachment again finds the preview already made before any bytes are fetched.
import { Hono } from 'hono';
import type { Mail } from '../imap/object';
import { filenameFromDisposition } from '../imap/convert';
import { directory } from './auth';
import { who, type C, type DocsRouteEnv } from './docs';

export interface PreviewRouteEnv extends DocsRouteEnv { MAIL: DurableObjectNamespace<Mail> }

/** The largest attachment previewed (Docs' MAX_PREVIEW_BYTES). */
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

export const previewRoutes = new Hono<{ Bindings: PreviewRouteEnv }>();

const fail = (status: number, error: string) => Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });

previewRoutes.post('/api/previews/mail', async (c) => {
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
  const found = await read(await docsCall('/api/previews', { key }));
  if (!found.res.ok || found.body.preview) return answer(found);

  const mail = await c.env.MAIL.get(c.env.MAIL.idFromName(caller.userId)).handle(
    new Request(`${origin}/v1/mail/accounts/${encodeURIComponent(account)}/messages/${uid}/attachments/${index}?${new URLSearchParams({ folder })}`),
  );
  if (!mail.ok) {
    const err = (await mail.json().catch(() => null)) as { error?: { message?: string } } | null;
    return fail(mail.status, err?.error?.message ?? 'The attachment could not be read from the mail server.');
  }
  const declared = Number(mail.headers.get('content-length'));
  if (declared > MAX_PREVIEW_BYTES) return fail(413, 'This file is too large to preview (25 MB maximum). Download it instead.');
  const bytes = new Uint8Array(await mail.arrayBuffer());
  if (bytes.length > MAX_PREVIEW_BYTES) return fail(413, 'This file is too large to preview (25 MB maximum). Download it instead.');
  const filename = filenameFromDisposition(mail.headers.get('content-disposition')) ?? `attachment-${(index as number) + 1}`;
  const type = (mail.headers.get('content-type') ?? '').split(';')[0]!.trim();
  return answer(await read(await docsCall('/api/previews', { key, filename, type }, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes })));
});
