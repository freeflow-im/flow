// DKIM verification (RFC 6376) of a received message, for the assistant's sender allowlist (agents.md §1.1, allowlist.ts).
// The receiving server's own verdict is the usual source, but MXRoute writes none in Authentication-Results: it adds
// X-DKIM and X-DMARC-Status headers at the end of the header block, without removing copies a sender wrote, so they can
// be forged. Checking the signature here needs only the message and the signer's public key in DNS.
//
// rsa-sha256 only (what Gmail, Outlook and most providers sign with); a signature with `l=` (a body length, which lets
// text be appended unsigned) or past its `x=` expiry does not pass.
import type { Resolve } from '../directory/dns';

export interface DkimResult { domain: string; selector: string; pass: boolean; reason?: string }

/** A string's characters as bytes (the message is read as latin1, one byte per character). */
function bytes(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function base64(s: string): Uint8Array<ArrayBuffer> {
  return bytes(atob(s.replace(/\s+/g, '')));
}

function toBase64(buf: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

/** The header fields, each as written (folding kept, no final CRLF), and the body, with CRLF line ends. */
export function splitMessage(raw: string): { fields: string[]; body: string } {
  // Line ends as signed (RFC 6376 §3.4): CRLF, a bare LF taken as one.
  const text = raw.replace(/\r?\n/g, '\r\n');
  const end = text.indexOf('\r\n\r\n');
  const head = end < 0 ? text : text.slice(0, end);
  const body = end < 0 ? '' : text.slice(end + 4);
  const fields: string[] = [];
  for (const line of head.split('\r\n')) {
    if (/^[ \t]/.test(line) && fields.length) fields[fields.length - 1] += `\r\n${line}`;
    else if (line) fields.push(line);
  }
  return { fields, body };
}

const nameOf = (field: string) => field.slice(0, field.indexOf(':')).trim().toLowerCase();

/** The tag=value list of a DKIM-Signature or a key record. */
export function tags(value: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of value.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).replace(/\r\n/g, '').trim());
  }
  return out;
}

function canonHeader(field: string, relaxed: boolean): string {
  if (!relaxed) return field;
  const i = field.indexOf(':');
  return `${field.slice(0, i).trim().toLowerCase()}:${field.slice(i + 1).replace(/\r\n/g, '').replace(/[ \t]+/g, ' ').trim()}`;
}

function canonBody(body: string, relaxed: boolean): string {
  let lines = body.split('\r\n');
  if (relaxed) lines = lines.map((l) => l.replace(/[ \t]+/g, ' ').replace(/ $/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return relaxed ? '' : '\r\n';
  return `${lines.join('\r\n')}\r\n`;
}

/** The public key a selector publishes, or why there is none. */
async function publicKey(resolve: Resolve, selector: string, domain: string): Promise<CryptoKey | string> {
  const records = await resolve(`${selector}._domainkey.${domain}`, 'TXT').catch(() => [] as string[]);
  const record = records.map((r) => tags(r)).find((t) => t.has('p'));
  if (!record) return 'no key record';
  if ((record.get('k') ?? 'rsa').toLowerCase() !== 'rsa') return 'not an rsa key';
  const p = record.get('p')!.replace(/\s+/g, '');
  if (!p) return 'key revoked';
  try {
    return await crypto.subtle.importKey('spki', base64(p), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  } catch {
    return 'bad key';
  }
}

async function verifyOne(fields: string[], body: string, index: number, resolve: Resolve, now: number): Promise<DkimResult> {
  const field = fields[index]!;
  const t = tags(field.slice(field.indexOf(':') + 1));
  const domain = (t.get('d') ?? '').toLowerCase(), selector = t.get('s') ?? '';
  const fail = (reason: string): DkimResult => ({ domain, selector, pass: false, reason });
  if (t.get('v') !== '1' || !domain || !selector || !t.get('b') || !t.get('bh') || !t.get('h')) return fail('incomplete signature');
  if ((t.get('a') ?? '').toLowerCase() !== 'rsa-sha256') return fail('not rsa-sha256');
  if (t.has('l')) return fail('body length limit');
  const x = Number(t.get('x'));
  if (t.has('x') && Number.isFinite(x) && x * 1000 < now) return fail('expired');
  const [hc = 'simple', bc = 'simple'] = (t.get('c') ?? 'simple/simple').toLowerCase().split('/');
  // The body hash.
  const bh = toBase64(await crypto.subtle.digest('SHA-256', bytes(canonBody(body, bc === 'relaxed'))));
  if (bh !== t.get('bh')!.replace(/\s+/g, '')) return fail('body hash mismatch');
  // The signed headers, each name taking the next occurrence from the bottom, then this signature without its b= value.
  const used = new Set<number>();
  let data = '';
  for (const name of t.get('h')!.split(':').map((n) => n.trim().toLowerCase()).filter(Boolean)) {
    for (let i = fields.length - 1; i >= 0; i--) {
      if (used.has(i) || i === index || nameOf(fields[i]!) !== name) continue;
      used.add(i);
      data += `${canonHeader(fields[i]!, hc === 'relaxed')}\r\n`;
      break;
    }
  }
  data += canonHeader(field.replace(/(^|;)(\s*b\s*=)[^;]*/i, '$1$2'), hc === 'relaxed');
  const key = await publicKey(resolve, selector, domain);
  if (typeof key === 'string') return fail(key);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64(t.get('b')!), bytes(data)).catch(() => false);
  return ok ? { domain, selector, pass: true } : fail('signature mismatch');
}

/** Every DKIM-Signature of a raw message (read as latin1), checked. */
export async function verifyDkim(raw: string, resolve: Resolve, now = Date.now()): Promise<DkimResult[]> {
  const { fields, body } = splitMessage(raw);
  const out: DkimResult[] = [];
  for (let i = 0; i < fields.length; i++) {
    if (nameOf(fields[i]!) === 'dkim-signature') out.push(await verifyOne(fields, body, i, resolve, now));
  }
  return out;
}
