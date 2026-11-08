// The agent's mailbox (platform.md §3.3, phase 5.4): the turn mail from a member starts (`mailPrompt`), and six tools on
// the `flow` MCP server — list_mail, search_mail, read_mail, send_mail, move_mail, mark_mail — calling /v1/mail/* as the
// agent's account in the organization the bridge serves (`?workspace=`), on its hosted mailbox (the first `kind: 'hosted'`
// account). The names and arguments are those of the Mail tools on /mcp (packages/edge/src/imap/mailTools.ts), so an agent
// sees the same tools at both doors; message ids are theirs too, `<accountId>:<folder>:<uid>`. Kept apart from
// mcp-server.ts so the suite runs them against a fake server.
import type { FlowApi } from './api.js';

/** The data of a `mail.received` event (packages/edge/src/imap/object.ts `publishReceived`), on the mailbox's account alone. */
export interface MailReceivedEventData {
  accountId: string;
  folder: string;
  uid: number;
  from: { name: string; address: string } | null;
  subject: string;
  date: string;
}

/** The longest body read_mail returns, in characters (the /mcp tools' MAX_BODY_CHARS). */
export const MAX_BODY_CHARS = 50_000;
export const NO_MAILBOX = 'This agent has no mailbox yet: its organization has not set one up (hosted mail), or it is still being set up.';

const ID_TEXT = 'A message id as list_mail and search_mail return it ("<account>:<folder>:<uid>"). Copy it exactly.';
const ids = (max: number) => ({ type: 'array', items: { type: 'string' }, maxItems: max, description: `Message ids (from list_mail or search_mail), at most ${max}.` });
const recipients = (what: string) => ({ type: 'array', items: { type: 'string' }, description: `${what}: email addresses, each "name@example.com" or "Name <name@example.com>".` });

export const MAIL_TOOLS = [
  {
    name: 'list_mail',
    description: 'List the newest messages in your own mailbox (at your address in this organization), newest first: id, date, sender, subject, and whether it is unread. Use read_mail with an id to read one.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'The folder path. Defaults to INBOX; Sent, Drafts, Trash and Archive are the usual others.' },
        limit: { type: 'number', description: 'How many, at most 50. Defaults to 20.' },
        unread_only: { type: 'boolean', description: 'Only unread messages.' },
      },
    },
  },
  {
    name: 'search_mail',
    description: 'Find messages in one folder of your mailbox whose text, sender or subject has the words, newest first, as list_mail shows them.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for: words in the text, sender or subject.' },
        folder: { type: 'string', description: 'The folder path. Defaults to INBOX.' },
        limit: { type: 'number', description: 'How many, at most 50. Defaults to 20.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_mail',
    description: `Read messages by id, up to 20 at once: from, to, cc, subject, date, Message-ID and the body as plain text (cut at ${MAX_BODY_CHARS} characters), and the attachments' names. Reading does not mark a message read (mark_mail does).`,
    inputSchema: { type: 'object', properties: { ids: ids(20) }, required: ['ids'] },
  },
  {
    name: 'send_mail',
    description: 'Send an email from your own address. The body is Markdown, sent as formatted HTML with a plain-text copy. With reply_to_id it answers that message: To defaults to its sender, the subject to "Re: …", it is threaded, and the original is quoted below your text. Say what you sent.',
    inputSchema: {
      type: 'object',
      properties: {
        to: recipients('To'),
        cc: recipients('Cc'),
        subject: { type: 'string', description: 'The subject. Optional for a reply, which defaults to "Re: " and the original\'s.' },
        body: { type: 'string', description: 'The message, in Markdown (bold, lists, links). Only what you write: a reply quotes the original for you.' },
        reply_to_id: { type: 'string', description: `Reply to this message. ${ID_TEXT}` },
      },
      required: ['body'],
    },
  },
  {
    name: 'move_mail',
    description: 'Move messages to another folder of your mailbox (e.g. Archive or Trash). Their ids change: list the folder again to find them there.',
    inputSchema: {
      type: 'object',
      properties: { ids: ids(100), to_folder: { type: 'string', description: 'The folder path to move them to.' } },
      required: ['ids', 'to_folder'],
    },
  },
  {
    name: 'mark_mail',
    description: 'Mark messages read or unread, and/or starred (flagged) or not. Give read, starred or both.',
    inputSchema: {
      type: 'object',
      properties: { ids: ids(100), read: { type: 'boolean', description: 'true: mark read; false: mark unread.' }, starred: { type: 'boolean', description: 'true: star; false: unstar.' } },
      required: ['ids'],
    },
  },
];
export const MAIL_TOOL_NAMES = new Set(MAIL_TOOLS.map((t) => t.name));

