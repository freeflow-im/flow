// What IMAP and postal-mime answer, turned into the API's shapes (the contract in docs/specs/mail-api.md). Pure, so
// convert.test.ts can feed it what imapflow returns.
import type { FetchMessageObject, ListResponse, MessageAddressObject, MessageStructureObject } from 'imapflow';
import type { Email } from 'postal-mime';
import { listedAttachments, type ListedAttachment } from './body';

export interface Address { name: string; address: string }
export type SpecialUse = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged';
export interface MailFolder { path: string; name: string; delimiter: string; specialUse: SpecialUse | null; unread: number; total: number }
export interface MessageSummary {
  uid: number; folder: string; messageId: string | null;
  from: Address | null; to: Address[]; cc: Address[];
  subject: string; snippet: string; date: string;
  seen: boolean; flagged: boolean; answered: boolean;
  hasAttachments: boolean; size: number;
  /** The files a list row shows as chips (body.ts `listedAttachments`); left out when there are none, or not known. */
  attachments?: ListedAttachment[];
}
export interface AttachmentInfo { index: number; filename: string; mimeType: string; size: number; contentId: string | null; inline: boolean }
export interface MessageDetail extends Omit<MessageSummary, 'attachments'> {
  replyTo: Address[]; bcc: Address[];
  inReplyTo: string | null; references: string[];
  html: string | null; text: string | null;
  attachments: AttachmentInfo[];
}

const address = (a: { name?: string; address?: string }): Address => ({ name: a.name ?? '', address: a.address ?? '' });
const addresses = (list: MessageAddressObject[] | undefined): Address[] => (list ?? []).filter((a) => a.address || a.name).map(address);

