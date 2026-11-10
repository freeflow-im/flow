// Email to the organization's members (POST /v1/contacts/email, the email_members tool): a short message from FreeFlow's own
// address, named for the sender ("Ann via FreeFlow") with Reply-To the sender's address, to members of the sender's
// organization only (the sender included: "email it to me"). An address outside the organization is refused here, on the
// server, whatever the model asked for. Attachments come inline from the agent, or by reference to a file the sender can
// open: a Docs file (a stored file as it is; a document, sheet or presentation exported) or a file attached in Chat.
import { z } from 'zod4';
import type { AccountDTO } from '@flow/shared';
import { ApiError } from '../errors';
import { markdownToHtml } from '../imap/mailText';
import type { MailAttachment, OutgoingMail } from '../mail';
import type { CallerContext } from '../org/routes/compat';

export const MAX_RECIPIENTS = 10;
export const MAX_ATTACHMENTS = 10;
/** The decoded bytes of all attachments together: Cloudflare takes 25 MiB a message, base64 and the body included. */
export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;
/** Recipients an account may email in an hour, all calls together. */
export const HOURLY_RECIPIENTS = 50;
export const EXPORT_FORMATS = ['pdf', 'docx', 'xlsx', 'csv', 'pptx', 'md'] as const;

const Attachment = z.object({
  filename: z.string().trim().min(1).max(200).optional(),
  content: z.string().max(25 * 1024 * 1024).optional(),
  encoding: z.enum(['utf8', 'base64']).optional(),
  type: z.string().trim().max(200).optional(),
  docs_file_id: z.string().trim().min(1).max(200).optional(),
  format: z.enum(EXPORT_FORMATS).optional(),
  chat_file_id: z.string().trim().min(1).max(200).optional(),
}).strict().refine((a) => [a.content !== undefined, !!a.docs_file_id, !!a.chat_file_id].filter(Boolean).length === 1, {
  message: 'give exactly one of content, docs_file_id or chat_file_id',
}).refine((a) => a.content === undefined || !!a.filename, { message: 'inline content needs a filename' });

export const EmailBody = z.object({
  to: z.array(z.string().trim().min(1).max(320)).min(1).max(MAX_RECIPIENTS),
  subject: z.string().trim().min(1).max(200),
  body: z.string().max(50_000),
  attachments: z.array(Attachment).max(MAX_ATTACHMENTS).optional(),
}).strict();
export type EmailInput = z.infer<typeof EmailBody>;
export type AttachmentInput = z.infer<typeof Attachment>;

const refuse = (message: string) => new ApiError(400, 'bad_request', message);

/** Someone the caller may email: an active member of their organization with an address (a guest has none). */
export interface Member { accountId: string; name: string; address: string }

export function membersOf(accounts: AccountDTO[]): Member[] {
  return accounts
    .filter((a): a is AccountDTO & { address: string } => a.state !== 'removed' && a.state !== 'suspended' && a.kind !== 'guest' && !!a.address)
    .map((a) => ({ accountId: a.id, name: a.displayName || a.address, address: a.address.toLowerCase() }));
}

/**
 * The members `to` names, each once: "me" (the caller), a member's address, or a member's contact id (`member:<accountId>`,
 * from list_contacts). Anything else is refused, naming it, and nothing is sent.
 */
export function resolveRecipients(to: string[], members: Member[], caller: CallerContext): Member[] {
  const me = caller.account ? members.find((m) => m.accountId === caller.account!.id) : undefined;
  const out = new Map<string, Member>();
  const unknown: string[] = [];
  for (const raw of to) {
    const t = raw.trim().toLowerCase().replace(/^.*<([^>]+)>\s*$/, '$1');
    const m = t === 'me' ? me
      : t.startsWith('member:') ? members.find((x) => x.accountId === raw.trim().slice('member:'.length))
      : members.find((x) => x.address === t);
    if (m) out.set(m.accountId, m);
    else unknown.push(raw);
  }
  if (unknown.length) {
    throw refuse(`${unknown.join(', ')}: not ${unknown.length === 1 ? 'a member' : 'members'} of this organization. Email goes only to its members (find them with list_contacts or find_contact), or to "me".`);
  }
  return [...out.values()];
}

/** How the object reaches the caller's files: a Docs request and a Chat request, each as the caller. */
export interface FileReach {
  docs?: (path: string) => Promise<Response>;
  chat?: (path: string) => Promise<Response>;
}