/** What the agent is asked when mail comes from a member (the turn in the DM with them, or with the sponsor). */
export function mailPrompt(d: MailReceivedEventData, id: string, name: string | null): string {
  const address = d.from?.address ?? 'an unknown sender';
  const from = name ? `${name} <${address}>` : address;
  return `You received an email from ${from}: "${d.subject || '(no subject)'}". Read it with \`read_mail\` (id ${id}) and act on it; ` +
    'reply by email with `send_mail` (reply_to_id) if a reply is wanted, or answer here.';
}

// ---- Markdown, as the message's HTML ---------------------------------------------------------------------------------

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** One line's inline Markdown: `code`, **bold**, *italic* / _italic_, ~~strike~~, [text](http… or mailto:), on escaped text. */
function inline(s: string): string {
  const codes: string[] = [];
  let out = escapeHtml(s).replace(/`([^`]+)`/g, (_m, c: string) => `\u0000${codes.push(`<code>${c}</code>`) - 1}\u0000`);
  out = out
    .replace(/\[([^\]]+)\]\(((?:https?:|mailto:)[^)\s]+)\)/g, (_m, t: string, href: string) => `<a href="${href}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a?: string, b?: string) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]!);
}

/**
 * A body written in Markdown as a message's HTML, as the Mail tools on /mcp send it (mailText.ts `markdownToHtml`, with
 * marked: GFM, line breaks kept): headings, paragraphs, lists, quotes, code blocks and the inline marks. Raw HTML in it is
 * shown as text, never passed through. Small on purpose: the bridge carries no Markdown library.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); out.push(`<h${h[1]!.length}>${inline(h[2]!.trim())}</h${h[1]!.length}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    const list = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (list) {
      flush();
      const ordered = /\d/.test(list[1]!);
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (!m || /\d/.test(m[1]!) !== ordered) break;
        items.push(`<li>${inline(m[2]!)}</li>`);
      }
      i--;
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) quoted.push(lines[i]!.replace(/^\s*>\s?/, ''));
      i--;
      out.push(`<blockquote>${markdownToHtml(quoted.join('\n'))}</blockquote>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    para.push(line.trim());
  }
  flush();
  return out.join('');
}

// ---- reading -------------------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** A message's HTML as text, roughly as a reader sees it: no markup, scripts or styles; a link as `text (address)`. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b[^>]*href\s*=\s*["']((?:https?:|mailto:)[^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, t: string) => {
      const text = t.replace(/<[^>]+>/g, '').trim();
      const shown = href.replace(/^mailto:/i, '');
      return !text || text === href || text === shown ? shown : `${text} (${shown})`;
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|ul|ol|table|tr|blockquote|pre|hr)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') { const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m; }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- the tools -----------------------------------------------------------------------------------------------------

interface Address { name: string; address: string }
interface Account { id: string; email: string; displayName: string; kind?: 'connected' | 'hosted' }
interface Summary { uid: number; folder: string; from: Address | null; to: Address[]; subject: string; date: string; seen: boolean; flagged: boolean; hasAttachments: boolean }
interface Detail extends Summary {
  cc: Address[]; replyTo: Address[]; messageId: string | null; inReplyTo: string | null; references: string[];
  html: string | null; text: string | null; attachments: { index: number; filename: string; mimeType: string; size: number; inline: boolean }[];
}

export type MailApi = Pick<FlowApi, 'mail'>;

const fmt = (a: Address) => (a.name ? `${a.name} <${a.address}>` : a.address);
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
/** "Name <a@b.c>" or "a@b.c" as the API's address, or null. */
function parseAddress(input: string): Address | null {
  const s = String(input).trim();
  const angled = /^(.*?)<\s*([^<>\s]+)\s*>$/.exec(s);
  if (angled) return EMAIL.test(angled[2]!) ? { name: angled[1]!.trim().replace(/^"(.*)"$/, '$1'), address: angled[2]! } : null;
  const bare = s.replace(/^mailto:/i, '');
  return EMAIL.test(bare) ? { name: '', address: bare } : null;
}

/** A message id's parts (`<account>:<folder>:<uid>`: the account has no colon, the uid is last), or null. */
export function parseMessageId(id: string): { account: string; folder: string; uid: number } | null {
  const s = typeof id === 'string' ? id.trim() : '';
  const first = s.indexOf(':'), last = s.lastIndexOf(':');
  if (first <= 0 || last <= first + 1 || !/^\d+$/.test(s.slice(last + 1)) || Number(s.slice(last + 1)) < 1) return null;
  return { account: s.slice(0, first), folder: s.slice(first + 1, last), uid: Number(s.slice(last + 1)) };
}

