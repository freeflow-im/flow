// The Mail tools agents use: on the MCP endpoint (app.freeflow.im/mcp, docs/specs/web-mcp.md) and, a few of them, in the
// Docs assistant. Each acts on the caller's own Mail object (one per person: `idFromName(userId)`), through its HTTP API
// (docs/specs/mail-api.md), whatever organization the agent was allowed into: mail is a person's, not an organization's.
//
// A message is named by an opaque id, `<accountId>:<folder>:<uid>` (`messageId`, `parseMessageId`): the account id has no
// colon and the UID is the last part, so a folder with colons in its name still parses. Ids from another person's mail
// name accounts this person's object does not have, so they are refused like any unknown id.
//
// Which tools a token gets is its scopes' (`mailToolsFor`): mail:read lists, searches and reads; mail:write organises and
// drafts; mail:send sends; saving an attachment to Docs needs files:write too. A tool the scopes do not allow is not listed.
import { z } from 'zod4';
import type { Address, MailFolder, MessageDetail, MessageSummary } from './convert';
import { bodyText, formatAddress, markdownToHtml, parseAddress, prefill, truncateText } from './mailText';

export const MAIL_SCOPES = ['mail:read', 'mail:write', 'mail:send'] as const;
export type MailScope = (typeof MAIL_SCOPES)[number];

/** The longest body read_mail returns, in characters. */
export const MAX_BODY_CHARS = 50_000;
/** The largest attachment saved to Docs (Docs' preview limit). */
export const MAX_SAVE_BYTES = 25 * 1024 * 1024;
const TABS = ['primary', 'promotions', 'social', 'updates', 'forums'] as const;

/** An error the agent should see and can act on. */
export class MailToolError extends Error {}

/** The caller's own Mail object, as its HTTP API: a path under /v1/mail and a request. */
export type MailFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface MailToolContext {
  mail: MailFetch;
  /** The public origin (https://app.freeflow.im): links to FreeFlow Mail are made on it. */
  origin: string;
  /** Imports a file into the caller's My files in Docs (the organization the agent is in); absent where Docs is not. */
  saveToDocs?: (bytes: Buffer, filename: string) => Promise<{ file: Record<string, unknown>; warnings: string[] }>;
}

// ---- ids ----------------------------------------------------------------------------------------------------------

export interface MessageRef { account: string; folder: string; uid: number }

export const messageId = (account: string, folder: string, uid: number): string => `${account}:${folder}:${uid}`;

/** A message id's parts, or a MailToolError saying what a message id looks like. */
export function parseMessageId(id: string): MessageRef {
  const s = typeof id === 'string' ? id.trim() : '';
  const first = s.indexOf(':');
  const last = s.lastIndexOf(':');
  const uid = Number(s.slice(last + 1));
  if (first <= 0 || last <= first + 1 || !Number.isInteger(uid) || uid < 1 || !/^\d+$/.test(s.slice(last + 1))) {
    throw new MailToolError(`"${String(id).slice(0, 100)}" is not a message id. Use the ids search_mail returns, as they are.`);
  }
  return { account: s.slice(0, first), folder: s.slice(first + 1, last), uid };
}

/** Ids grouped by account and folder (one request each), in the order first seen. */
export function groupIds(ids: string[]): { account: string; folder: string; uids: number[] }[] {
  const groups = new Map<string, { account: string; folder: string; uids: number[] }>();
  for (const id of ids) {
    const r = parseMessageId(id);
    const key = `${r.account}\u0000${r.folder}`;
    const g = groups.get(key) ?? { account: r.account, folder: r.folder, uids: [] };
    if (!g.uids.includes(r.uid)) g.uids.push(r.uid);
    groups.set(key, g);
  }
  return [...groups.values()];
}

// ---- the Mail object -------------------------------------------------------------------------------------------------

interface Account { id: string; email: string; displayName: string; status: string; statusMessage?: string; tabs: string[] }