const TYPES: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', json: 'application/json', pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', ics: 'text/calendar',
};
export const typeOfName = (name: string): string => TYPES[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** The file name a response's Content-Disposition gives (filename* first), or null. */
export function filenameOf(res: Response): string | null {
  const cd = res.headers.get('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
  if (star) { try { return decodeURIComponent(star); } catch { /* the plain one below */ } }
  return /filename="([^"]+)"/i.exec(cd)?.[1] ?? null;
}

const base64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** An answer's bytes, or a refusal naming the file: a 404 is "no such file you can open", whatever the reason. */
async function bytesOf(res: Response, what: string): Promise<Uint8Array> {
  if (res.status === 404 || res.status === 403) throw refuse(`${what}: no such file, or you cannot open it.`);
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string | { message?: string } } | null;
    const msg = typeof err?.error === 'string' ? err.error : err?.error?.message;
    throw refuse(`${what}: ${msg ?? `could not be read (${res.status})`}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** One attachment's name, type and bytes. */
async function load(a: AttachmentInput, reach: FileReach): Promise<{ filename: string; type: string; bytes: Uint8Array }> {
  if (a.content !== undefined) {
    const bytes = a.encoding === 'base64' ? new Uint8Array(Buffer.from(a.content, 'base64')) : new TextEncoder().encode(a.content);
    return { filename: a.filename!, type: a.type || typeOfName(a.filename!), bytes };
  }
  if (a.docs_file_id) {
    const id = a.docs_file_id, what = `Docs file ${id}`;
    if (!reach.docs) throw refuse(`${what}: Docs is not available here.`);
    // A stored file (a PDF, a picture, an upload) goes as it is; a document, sheet or presentation is exported. The two
    // share one id shape, so the stored file is asked for first (its meta answers 404 for anything else).
    const enc = encodeURIComponent(id);
    const stored = (await reach.docs(`/api/files/${enc}/meta`)).ok;
    const res = await reach.docs(stored ? `/api/files/${enc}/download` : `/api/files/${enc}/export${a.format ? `?format=${a.format}` : ''}`);
    const bytes = await bytesOf(res, what);
    const filename = a.filename || filenameOf(res) || id;
    return { filename, type: a.type || res.headers.get('content-type')?.split(';')[0]?.trim() || typeOfName(filename), bytes };
  }
  const id = a.chat_file_id!, what = `Chat file ${id}`;
  if (!reach.chat) throw refuse(`${what}: Chat is not available here.`);
  let res = await reach.chat(`/v1/files/${encodeURIComponent(id)}`);
  // Storage serves the bytes itself: the address is short-lived, and access was checked to make it.
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) res = await fetch(res.headers.get('location')!);
  const bytes = await bytesOf(res, what);
  const filename = a.filename || filenameOf(res) || id;
  const served = res.headers.get('content-type')?.split(';')[0]?.trim();
  return { filename, type: a.type || (served && served !== 'application/octet-stream' ? served : typeOfName(filename)), bytes };
}

/** The attachments, in order, within the limits; the first that cannot be read refuses the whole message. */
export async function loadAttachments(list: AttachmentInput[], reach: FileReach): Promise<MailAttachment[]> {
  const out: MailAttachment[] = [];
  let total = 0;
  for (const a of list) {
    const f = await load(a, reach);
    total += f.bytes.byteLength;
    if (total > MAX_ATTACHMENT_BYTES) throw refuse(`the attachments come to more than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB together; send fewer or smaller files.`);
    out.push({ filename: f.filename.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200), type: f.type, content: base64Of(f.bytes) });
  }
  return out;
}

/** The message to one member: the body as text and HTML, and a line saying who sent it through FreeFlow. */
export function compose(input: Pick<EmailInput, 'subject' | 'body'>, to: Member, sender: { name: string; address: string | null }, attachments: MailAttachment[]): OutgoingMail {
  const who = sender.address ? `${sender.name} (${sender.address})` : sender.name;
  const footer = `Sent through FreeFlow by ${who}.${sender.address ? ' Reply to this email to answer them.' : ''}`;
  return {
    to: to.address,
    subject: input.subject,
    text: `${input.body}\n\n--\n${footer}`,
    html: `${markdownToHtml(input.body)}<hr><p style="color:#666;font-size:12px">${escapeHtml(footer)}</p>`,
    fromName: `${sender.name} via FreeFlow`,
    ...(sender.address ? { replyTo: sender.address } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The sends in the last hour still counting, and whether `n` more fit: times in ms, oldest first. */
export function withinHourly(sent: number[], n: number, now = Date.now()): { kept: number[]; ok: boolean } {
  const kept = sent.filter((t) => now - t < 3_600_000);
  return { kept, ok: kept.length + n <= HOURLY_RECIPIENTS };
}