class ToolError extends Error {}

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? [v] : []);
const line = (account: string, m: Summary) =>
  `${account}:${m.folder}:${m.uid}  ${m.date}  ${m.from ? fmt(m.from) : '(no sender)'}  ${m.subject || '(no subject)'}${m.seen ? '' : '  [unread]'}${m.flagged ? '  [starred]' : ''}${m.hasAttachments ? '  [attachments]' : ''}`;

/**
 * One of MAIL_TOOLS, as the agent, on its hosted mailbox in its organization: the text for the agent, and whether it is
 * an error. No mailbox is an answer, not an error, so the turn goes on. The /mcp tools' argument names; `id`, `q`, `seen`,
 * `flagged`, `to` (for move_mail), `unread` and `in_reply_to` are taken for theirs too.
 */
export async function mailTool(api: MailApi, workspaceId: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  if (!workspaceId) return { text: `${name} needs a workspace (FLOW_WORKSPACE_ID is not set)`, isError: true };
  try {
    const { accounts } = await api.mail<{ accounts: Account[] }>('GET', 'accounts', workspaceId);
    const box = accounts.find((a) => a.kind === 'hosted');
    if (!box) return { text: NO_MAILBOX, isError: false };
    const P = `accounts/${encodeURIComponent(box.id)}`;
    /** The ids given, each in the agent's own mailbox. */
    const refs = (max: number, given = listOf(args.ids ?? args.id)) => {
      if (!given.length) throw new ToolError(`${name} needs ids (from list_mail or search_mail)`);
      if (given.length > max) throw new ToolError(`${name} takes at most ${max} ids at once`);
      return given.map((g) => {
        const r = parseMessageId(g);
        if (!r) throw new ToolError(`"${g.slice(0, 100)}" is not a message id; use the ids list_mail returns, as they are`);
        if (r.account !== box.id) throw new ToolError(`${g.slice(0, 100)} is not in your mailbox (${box.email})`);
        return { id: g, ...r };
      });
    };
    /** The ids by folder, one request each. */
    const byFolder = (rs: { folder: string; uid: number }[]) => {
      const m = new Map<string, number[]>();
      for (const r of rs) m.set(r.folder, [...(m.get(r.folder) ?? []), r.uid]);
      return [...m];
    };
    const page = async (folder: string, limit: number, extra: Record<string, string>) => {
      const q = new URLSearchParams({ folder, limit: String(Math.min(50, Math.max(1, Math.floor(limit) || 20))), ...extra });
      const r = await api.mail<{ messages: Summary[] }>('GET', `${P}/messages?${q}`, workspaceId);
      return r.messages.length ? r.messages.map((m) => line(box.id, m)).join('\n') : `no messages${extra.q ? ' match' : ''} in ${folder}`;
    };
    const folderArg = () => (typeof args.folder === 'string' && args.folder.trim() ? args.folder.trim() : 'INBOX');
    switch (name) {
      case 'list_mail':
        return { text: `${box.email}, ${folderArg()}:\n${await page(folderArg(), Number(args.limit ?? 20), args.unread_only === true || args.unread === true ? { unread: '1' } : {})}`, isError: false };
      case 'search_mail': {
        const query = String(args.query ?? args.q ?? '').trim();
        if (!query) return { text: 'search_mail needs a query', isError: true };
        return { text: await page(folderArg(), Number(args.limit ?? 20), { q: query }), isError: false };
      }
      case 'read_mail': {
        const out: string[] = [];
        for (const r of refs(20)) {
          try {
            const { message: m } = await api.mail<{ message: Detail }>('GET', `${P}/messages/${r.uid}?${new URLSearchParams({ folder: r.folder })}`, workspaceId);
            const body = m.html?.trim() ? htmlToText(m.html) : (m.text ?? '').replace(/\r\n/g, '\n').trim();
            const cut = body.length > MAX_BODY_CHARS;
            out.push([
              `id: ${r.id}`,
              `from: ${m.from ? fmt(m.from) : '(none)'}`,
              `to: ${m.to.map(fmt).join(', ')}`,
              ...(m.cc?.length ? [`cc: ${m.cc.map(fmt).join(', ')}`] : []),
              ...(m.replyTo?.length ? [`reply-to: ${m.replyTo.map(fmt).join(', ')}`] : []),
              `subject: ${m.subject}`,
              `date: ${m.date}`,
              ...(m.messageId ? [`message-id: ${m.messageId}`] : []),
              ...(m.attachments?.filter((a) => !a.inline).length ? [`attachments: ${m.attachments.filter((a) => !a.inline).map((a) => `${a.filename} (${a.mimeType}, ${a.size} bytes)`).join(', ')}`] : []),
              '',
              cut ? `${body.slice(0, MAX_BODY_CHARS)}\n[the body was cut at ${MAX_BODY_CHARS} characters]` : body,
            ].join('\n'));
          } catch (err) {
            out.push(`id: ${r.id}\nnot read: ${(err as Error).message}`);
          }
        }
        return { text: out.join('\n\n---\n\n'), isError: false };
      }
      case 'send_mail': {
        const body = typeof args.body === 'string' ? args.body : '';
        if (!body.trim()) return { text: 'send_mail needs a body (Markdown)', isError: true };
        const bad = [...listOf(args.to), ...listOf(args.cc)].filter((a) => !parseAddress(a));
        if (bad.length) return { text: `not an email address: ${bad.slice(0, 3).join(', ')} — write "name@example.com" or "Name <name@example.com>"`, isError: true };
        let to = listOf(args.to).map((a) => parseAddress(a)!), cc = listOf(args.cc).map((a) => parseAddress(a)!);
        let subject = typeof args.subject === 'string' ? args.subject.trim() : '';
        let html = markdownToHtml(body), text = body;
        const extra: Record<string, unknown> = {};
        const replyId = String(args.reply_to_id ?? args.in_reply_to ?? '').trim();
        if (replyId) {
          const [r] = refs(1, [replyId]);
          const { message: m } = await api.mail<{ message: Detail }>('GET', `${P}/messages/${r!.uid}?${new URLSearchParams({ folder: r!.folder })}`, workspaceId);
          if (!to.length) to = m.replyTo?.length ? m.replyTo : m.from ? [m.from] : [];
          if (!subject) subject = /^re\s*:/i.test(m.subject.trim()) ? m.subject.trim() : `Re: ${m.subject.trim()}`;
          if (m.messageId) Object.assign(extra, { inReplyTo: m.messageId, references: [...(m.references ?? []), m.messageId].filter((x, i, all) => all.indexOf(x) === i) });
          const original = m.html?.trim() ? htmlToText(m.html) : (m.text ?? '').trim();
          const intro = `On ${m.date}, ${m.from ? fmt(m.from) : 'someone'} wrote:`;
          html = `${html}<br><p>${escapeHtml(intro)}</p><blockquote>${original.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')}</blockquote>`;
          text = `${text}\n\n${intro}\n${original.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}`;
        }
        if (!to.length) return { text: 'send_mail needs to (or reply_to_id)', isError: true };
        if (!subject) return { text: 'send_mail needs a subject', isError: true };
        const r = await api.mail<{ ok: boolean; messageId?: string }>('POST', `${P}/send`, workspaceId, { to, ...(cc.length ? { cc } : {}), subject, html, text, ...extra });
        return { text: `sent "${subject}" from ${box.email} to ${[...to, ...cc].map(fmt).join(', ')}${r.messageId ? ` (Message-ID ${r.messageId})` : ''}`, isError: false };
      }
      case 'move_mail': {
        const dest = String(args.to_folder ?? args.to ?? '').trim();
        if (!dest) return { text: 'move_mail needs to_folder', isError: true };
        const rs = refs(100);
        for (const [folder, uids] of byFolder(rs)) await api.mail('POST', `${P}/messages/move`, workspaceId, { folder, uids, to: dest });
        return { text: `moved ${rs.length} message${rs.length === 1 ? '' : 's'} to ${dest}; their ids changed (list ${dest} to find them)`, isError: false };
      }
      case 'mark_mail': {
        const read = typeof args.read === 'boolean' ? args.read : typeof args.seen === 'boolean' ? args.seen : undefined;
        const starred = typeof args.starred === 'boolean' ? args.starred : typeof args.flagged === 'boolean' ? args.flagged : undefined;
        if (read === undefined && starred === undefined) return { text: 'mark_mail needs read, starred or both', isError: true };
        const rs = refs(100);
        for (const [folder, uids] of byFolder(rs)) await api.mail('PATCH', `${P}/messages`, workspaceId, { folder, uids, ...(read !== undefined ? { seen: read } : {}), ...(starred !== undefined ? { flagged: starred } : {}) });
        const what = [...(read !== undefined ? [read ? 'read' : 'unread'] : []), ...(starred !== undefined ? [starred ? 'starred' : 'not starred'] : [])].join(' and ');
        return { text: `marked ${rs.length} message${rs.length === 1 ? '' : 's'} ${what}`, isError: false };
      }
      default:
        return { text: `unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return { text: err instanceof ToolError ? err.message : `${name} failed: ${(err as Error).message}`, isError: true };
  }
}