async function call<T>(ctx: MailToolContext, method: string, path: string, body?: unknown): Promise<T> {
  const res = await ctx.mail(`/v1/mail${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (res.ok) return (await res.json()) as T;
  const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  const message = err?.error?.message ?? `the mail server answered ${res.status}`;
  if (res.status === 404) throw new MailToolError(`Not found: ${message}. Check the id (use the ids search_mail returns) or the folder (list_mail_folders).`);
  if (err?.error?.code === 'auth_failed') throw new MailToolError(`The mail server refused this account's login (${message}). The user can enter the password again in FreeFlow Mail at ${ctx.origin}/mail.`);
  throw new MailToolError(message.charAt(0).toUpperCase() + message.slice(1));
}

const accountsOf = async (ctx: MailToolContext) => (await call<{ accounts: Account[] }>(ctx, 'GET', '/accounts')).accounts;

/** The account an argument names (its id or email address), else the first; an error when there is none. */
async function accountFor(ctx: MailToolContext, named?: string): Promise<{ account: Account; all: Account[] }> {
  const all = await accountsOf(ctx);
  if (!all.length) throw new MailToolError(`No mail account is connected. The user can connect one in FreeFlow Mail at ${ctx.origin}/mail.`);
  if (!named) return { account: all[0]!, all };
  const n = named.trim().toLowerCase();
  const account = all.find((a) => a.id === named.trim() || a.email.toLowerCase() === n);
  if (!account) throw new MailToolError(`There is no mail account "${named}". The accounts are: ${all.map((a) => `${a.email} (${a.id})`).join(', ')}.`);
  return { account, all };
}

const accountPath = (id: string) => `/accounts/${encodeURIComponent(id)}`;

/** The account a message id names must be the caller's (their object has no other's). */
async function ownAccount(ctx: MailToolContext, id: string, all?: Account[]): Promise<Account> {
  const list = all ?? (await accountsOf(ctx));
  const a = list.find((x) => x.id === id);
  if (!a) throw new MailToolError(`Not found: no message with that id in this person's mail. Use the ids search_mail returns.`);
  return a;
}

const addresses = (list: string[] | undefined, field: string): Address[] =>
  (list ?? []).map((s) => {
    const a = parseAddress(s);
    if (!a) throw new MailToolError(`${field}: "${s}" is not an email address. Write "name@example.com" or "Name <name@example.com>".`);
    return a;
  });

const shown = (list: Address[]) => list.map(formatAddress);

function summary(account: string, m: MessageSummary & { category?: string }) {
  return {
    id: messageId(account, m.folder, m.uid),
    from: m.from ? formatAddress(m.from) : null,
    to: shown(m.to),
    ...(m.cc.length ? { cc: shown(m.cc) } : {}),
    subject: m.subject,
    date: m.date,
    snippet: m.snippet,
    unread: !m.seen,
    starred: m.flagged,
    has_attachments: m.hasAttachments,
    ...(m.category ? { tab: m.category } : {}),
  };
}

/** A link that opens a message in FreeFlow Mail. */
export const mailLink = (origin: string, account: string, folder: string, uid: number): string => `${origin}/mail/?${new URLSearchParams({ account, folder, uid: String(uid) })}`;

// ---- the tools -----------------------------------------------------------------------------------------------------

const ID_TEXT = 'A message id as search_mail returns it ("<account>:<folder>:<uid>"). Treat ids as opaque: copy them exactly.';
const id = z.string().min(3).max(1200).describe(ID_TEXT);
const ids = (max: number) => z.array(id).min(1).max(max).describe(`Message ids from search_mail, at most ${max}.`);
const account = z.string().max(320).optional().describe("The mail account: its id or email address, from list_mail_accounts. Defaults to the user's first account.");
const recipients = (what: string) => z.array(z.string().max(500)).max(100).optional().describe(`${what}: email addresses, each "name@example.com" or "Name <name@example.com>".`);

const draftShape = {
  account,
  to: recipients('To'),
  cc: recipients('Cc'),
  bcc: recipients('Bcc'),
  subject: z.string().max(2000).optional().describe('The subject. Optional for a reply or forward, which default to "Re: ..." or "Fwd: ..." the original\'s.'),
  body: z.string().max(200_000).describe('The message, in Markdown (bold, lists, links and so on), sent as formatted HTML with a plain-text copy. Only what you write: for a reply or forward the original is quoted below it for you.'),
  reply_to_id: id.optional().describe('Reply to this message (an id from search_mail): sets To from it (when to is not given), "Re:" on the subject, threads it (In-Reply-To and References) and quotes it below the body, as replying in FreeFlow Mail does.'),
  reply_all: z.boolean().optional().describe('With reply_to_id: also Cc everyone else the original went to (when cc is not given).'),
  forward_id: id.optional().describe('Forward this message (an id from search_mail): "Fwd:" on the subject, the original quoted below the body, and its attachments attached. Give to.'),
};

type Shape = Record<string, z.ZodType>;
export interface MailTool {
  name: string;
  title: string;
  description: string;
  shape: Shape;
  /** Every scope listed is needed. */
  scopes: string[];
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint?: boolean; openWorldHint: boolean };
  run(ctx: MailToolContext, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

type DraftInput = { account?: string; to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; body: string; reply_to_id?: string; reply_all?: boolean; forward_id?: string };

/** A draft's or a message's body for the Mail object's API, from what the agent wrote (and the original it answers). */
async function composed(ctx: MailToolContext, input: DraftInput): Promise<{ account: Account; body: Record<string, unknown> }> {
  if (input.reply_to_id && input.forward_id) throw new MailToolError('Give reply_to_id or forward_id, not both.');
  const sourceId = input.reply_to_id ?? input.forward_id;
  const source = sourceId ? parseMessageId(sourceId) : null;
  const all = await accountsOf(ctx);
  // A reply goes from the account the original is in.
  const { account } = source ? { account: await ownAccount(ctx, source.account, all) } : await accountFor(ctx, input.account);
  if (source && input.account && input.account !== account.id && input.account.toLowerCase() !== account.email.toLowerCase()) {
    throw new MailToolError(`The message replied to or forwarded is in ${account.email}; leave account out, or name that account.`);
  }
  let to = addresses(input.to, 'to');
  let cc = addresses(input.cc, 'cc');
  const bcc = addresses(input.bcc, 'bcc');
  let subject = input.subject?.trim() ?? '';
  let html = markdownToHtml(input.body);
  let text = input.body;
  const extra: Record<string, unknown> = {};
  if (source) {
    const { message } = await call<{ message: MessageDetail }>(ctx, 'GET', `${accountPath(account.id)}/messages/${source.uid}?${new URLSearchParams({ folder: source.folder })}`);
    const p = prefill(input.forward_id ? 'forward' : input.reply_all ? 'replyAll' : 'reply', message, account.email);
    if (!input.to?.length) to = p.to;
    if (!input.cc?.length && p.cc.length) cc = p.cc;
    if (!subject) subject = p.subject;
    html = `${html}<br>${p.quoteHtml}`;
    text = `${text}\n\n${p.quoteText}`;
    if (p.inReplyTo) Object.assign(extra, { inReplyTo: p.inReplyTo, references: p.references });
    if (input.forward_id && message.attachments.some((a) => !a.inline)) extra.attachFrom = { folder: source.folder, uid: source.uid };
  }
  return { account, body: { to, ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}), subject, html, text, ...extra } };
}

