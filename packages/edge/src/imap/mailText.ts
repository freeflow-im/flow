// Mail as agents read and write it (the Mail tools, imap/mailTools.ts): a message's HTML as readable text with its links
// kept, a body written in Markdown as the HTML and text of a message, and what Reply, Reply all and Forward put in a new
// one (the server's copy of packages/mail/src/lib/compose.ts: the recipients, "Re:"/"Fwd:", the original quoted, and
// In-Reply-To and References). Pure, so mailText.test.ts can check each.
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import type { Address, MessageDetail } from './convert';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', zwnj: '', zwj: '', shy: '' };

const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null;
};

/**
 * What a reader of an email sees, as plain text: paragraphs, line breaks, list items and table cells, with no markup,
 * scripts, styles or hidden preheaders; a link as `text (address)`, or just the address when that is its text. Nothing
 * here runs or fetches anything: it is string work on the HTML.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|noscript|template|svg|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    // Preheaders and other text hidden from the reader.
    .replace(/<(div|span|p)\b[^>]*style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
      const href = attr(`<a ${attrs}>`, 'href')?.trim() ?? '';
      const text = decode(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      if (!/^(https?:|mailto:)/i.test(href)) return text;
      const shown = href.replace(/^mailto:/i, '');
      if (!text) return shown;
      return text === href || text === shown || text.replace(/\/$/, '') === href.replace(/\/$/, '') ? text : `${text} (${shown})`;
    })
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const alt = attr(tag, 'alt')?.trim();
      return alt ? `[${alt}]` : '';
    })
    .replace(/<h([1-6])\b[^>]*>/gi, '\n\n')
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' ')
    .replace(/<\/?(p|div|section|article|header|footer|main|nav|aside|ul|ol|table|tr|blockquote|pre|figure|figcaption|dl|dt|dd|hr|form|fieldset|center)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  s = decode(s)
    .split('\n')
    .map((l) => l.replace(/[ \t ​͏]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}

/** A message's body as text: its HTML made readable when it has one, else its plain text. */
export function bodyText(m: Pick<MessageDetail, 'html' | 'text'>): string {
  if (m.html && m.html.trim()) return htmlToText(m.html);
  return (m.text ?? '').replace(/\r\n/g, '\n').trim();
}

/** At most `max` characters, cut at a line or word where one is near, with whether it was cut. */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return { text: at > max * 0.9 ? cut.slice(0, at) : cut, truncated: true };
}

export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Plain text as HTML: escaped, paragraphs and line breaks kept. */
export const textToHtml = (text: string): string =>
  text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

/** What a message's HTML may hold: formatting, links, tables, and pictures only when they are in the message itself. */
const MAIL_HTML: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'img', 'sub', 'sup'],
  allowedAttributes: { a: ['href', 'title'], img: ['src', 'alt', 'width', 'height'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['data', 'cid'] },
};

/** A body written in Markdown, as a message's HTML. Raw HTML in it is shown as text, never passed through. */
export function markdownToHtml(markdown: string): string {
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: true, renderer }) as string;
  return sanitizeHtml(html, MAIL_HTML);
}

/** An address as a person reads it: `Ann Lee <ann@example.com>`, or the address alone. */
export const formatAddress = (a: Address): string => (a.name ? `${/[",;<>@()]/.test(a.name) ? `"${a.name.replace(/"/g, '\\"')}"` : a.name} <${a.address}>` : a.address);

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
/** An address an agent wrote, `ann@example.com` or `Ann Lee <ann@example.com>`; null if it is not one. */
export function parseAddress(input: string): Address | null {
  const s = input.trim();
  const angled = /^(.*?)<\s*([^<>\s]+)\s*>$/.exec(s);
  if (angled) {
    const address = angled[2]!;
    if (!EMAIL.test(address)) return null;
    return { name: angled[1]!.trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"').trim(), address };
  }
  const bare = s.replace(/^mailto:/i, '');
  return EMAIL.test(bare) ? { name: '', address: bare } : null;
}

/** Each address once (by address, ignoring case), leaving out those in `except`. */
export function uniqueAddresses(list: Address[], except: string[] = []): Address[] {
  const seen = new Set(except.map((e) => e.toLowerCase()));
  const out: Address[] = [];
  for (const a of list) {
    const k = a.address.toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

/** "Re: Lunch", without stacking another "Re:" on one already there. */
export const replySubject = (subject: string): string => (/^re\s*:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`);
export const forwardSubject = (subject: string): string => (/^(fwd?|fw)\s*:/i.test(subject.trim()) ? subject.trim() : `Fwd: ${subject.trim()}`);

const longDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toUTCString();
};

/** What a reply or forward starts with: its recipients, subject, threading, and the original quoted (as HTML and as text). */
export interface Prefill {
  to: Address[];
  cc: Address[];
  subject: string;
  inReplyTo?: string;
  references?: string[];
  quoteHtml: string;
  quoteText: string;
}

/** The original's body to quote: its HTML cleaned (no scripts, no remote pictures), or its text. */
const quotedHtml = (m: MessageDetail): string => (m.html?.trim() ? sanitizeHtml(m.html, MAIL_HTML) : textToHtml(m.text ?? ''));
const quotedLines = (text: string): string => text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

/** A reply to `m` (to everyone on it with `all`), or a forward of it, sent from `me`. */
export function prefill(mode: 'reply' | 'replyAll' | 'forward', m: MessageDetail, me: string): Prefill {
  const text = bodyText(m);
  if (mode === 'forward') {
    const lines = [
      '---------- Forwarded message ---------',
      `From: ${m.from ? formatAddress(m.from) : ''}`,
      `Date: ${longDate(m.date)}`,
      `Subject: ${m.subject}`,
      `To: ${m.to.map(formatAddress).join(', ')}`,
      ...(m.cc.length ? [`Cc: ${m.cc.map(formatAddress).join(', ')}`] : []),
    ];
    return {
      to: [],
      cc: [],
      subject: forwardSubject(m.subject),
      quoteHtml: `<p>${lines.map(escapeHtml).join('<br>')}</p>${quotedHtml(m)}`,
      quoteText: `${lines.join('\n')}\n\n${text}`,
    };
  }
  const references = [...m.references, ...(m.messageId ? [m.messageId] : [])].filter((r, i, all) => all.indexOf(r) === i);
  const sender = m.replyTo.length ? m.replyTo : m.from ? [m.from] : [];
  // Replying to your own message goes to the people it went to, as mail apps do.
  const fromMe = m.from?.address.toLowerCase() === me.toLowerCase();
  const to = fromMe && m.replyTo.length === 0 ? uniqueAddresses(m.to) : uniqueAddresses(sender);
  const cc = mode === 'replyAll' ? uniqueAddresses([...(fromMe ? [] : m.to), ...m.cc], [me, ...to.map((a) => a.address)]) : [];
  const who = m.from ? formatAddress(m.from) : 'someone';
  const intro = `On ${longDate(m.date)}, ${who} wrote:`;
  return {
    to,
    cc,
    subject: replySubject(m.subject),
    ...(m.messageId ? { inReplyTo: m.messageId, references } : {}),
    quoteHtml: `<p>${escapeHtml(intro)}</p><blockquote>${quotedHtml(m)}</blockquote>`,
    quoteText: `${intro}\n${quotedLines(text)}`,
  };
}
