// Opening a message without downloading all of it (docs/specs/mail-api.md, "Opening a message"). Pure, so body.test.ts can
// feed it structures and part bytes.
//
// `planBody` walks the BODYSTRUCTURE the way postal-mime walks a parsed message: the inline text/plain and text/html leaves
// are the bodies, every other non-empty leaf is an attachment, numbered in that order (the `index` of the API). The
// object then FETCHes only the bodies (and the small parts, see `prefetch`), and `minimalMessage` rebuilds a message of the
// same multipart tree holding just those bodies, which postal-mime parses as it did the whole message: the same text, the
// same HTML (made from the text when there is none, and the other way round), the same charsets and format=flowed.
//
// A structure postal-mime would read differently from its parts alone (an inline message/rfc822, whose text and
// attachments it folds into the message's own) is not `simple`: such a message is read in full, as before.
import type { MessageStructureObject } from 'imapflow';

export interface BodyLeaf {
  /** The BODY[...] section: the part number, or TEXT for a message that is not multipart. */
  section: string;
  type: string;
  encoding: string;
  parameters: Record<string, string>;
  disposition: string | null;
  id: string | null;
  /** Encoded octets, as BODYSTRUCTURE gives it. */
  size: number;
}
export interface PlannedAttachment {
  index: number;
  leaf: BodyLeaf;
  filename: string;
  mimeType: string;
  contentId: string | null;
  inline: boolean;
}
interface PlanNode { leaf?: BodyLeaf; multipart?: string; children?: PlanNode[] }
export interface BodyPlan {
  simple: boolean;
  /** The inline text leaves, in order. */
  texts: BodyLeaf[];
  attachments: PlannedAttachment[];
  /** The tree with only the text leaves, for `minimalMessage`. */
  tree: PlanNode | null;
}

const lower = (s: string | undefined | null) => (s ?? '').toLowerCase().trim();
const bare = (id: string | undefined | null) => (id ? id.trim().replace(/^<|>$/g, '') : null);

export function planBody(root: MessageStructureObject | undefined): BodyPlan {
  if (!root) return { simple: false, texts: [], attachments: [], tree: null };
  let simple = true;
  const texts: BodyLeaf[] = [];
  const attachments: PlannedAttachment[] = [];
  const walk = (node: MessageStructureObject, isRoot: boolean, related: boolean): PlanNode | null => {
    const type = lower(node.type) || 'text/plain';
    if (type.startsWith('multipart/') && node.childNodes?.length) {
      const inRelated = related || type === 'multipart/related';
      const children = node.childNodes.map((child) => walk(child, false, inRelated)).filter((n): n is PlanNode => !!n);
      return children.length ? { multipart: type.slice('multipart/'.length), children } : null;
    }
    const disposition = lower(node.disposition) || null;
    const leaf: BodyLeaf = {
      section: isRoot ? 'TEXT' : node.part ?? '1', type, encoding: lower(node.encoding) || '7bit',
      parameters: Object.fromEntries(Object.entries(node.parameters ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
      disposition, id: node.id ?? null, size: node.size ?? 0,
    };
    if (type === 'message/rfc822' && disposition !== 'attachment') simple = false;
    if ((type === 'text/plain' || type === 'text/html') && disposition !== 'attachment') {
      texts.push(leaf);
      return { leaf };
    }
    // postal-mime leaves out an empty part; so does the list.
    if (!leaf.size) return null;
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
    const index = attachments.length;
    attachments.push({
      index, leaf, filename: filename || `attachment-${index + 1}`, mimeType: type || 'application/octet-stream',
      contentId: bare(node.id), inline: disposition === 'inline' || (related && !!node.id),
    });
    return null;
  };
  const tree = walk(root, true, false);
  return { simple, texts, attachments, tree };
}

/** A part's size once decoded, from its encoded size: exact for what is not encoded, close for base64 (76-character lines). */
export function decodedSize(leaf: BodyLeaf): number {
  if (leaf.encoding === 'base64') return Math.max(0, Math.round((leaf.size * 76) / 78 * 0.75));
  return leaf.size;
}

/** The parts worth fetching with the bodies: inline (cid:) pictures and other small parts, within a budget. */
export function prefetch(attachments: PlannedAttachment[], opts: { inlineMax: number; smallMax: number; total: number }): PlannedAttachment[] {
  const out: PlannedAttachment[] = [];
  let used = 0;
  const take = (a: PlannedAttachment) => {
    if (used + a.leaf.size > opts.total) return;
    used += a.leaf.size;
    out.push(a);
  };
  for (const a of attachments) if (a.inline && a.contentId && /^image\//.test(a.mimeType) && a.leaf.size <= opts.inlineMax) take(a);
  for (const a of attachments) if (!out.includes(a) && a.leaf.size <= opts.smallMax) take(a);
  return out.sort((x, y) => x.index - y.index);
}

/** Undoes a part's Content-Transfer-Encoding. */
export function decodeTransfer(raw: Uint8Array, encoding: string): Buffer {
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (encoding === 'base64') return Buffer.from(buf.toString('latin1'), 'base64');
  if (encoding === 'quoted-printable') return decodeQP(buf);
  return Buffer.from(buf);
}

function decodeQP(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length);
  let o = 0;
  const hex = (c: number) => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1);
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c !== 61) { out[o++] = c; continue; }
    // A soft line break: '=' then (spaces and) a line end.
    let j = i + 1;
    while (j < buf.length && (buf[j] === 32 || buf[j] === 9)) j++;
    if (j < buf.length && (buf[j] === 13 || buf[j] === 10)) { i = buf[j] === 13 && buf[j + 1] === 10 ? j + 1 : j; continue; }
    if (j >= buf.length) { i = j; continue; }
    const a = hex(buf[i + 1] ?? 0), b = hex(buf[i + 2] ?? 0);
    if (a >= 0 && b >= 0) { out[o++] = a * 16 + b; i += 2; } else out[o++] = c;
  }
  return out.subarray(0, o);
}