export const MAIL_TOOLS: MailTool[] = [
  {
    name: 'list_mail_accounts',
    title: 'List mail accounts',
    description: "The email accounts the user connected to FreeFlow Mail: each one's id, address, name, whether its inbox is split into tabs (Gmail-style Primary, Promotions, Social, Updates, Forums) and which, and whether it is working. Mail tools take an account by its id or address, and default to the first one.",
    shape: {},
    scopes: ['mail:read'],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async run(ctx) {
      const all = await accountsOf(ctx);
      return {
        accounts: all.map((a) => ({ id: a.id, email: a.email, name: a.displayName, inbox_tabs: a.tabs.length ? ['primary', ...a.tabs] : false, status: a.status, ...(a.statusMessage ? { status_message: a.statusMessage } : {}) })),
        ...(all.length ? {} : { note: `No mail account is connected. The user can connect one in FreeFlow Mail at ${ctx.origin}/mail.` }),
      };
    },
  },
  {
    name: 'list_mail_folders',
    title: 'List mail folders',
    description: "An account's folders (mailboxes, Gmail's labels): each one's path (what move_mail and search_mail take), its role (inbox, sent, drafts, trash, junk, archive, all or null) and its unread and total counts.",
    shape: { account },
    scopes: ['mail:read'],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async run(ctx, input) {
      const { account: a } = await accountFor(ctx, input.account as string | undefined);
      const { folders } = await call<{ folders: MailFolder[] }>(ctx, 'GET', `${accountPath(a.id)}/folders`);
      return { account: a.email, folders: folders.map((f) => ({ path: f.path, name: f.name, role: f.specialUse, unread: f.unread, total: f.total })) };
    },
  },
  {
    name: 'search_mail',
    title: 'Search mail',
    description:
      "Finds messages in one folder of one account, newest first, as summaries (id, from, to, subject, date, snippet, unread, starred, has_attachments, and tab when the inbox has tabs). With no query, the newest messages. On a Gmail account the query is Gmail's search syntax, exactly as in Gmail's search box (from:ann has:attachment newer_than:7d subject:invoice is:unread label:work category:promotions, and plain words); on other accounts it matches words in the messages' text, sender or subject. Up to 50 per call: pass the result's next as before to get older ones (next is null when there are no more). Use read_mail with the ids to read messages.",
    shape: {
      query: z.string().max(1000).optional().describe('What to look for (Gmail search syntax on Gmail accounts; words elsewhere). Leave out for the newest messages.'),
      account,
      folder: z.string().max(1000).optional().describe('The folder path, from list_mail_folders. Defaults to INBOX.'),
      tab: z.enum(TABS).optional().describe('Only this inbox tab. Only for INBOX of an account whose inbox has tabs (list_mail_accounts).'),
      unread_only: z.boolean().optional().describe('Only unread messages.'),
      limit: z.number().int().min(1).max(50).optional().describe('How many, at most 50. Defaults to 20.'),
      before: z.number().int().min(1).optional().describe("The next value from a previous search_mail with the same arguments, for the page after it."),
    },
    scopes: ['mail:read'],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async run(ctx, input) {
      const { account: a, all } = await accountFor(ctx, input.account as string | undefined);
      const folder = ((input.folder as string | undefined) ?? '').trim() || 'INBOX';
      const tab = input.tab as string | undefined;
      const query = ((input.query as string | undefined) ?? '').trim();
      const unread = input.unread_only === true;
      if (tab && folder.toUpperCase() !== 'INBOX') throw new MailToolError('tab: inbox tabs are only in INBOX; leave tab out for other folders.');
      if (tab && !a.tabs.length) throw new MailToolError(`tab: ${a.email} does not split its inbox into tabs; leave tab out.`);
      const limit = (input.limit as number | undefined) ?? 20;
      const params = new URLSearchParams({ folder, limit: String(limit) });
      if (query) {
        params.set('q', query);
        params.set('raw', '1');
      }
      if (unread) params.set('unread', '1');
      if (tab) params.set('category', tab);
      if (typeof input.before === 'number') params.set('before', String(input.before));
      const page = await call<{ messages: (MessageSummary & { category?: string })[]; next: number | null; sorting?: boolean }>(ctx, 'GET', `${accountPath(a.id)}/messages?${params}`);
      // A search covers the whole folder, whatever the tab; the tab is then kept by what each message is in.
      const filtered = tab && (query || unread) ? page.messages.filter((m) => (m.category ?? 'primary') === tab) : page.messages;
      return {
        account: a.email,
        folder,
        ...(tab ? { tab } : {}),
        messages: filtered.map((m) => summary(a.id, m)),
        next: page.next,
        ...(filtered.length < page.messages.length ? { note: 'Some messages on this page were in other tabs and are left out; pass next as before for more.' } : page.sorting ? { note: 'Older mail is still being sorted into tabs; ask again shortly for more of this tab.' } : {}),
        ...(all.length > 1 && !input.account ? { other_accounts: all.filter((x) => x.id !== a.id).map((x) => x.email) } : {}),
      };
    },
  },
  {
    name: 'read_mail',
    title: 'Read mail',
    description: `Reads messages by id (from search_mail), up to 20 at once: each one's headers (from, to, cc, reply-to, subject, date, Message-ID), its body as plain text (HTML made readable, links kept as "text (address)"), and its attachments (index, filename, type, size; pictures shown inside the message are marked inline). A body longer than ${MAX_BODY_CHARS} characters is cut, saying so. Reading does not mark a message read. To read an attachment, save it to Docs with save_mail_attachment_to_docs.`,
    shape: { ids: ids(20) },
    scopes: ['mail:read'],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async run(ctx, input) {
      const list = input.ids as string[];
      const refs = list.map((x) => ({ id: x, ref: parseMessageId(x) }));
      const all = await accountsOf(ctx);
      const messages: Record<string, unknown>[] = [];
      const errors: { id: string; error: string }[] = [];
      for (const { id: mid, ref } of refs) {
        try {
          await ownAccount(ctx, ref.account, all);
          const { message: m } = await call<{ message: MessageDetail }>(ctx, 'GET', `${accountPath(ref.account)}/messages/${ref.uid}?${new URLSearchParams({ folder: ref.folder })}`);
          const body = truncateText(bodyText(m), MAX_BODY_CHARS);
          messages.push({
            id: mid,
            from: m.from ? formatAddress(m.from) : null,
            to: shown(m.to),
            ...(m.cc.length ? { cc: shown(m.cc) } : {}),
            ...(m.bcc.length ? { bcc: shown(m.bcc) } : {}),
            ...(m.replyTo.length ? { reply_to: shown(m.replyTo) } : {}),
            subject: m.subject,
            date: m.date,
            folder: m.folder,
            unread: !m.seen,
            starred: m.flagged,
            message_id: m.messageId,
            ...(m.inReplyTo ? { in_reply_to: m.inReplyTo } : {}),
            body: body.text,
            ...(body.truncated ? { body_truncated: `The body was cut at ${MAX_BODY_CHARS} characters.` } : {}),
            attachments: m.attachments.map((x) => ({ index: x.index, filename: x.filename, type: x.mimeType, size: x.size, ...(x.inline ? { inline: true } : {}) })),
          });
        } catch (e) {
          if (!(e instanceof MailToolError)) throw e;
          errors.push({ id: mid, error: e.message });
        }
      }
      if (!messages.length && errors.length) throw new MailToolError(errors.map((e) => `${e.id}: ${e.error}`).join('\n'));
      return { messages, ...(errors.length ? { errors } : {}) };
    },
  },
  {
    name: 'save_mail_attachment_to_docs',
    title: 'Save a mail attachment to Docs',
    description: `Saves one attachment of a message (its index from read_mail) as a file in the user's My files in Docs: a Word file becomes a document, PowerPoint a presentation, Excel or CSV a spreadsheet, Markdown a Markdown document, and a PDF, picture or other file a stored file. Returns the Docs file's id, kind and link; read it with the Docs tools (read_doc, read_deck, get_sheet_overview and read_range, read_file). Files up to ${MAX_SAVE_BYTES / 1024 / 1024} MB.`,
    shape: { id: id.describe('The message the attachment is in (an id from search_mail).'), index: z.number().int().min(0).max(1000).describe("The attachment's index, from read_mail.") },
    scopes: ['mail:read', 'files:write'],
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(ctx, input) {
      if (!ctx.saveToDocs) throw new MailToolError('Saving to Docs is not available here.');
      const ref = parseMessageId(input.id as string);
      await ownAccount(ctx, ref.account);
      const index = input.index as number;
      const res = await ctx.mail(`/v1/mail${accountPath(ref.account)}/messages/${ref.uid}/attachments/${index}?${new URLSearchParams({ folder: ref.folder })}`);
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new MailToolError(res.status === 404 ? `Not found: ${err?.error?.message ?? 'no such attachment'}. Check the id and the index (read_mail lists them).` : (err?.error?.message ?? `The attachment could not be read (${res.status}).`));
      }
      if (Number(res.headers.get('content-length')) > MAX_SAVE_BYTES) throw new MailToolError(`This attachment is larger than ${MAX_SAVE_BYTES / 1024 / 1024} MB.`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_SAVE_BYTES) throw new MailToolError(`This attachment is larger than ${MAX_SAVE_BYTES / 1024 / 1024} MB.`);
      const disposition = res.headers.get('content-disposition') ?? '';
      const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      const plain = /filename="([^"]*)"/i.exec(disposition)?.[1];
      let filename = `attachment-${index + 1}`;
      try {
        filename = star ? decodeURIComponent(star) : plain || filename;
      } catch {
        filename = plain || filename;
      }
      const saved = await ctx.saveToDocs(bytes, filename);
      return { saved: true, filename, file: saved.file, ...(saved.warnings.length ? { warnings: saved.warnings } : {}) };
    },
  },
  {
    name: 'mark_mail',
    title: 'Mark mail',
    description: 'Marks messages read or unread, and/or starred (flagged) or not. Give read, starred or both.',
    shape: { ids: ids(100), read: z.boolean().optional().describe('true: mark read; false: mark unread.'), starred: z.boolean().optional().describe('true: star; false: unstar.') },
    scopes: ['mail:write'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(ctx, input) {
      if (input.read === undefined && input.starred === undefined) throw new MailToolError('Give read, starred or both.');
      const all = await accountsOf(ctx);
      let n = 0;
      for (const g of groupIds(input.ids as string[])) {
        await ownAccount(ctx, g.account, all);
        await call(ctx, 'PATCH', `${accountPath(g.account)}/messages`, { folder: g.folder, uids: g.uids, ...(input.read !== undefined ? { seen: input.read } : {}), ...(input.starred !== undefined ? { flagged: input.starred } : {}) });
        n += g.uids.length;
      }
      return { marked: n, ...(input.read !== undefined ? { read: input.read } : {}), ...(input.starred !== undefined ? { starred: input.starred } : {}) };
    },
  },
  {
    name: 'move_mail',
    title: 'Move mail',
    description: 'Moves messages to another folder of the same account (a path from list_mail_folders). Their ids change: search again to find them there.',
    shape: { ids: ids(100), to_folder: z.string().min(1).max(1000).describe('The folder path to move them to, from list_mail_folders.') },
    scopes: ['mail:write'],
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(ctx, input) {
      const all = await accountsOf(ctx);
      const to = (input.to_folder as string).trim();
      let n = 0;
      for (const g of groupIds(input.ids as string[])) {
        await ownAccount(ctx, g.account, all);
        await call(ctx, 'POST', `${accountPath(g.account)}/messages/move`, { folder: g.folder, uids: g.uids, to });
        n += g.uids.length;
      }
      return { moved: n, to_folder: to };
    },
  },
  {
    name: 'archive_mail',
    title: 'Archive mail',
    description: "Archives messages: moves them out of their folder into the account's Archive folder (on Gmail, All Mail, which takes them out of the inbox), as Archive in FreeFlow Mail does. Their ids change.",
    shape: { ids: ids(100) },
    scopes: ['mail:write'],
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(ctx, input) {
      const all = await accountsOf(ctx);
      let n = 0;
      const into = new Set<string>();
      for (const g of groupIds(input.ids as string[])) {
        const a = await ownAccount(ctx, g.account, all);
        const { folders } = await call<{ folders: MailFolder[] }>(ctx, 'GET', `${accountPath(a.id)}/folders`);
        const target = folders.find((f) => f.specialUse === 'archive') ?? folders.find((f) => f.specialUse === 'all');
        if (!target) throw new MailToolError(`${a.email} has no Archive folder. Use move_mail with a folder from list_mail_folders.`);
        if (target.path === g.folder) throw new MailToolError(`Those messages are already in ${target.path}.`);
        await call(ctx, 'POST', `${accountPath(a.id)}/messages/move`, { folder: g.folder, uids: g.uids, to: target.path });
        into.add(target.path);
        n += g.uids.length;
      }
      return { archived: n, to_folder: [...into].join(', ') };
    },
  },
  {
    name: 'move_mail_to_tab',
    title: 'Move mail to an inbox tab',
    description: "Moves inbox messages to another inbox tab (primary, promotions, social, updates or forums) the way FreeFlow Mail's Move to tab does: it applies to their senders, so their other messages and future mail go to that tab too. Only for messages in INBOX of an account whose inbox has tabs.",
    shape: { ids: ids(100), tab: z.enum(TABS).describe('The tab to move them, and their senders, to.') },
    scopes: ['mail:write'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(ctx, input) {
      const all = await accountsOf(ctx);
      const senders = new Set<string>();
      for (const g of groupIds(input.ids as string[])) {
        const a = await ownAccount(ctx, g.account, all);
        if (g.folder.toUpperCase() !== 'INBOX') throw new MailToolError('Only messages in INBOX can be moved to a tab.');
        if (!a.tabs.length) throw new MailToolError(`${a.email} does not split its inbox into tabs.`);
        const r = await call<{ senders: string[] }>(ctx, 'POST', `${accountPath(a.id)}/messages/category`, { folder: g.folder, uids: g.uids, category: input.tab });
        for (const s of r.senders ?? []) senders.add(s);
      }
      return { tab: input.tab, senders: [...senders] };
    },
  },
  {
    name: 'trash_mail',
    title: 'Move mail to Trash',
    description: "Moves messages to the account's Trash folder, from where the user can still get them back. It never deletes anything for good: messages already in Trash, or in an account with no Trash folder, are left as they are. Their ids change.",
    shape: { ids: ids(100) },
    scopes: ['mail:write'],
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async run(ctx, input) {
      const all = await accountsOf(ctx);
      let n = 0;
      for (const g of groupIds(input.ids as string[])) {
        await ownAccount(ctx, g.account, all);
        await call(ctx, 'POST', `${accountPath(g.account)}/messages/delete`, { folder: g.folder, uids: g.uids, trashOnly: true });
        n += g.uids.length;
      }
      return { trashed: n };
    },
  },
  {
    name: 'create_mail_draft',
    title: 'Create a mail draft',
    description:
      "Writes an email and saves it in the account's Drafts folder, unsent, for the user to review and send from FreeFlow Mail (the link opens it). The body is Markdown. For a reply give reply_to_id (and reply_all for everyone); for a forward give forward_id and to: the original is quoted below your body and the message threaded, as FreeFlow Mail's Reply and Forward do. Returns the draft's id (read_mail reads it back) and link.",
    shape: draftShape,
    scopes: ['mail:write'],
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(ctx, input) {
      const { account: a, body } = await composed(ctx, input as unknown as DraftInput);
      const saved = await call<{ folder: string; uid: number | null; messageId: string }>(ctx, 'POST', `${accountPath(a.id)}/drafts`, body);
      const to = body.to as Address[];
      return {
        saved: true,
        account: a.email,
        folder: saved.folder,
        ...(saved.uid !== null ? { draft_id: messageId(a.id, saved.folder, saved.uid), link: mailLink(ctx.origin, a.id, saved.folder, saved.uid) } : { link: `${ctx.origin}/mail/?${new URLSearchParams({ account: a.id, folder: saved.folder })}` }),
        to: shown(to),
        subject: body.subject,
        ...(to.length ? {} : { note: 'The draft has no recipient yet; the user adds one before sending.' }),
      };
    },
  },
  {
    name: 'send_mail',
    title: 'Send mail',
    description:
      "Sends an email from the user's account, now. Either write it (the same arguments as create_mail_draft: to, cc, bcc, subject, a Markdown body, reply_to_id or forward_id) or send a saved draft as it is with draft_id (then it leaves Drafts). A copy is kept in Sent. Only send what the user asked to be sent; when in doubt, make a draft with create_mail_draft instead.",
    shape: { ...draftShape, body: draftShape.body.optional().describe('The message, in Markdown. Required unless draft_id is given.'), draft_id: id.optional().describe('Send this saved draft (an id from create_mail_draft or search_mail in Drafts) as it is; leave out the other arguments.') },
    scopes: ['mail:send'],
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(ctx, input) {
      if (typeof input.draft_id === 'string') {
        const others = ['to', 'cc', 'bcc', 'subject', 'body', 'reply_to_id', 'forward_id'].filter((k) => input[k] !== undefined);
        if (others.length) throw new MailToolError(`With draft_id the draft is sent as it is; leave out ${others.join(', ')} (or edit it as a new draft).`);
        const ref = parseMessageId(input.draft_id);
        const a = await ownAccount(ctx, ref.account);
        const r = await call<{ messageId: string }>(ctx, 'POST', `${accountPath(a.id)}/drafts/${ref.uid}/send?${new URLSearchParams({ folder: ref.folder })}`);
        return { sent: true, account: a.email, message_id: r.messageId };
      }
      if (typeof input.body !== 'string') throw new MailToolError('Give body (or draft_id to send a saved draft).');
      const { account: a, body } = await composed(ctx, input as unknown as DraftInput);
      const to = body.to as Address[];
      if (!to.length && !(body.cc as Address[] | undefined)?.length && !(body.bcc as Address[] | undefined)?.length) throw new MailToolError('to: give at least one recipient.');
      const r = await call<{ messageId: string }>(ctx, 'POST', `${accountPath(a.id)}/send`, body);
      return { sent: true, account: a.email, to: shown(to), subject: body.subject, message_id: r.messageId };
    },
  },
];

/** The Mail tools the in-app assistant has: it reads, searches and drafts; the user sends from Mail. */
export const ASSISTANT_MAIL_TOOLS = ['search_mail', 'read_mail', 'create_mail_draft', 'save_mail_attachment_to_docs'] as const;

/** What the assistant is told differently: its own tools read files by other names, and it never sends. */
const ASSISTANT_DESCRIPTIONS: Partial<Record<(typeof ASSISTANT_MAIL_TOOLS)[number], string>> = {
  save_mail_attachment_to_docs: `Saves one attachment of a message (its index from read_mail) as a file in the user's files: a Word file becomes a document, PowerPoint a presentation, Excel or CSV a spreadsheet, Markdown a Markdown document, and a PDF, picture or other file a stored file. Returns the new file's id and kind; read it with your file tools (read_other_sheet, read_doc, read_deck and so on) or open it for the user. Files up to ${MAX_SAVE_BYTES / 1024 / 1024} MB.`,
  create_mail_draft:
    "Writes an email and saves it in the account's Drafts folder, unsent: the user reviews and sends it from FreeFlow Mail (give them the link). You cannot send email. The body is Markdown. For a reply give reply_to_id (and reply_all for everyone); for a forward give forward_id and to: the original is quoted below your body and the message threaded. Returns the draft's id and link.",
};

/** The assistant's Mail tools as Zod objects (described), for its tool list: never send_mail. */
export function assistantMailSchemas(): Record<string, z.ZodObject> {
  return Object.fromEntries(
    ASSISTANT_MAIL_TOOLS.map((name) => {
      const t = MAIL_TOOLS.find((x) => x.name === name)!;
      return [name, z.object(t.shape).describe(ASSISTANT_DESCRIPTIONS[name] ?? t.description)];
    }),
  );
}

/** Runs one of the assistant's Mail tools (its input already validated). Throws MailToolError for what the model should see. */
export async function runAssistantMailTool(name: string, input: Record<string, unknown>, ctx: MailToolContext): Promise<Record<string, unknown>> {
  if (!(ASSISTANT_MAIL_TOOLS as readonly string[]).includes(name)) throw new MailToolError(`The assistant has no tool ${name}.`);
  return MAIL_TOOLS.find((t) => t.name === name)!.run(ctx, input);
}

/** The Mail tools a token with these scopes may use (and so sees listed). files:write stands in for files:read too. */
export function mailToolsFor(scopes: readonly string[]): MailTool[] {
  const has = new Set(scopes);
  return MAIL_TOOLS.filter((t) => t.scopes.every((s) => has.has(s)));
}

/** A tool's input checked against its schema, or a MailToolError naming the first problem. */
export function validateMailInput(tool: MailTool, input: unknown): Record<string, unknown> {
  const r = z.object(tool.shape).strict().safeParse(input ?? {});
  if (r.success) return r.data as Record<string, unknown>;
  const issue = r.error.issues[0];
  throw new MailToolError(issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'invalid input');
}

/** What an agent is told about the Mail tools, for the server's instructions. */
export const MAIL_INSTRUCTIONS =
  "Mail: the user's own email accounts in FreeFlow Mail (the same whichever organization was chosen). search_mail finds messages (Gmail search syntax on Gmail accounts) and returns ids; read_mail reads them (without marking them read). Message ids are opaque: copy them exactly. To answer or write an email, make a draft with create_mail_draft for the user to review and send, unless the user explicitly asked you to send it and send_mail is available. save_mail_attachment_to_docs puts an attachment in Docs, where the Docs tools read it.";