function isoDate(...candidates: (Date | string | undefined)[]): string {
  for (const c of candidates) {
    if (!c) continue;
    const d = c instanceof Date ? c : new Date(c);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date(0).toISOString();
}

const SPECIAL: Record<string, SpecialUse> = { '\\inbox': 'inbox', '\\sent': 'sent', '\\drafts': 'drafts', '\\trash': 'trash', '\\junk': 'junk', '\\archive': 'archive', '\\all': 'all', '\\flagged': 'flagged' };
export const specialUseOf = (f: Pick<ListResponse, 'path' | 'specialUse'>): SpecialUse | null =>
  f.path.toUpperCase() === 'INBOX' ? 'inbox' : SPECIAL[(f.specialUse ?? '').toLowerCase()] ?? null;

const SPECIAL_ORDER: SpecialUse[] = ['inbox', 'drafts', 'sent', 'archive', 'all', 'flagged', 'junk', 'trash'];

/** The folders that can hold mail, INBOX first, then the special-use ones, then the rest by path. */
export function toFolders(list: ListResponse[]): MailFolder[] {
  const folders = list
    .filter((f) => !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent'))
    .map((f): MailFolder => ({ path: f.path, name: f.path.toUpperCase() === 'INBOX' ? 'Inbox' : f.name, delimiter: f.delimiter ?? '/', specialUse: specialUseOf(f), unread: f.status?.unseen ?? 0, total: f.status?.messages ?? 0 }));
  const rank = (f: MailFolder) => (f.specialUse ? SPECIAL_ORDER.indexOf(f.specialUse) : SPECIAL_ORDER.length);
  return folders.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

/** Any part a mail reader would list as an attachment: marked so, or a named non-text part not shown inline. */
export function hasAttachments(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.childNodes?.length) return node.childNodes.some(hasAttachments);
  const disposition = (node.disposition ?? '').toLowerCase();
  if (disposition === 'attachment') return true;
  const named = !!(node.dispositionParameters?.filename ?? node.parameters?.name);
  return named && disposition !== 'inline' && !node.type.toLowerCase().startsWith('text/');
}

export interface TextPart { part: string; type: 'text/plain' | 'text/html'; encoding: string; charset: string }

/** The part a snippet is read from: the first text/plain body (else text/html) that is not an attachment. */
export function textPartOf(root: MessageStructureObject | undefined): TextPart | null {
  if (!root) return null;
  const found: Record<string, TextPart | undefined> = {};
  const walk = (node: MessageStructureObject, isRoot: boolean) => {
    if (node.childNodes?.length) { for (const child of node.childNodes) walk(child, false); return; }
    const type = node.type.toLowerCase();
    if ((type !== 'text/plain' && type !== 'text/html') || found[type] || (node.disposition ?? '').toLowerCase() === 'attachment') return;
    found[type] = { part: isRoot ? '1' : node.part ?? '1', type, encoding: (node.encoding ?? '7bit').toLowerCase(), charset: node.parameters?.charset ?? 'utf-8' };
  };
  walk(root, true);
  return found['text/plain'] ?? found['text/html'] ?? null;
}

function decodeQuotedPrintable(s: string): Uint8Array {
  const text = s.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) { out.push(parseInt(text.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(text.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}

function decodeText(bytes: Uint8Array, charset: string): string {
  try { return new TextDecoder(charset.toLowerCase()).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Text from the start of a part, at most ~160 characters, on one line. The bytes may stop mid-character or mid-tag. */
export function snippetOf(raw: Uint8Array, part: TextPart, max = 160): string {
  const latin = new TextDecoder('latin1').decode(raw);
  let bytes: Uint8Array;
  if (part.encoding === 'base64') {
    const clean = latin.replace(/[^A-Za-z0-9+/]/g, '');
    const usable = clean.slice(0, clean.length - (clean.length % 4));
    try { bytes = Uint8Array.from(atob(usable), (ch) => ch.charCodeAt(0)); } catch { bytes = new Uint8Array(); }
  } else if (part.encoding === 'quoted-printable') bytes = decodeQuotedPrintable(latin.replace(/=[0-9A-Fa-f]?$/, ''));
  else bytes = raw;
  let text = decodeText(bytes, part.charset).replace(/\uFFFD+$/, '');
  if (part.type === 'text/html') {
    text = text.replace(/<(style|script|head)[\s\S]*?(<\/\1>|$)/gi, ' ').replace(/<[^>]*(>|$)/g, ' ')
      .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()] ?? m);
  } else {
    // Quoted replies and signatures-only lines make poor previews; drop the quoted lines.
    text = text.split(/\r?\n/).filter((l) => !l.startsWith('>')).join(' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** One message as a list shows it, from a FETCH of uid, envelope, flags, bodyStructure, size and internalDate. */
export function toSummary(m: FetchMessageObject, folder: string, snippet = ''): MessageSummary {
  const env = m.envelope ?? {};
  const attachments = listedAttachments(m.bodyStructure);
  const flags = m.flags ?? new Set<string>();
  const from = env.from?.[0] ?? env.sender?.[0];
  return {
    uid: m.uid,
    folder,
    messageId: env.messageId ?? null,
    from: from ? address(from) : null,
    to: addresses(env.to),
    cc: addresses(env.cc),
    subject: env.subject ?? '',
    snippet,
    date: isoDate(env.date, m.internalDate),
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    hasAttachments: hasAttachments(m.bodyStructure),
    size: m.size ?? 0,
    ...(attachments ? { attachments } : {}),
  };
}

const byteLength = (c: ArrayBuffer | Uint8Array | string) => (typeof c === 'string' ? new TextEncoder().encode(c).length : c.byteLength);
export const bareId = (id: string | undefined | null) => (id ? id.trim().replace(/^<|>$/g, '') : null);

/**
 * A message opened: the list's fields, with the parsed bodies and the attachments. `attachments` is given when the message
 * was opened by its parts (body.ts), which postal-mime then never saw; otherwise they are postal-mime's.
 */
export function toDetail(summary: MessageSummary, email: Email, attachments?: AttachmentInfo[]): MessageDetail {
  const references = (email.references ?? '').split(/\s+/).filter(Boolean);
  const text = email.text ?? null;
  return {
    ...summary,
    from: summary.from ?? (email.from?.address ? address(email.from) : null),
    snippet: summary.snippet || (text ? snippetOf(new TextEncoder().encode(text.slice(0, 600)), { part: '1', type: 'text/plain', encoding: '8bit', charset: 'utf-8' }) : ''),
    replyTo: (email.replyTo ?? []).filter((a): a is Address => 'address' in a && !!a.address).map(address),
    bcc: (email.bcc ?? []).filter((a): a is Address => 'address' in a && !!a.address).map(address),
    inReplyTo: email.inReplyTo?.trim() || null,
    references,
    html: email.html ?? null,
    text,
    attachments: attachments ?? email.attachments.map((a, index) => ({
      index,
      filename: a.filename ?? `attachment-${index + 1}`,
      mimeType: a.mimeType || 'application/octet-stream',
      size: byteLength(a.content as ArrayBuffer),
      contentId: bareId(a.contentId),
      inline: a.disposition === 'inline' || !!a.related,
    })),
  };
}

/** The file name a Content-Disposition header gives (RFC 6266: `filename*` first, as `contentDisposition` writes it), or null. */
export function filenameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*([\w-]+)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      const name = decodeURIComponent(star[2]!.trim());
      if (name) return name;
    } catch {
      // A malformed escape: the plain name below.
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
  return (plain?.[1]?.replace(/\\(.)/g, '$1') ?? plain?.[2]?.trim()) || null;
}

/** `filename*=` for Content-Disposition (RFC 6266/5987), with a plain ASCII fallback. */
export function contentDisposition(kind: 'attachment' | 'inline', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