/** A header parameter value, quoted, with nothing that could end the header or the quotes. */
const param = (v: string) => `"${v.replace(/[\r\n"\\]/g, ' ')}"`;
const CRLF = '\r\n';

/**
 * A message postal-mime can parse in place of the original: `headers` (the original's own, for Reply-To, In-Reply-To and
 * the like), then the multipart tree of the text leaves with each one's bytes as the server holds them (still encoded).
 */
export function minimalMessage(headers: Uint8Array | string | undefined, plan: BodyPlan, bodies: Map<string, Uint8Array>): Buffer {
  const chunks: Buffer[] = [];
  const push = (s: string | Uint8Array) => chunks.push(typeof s === 'string' ? Buffer.from(s, 'latin1') : Buffer.from(s));
  const head = (typeof headers === 'string' ? headers : Buffer.from(headers ?? new Uint8Array()).toString('latin1')).replace(/(\r?\n)+$/, '');
  // The original's own MIME headers describe the whole message; ours describe what is here.
  const kept = head ? head.split(/\r?\n(?![ \t])/).filter((h: string) => !/^(content-[\w-]+|mime-version)\s*:/i.test(h)).join(CRLF) : '';
  if (kept) push(kept + CRLF);
  push(`MIME-Version: 1.0${CRLF}`);
  let n = 0;
  const node = (p: PlanNode | null) => {
    if (!p) {
      // No text at all (a message that is one attachment): an empty part, which postal-mime leaves out as it did.
      push(`Content-Type: application/octet-stream${CRLF}${CRLF}`);
      return;
    }
    if (p.leaf) {
      const l = p.leaf;
      const params = ['charset', 'format', 'delsp'].filter((k) => l.parameters[k]).map((k) => `; ${k}=${param(l.parameters[k])}`).join('');
      push(`Content-Type: ${l.type}${params}${CRLF}Content-Transfer-Encoding: ${l.encoding.replace(/[^\w-]/g, '')}${CRLF}`);
      if (l.disposition) push(`Content-Disposition: ${l.disposition.replace(/[^\w-]/g, '')}${CRLF}`);
      push(CRLF);
      push(bodies.get(l.section) ?? new Uint8Array());
      return;
    }
    const boundary = `=_ff_${++n}_${crypto.randomUUID()}`;
    push(`Content-Type: multipart/${(p.multipart ?? 'mixed').replace(/[^\w-]/g, '')}; boundary="${boundary}"${CRLF}${CRLF}`);
    for (const child of p.children ?? []) {
      push(`${CRLF}--${boundary}${CRLF}`);
      node(child);
    }
    push(`${CRLF}--${boundary}--${CRLF}`);
  };
  node(plan.tree);
  return Buffer.concat(chunks);
}
