// A dev-only stand-in for the edge Worker's /v1/mail API (and the few suite routes the page reads), so the client runs
// with no server: `pnpm --filter @flow/mail dev:mock`. State is in memory and resets on restart. MAIL_MOCK=empty starts
// with no account (the "Connect your mail" screen). In the add-account flow, the password "wrong" answers auth_failed
// and a server host containing "bad" answers connect_failed; "stale" connects an account whose password then stops working.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type { Category, MailAccount, MessageSummary, NewAccount, ProviderPreset, TabCategory } from '../src/api';
import { sampleMailbox, type Mailbox, type StoredMessage } from './data';

const PRESETS: Record<string, ProviderPreset> = {
  'gmail.com': {
    name: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
  },
  'icloud.com': {
    name: 'iCloud Mail',
    imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    appPasswordUrl: 'https://account.apple.com/account/manage',
  },
  'fastmail.com': {
    name: 'Fastmail',
    imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
    appPasswordUrl: 'https://app.fastmail.com/settings/security/apps',
  },
  'outlook.com': { name: 'Outlook.com', imap: { host: 'outlook.office365.com', port: 993, security: 'tls' }, smtp: { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' } },
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createMockApi(empty = false) {
  const boxes = new Map<string, Mailbox>();
  if (!empty) {
    const box = sampleMailbox();
    boxes.set(box.account.id, box);
  }
  const boxOf = (id: string) => {
    const b = boxes.get(id);
    if (!b) throw new HttpError(404, 'not_found', 'No such account');
    return b;
  };
  const counted = (b: Mailbox) =>
    b.folders.map((f) => {
      const inFolder = b.messages.filter((m) => m.folder === f.path);
      return { ...f, total: inFolder.length, unread: inFolder.filter((m) => !m.seen).length };
    });
  /** The tab a message shows in: the sender's chosen tab, else its own, and Primary for a tab that is off. */
  const tabOf = (b: Mailbox, m: StoredMessage): Category => {
    const c = b.overrides.get(m.from?.address.toLowerCase() ?? '') ?? m.category ?? 'primary';
    return c !== 'primary' && b.account.tabs.includes(c) ? c : 'primary';
  };
  const withTab = (b: Mailbox, m: StoredMessage, s: MessageSummary): MessageSummary => (m.folder === 'INBOX' && b.account.tabs.length ? { ...s, category: tabOf(b, m) } : s);
  const summary = (m: StoredMessage): MessageSummary => ({
    uid: m.uid,
    folder: m.folder,
    messageId: m.messageId,
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    snippet: m.snippet,
    date: m.date,
    seen: m.seen,
    flagged: m.flagged,
    answered: m.answered,
    hasAttachments: m.hasAttachments,
    size: m.size,
  });
  const find = (b: Mailbox, folder: string, uid: number) => {
    const m = b.messages.find((x) => x.folder === folder && x.uid === uid);
    if (!m) throw new HttpError(404, 'not_found', 'No such message');
    return m;
  };
  const verify = (a: { password?: string | undefined; imap?: { host: string } | undefined; smtp?: { host: string } | undefined }) => {
    if (a.password === 'wrong') throw new HttpError(400, 'auth_failed', 'The mail server refused the user name or password (AUTHENTICATIONFAILED).');
    if (a.imap?.host.includes('bad') || a.smtp?.host.includes('bad')) throw new HttpError(502, 'connect_failed', `Could not connect to ${a.imap?.host}: connection timed out.`);
  };

  return async function handle(method: string, url: URL, body: unknown): Promise<{ status: number; json?: unknown; bytes?: { data: Buffer; type: string; disposition: string } }> {
    const p = url.pathname;
    const q = url.searchParams;
    let m: RegExpMatchArray | null;
    if (p === '/v1/me') return { status: 200, json: { id: 'u1', email: 'ann@example.com', displayName: 'Ann Lee', avatarUrl: null, statusEmoji: '', statusText: '' } };
    if (p === '/v1/me/workspaces') return { status: 200, json: { workspaces: [{ id: 'w1', name: 'Acme', avatarUrl: null, role: 'owner', unreadCount: 3 }] } };
    if (p === '/v1/auth/logout') return { status: 200, json: { ok: true } };
    if (p === '/v1/mail/providers') {
      const domain = (q.get('email') ?? '').split('@')[1]?.toLowerCase() ?? '';
      return { status: 200, json: PRESETS[domain] ?? null };
    }
    if (p === '/v1/mail/accounts' && method === 'GET') return { status: 200, json: { accounts: [...boxes.values()].map((b) => b.account) } };
    if (p === '/v1/mail/accounts' && method === 'POST') {
      const a = body as NewAccount;
      verify(a);
      // "stale" connects, then behaves as an account whose password later stopped working.
      const stale = a.password === 'stale';
      const account: MailAccount = {
        id: `acc_${boxes.size + 1}_${Date.now()}`,
        email: a.email,
        displayName: a.displayName,
        imap: a.imap,
        smtp: a.smtp,
        status: stale ? 'auth_failed' : 'ok',
        tabs: [],
        ...(stale ? { statusMessage: 'AUTHENTICATIONFAILED: Invalid credentials' } : {}),
      };
      const box = sampleMailbox();
      box.account = account;
      boxes.set(account.id, box);
      return { status: 201, json: { account } };
    }
    if ((m = p.match(/^\/v1\/mail\/accounts\/([^/]+)$/))) {
      const b = boxOf(decodeURIComponent(m[1]!));
      if (method === 'DELETE') {
        boxes.delete(b.account.id);
        return { status: 200, json: { ok: true } };
      }
      const patch = body as Partial<NewAccount> & { tabs?: TabCategory[] };
      verify(patch);
      if (patch.tabs) b.account = { ...b.account, tabs: (['promotions', 'social', 'updates', 'forums'] as const).filter((t) => patch.tabs!.includes(t)) };
      b.account = { ...b.account, ...(patch.displayName ? { displayName: patch.displayName } : {}), ...(patch.imap ? { imap: patch.imap } : {}), ...(patch.smtp ? { smtp: patch.smtp } : {}) };
      if (patch.password) b.account = { ...b.account, status: 'ok' };
      delete b.account.statusMessage;
      return { status: 200, json: { account: b.account } };
    }
    if ((m = p.match(/^\/v1\/mail\/accounts\/([^/]+)\/(.*)$/))) {
      const b = boxOf(decodeURIComponent(m[1]!));
      const rest = m[2]!;
      if (b.account.status !== 'ok') throw new HttpError(400, b.account.status, b.account.statusMessage ?? 'The mail server refused the login.');
      if (rest === 'folders') return { status: 200, json: { folders: counted(b) } };
      if (rest === 'messages' && method === 'GET') {
        const folder = q.get('folder') ?? 'INBOX';
        const limit = Number(q.get('limit') ?? 50);
        const before = q.get('before') ? Number(q.get('before')) : Infinity;
        const text = (q.get('q') ?? '').toLowerCase();
        // A tab of INBOX (ignored while searching, or with tabs off).
        const category = folder === 'INBOX' && !text && b.account.tabs.length ? (q.get('category') as Category | null) : null;
        const all = b.messages
          .filter((x) => x.folder === folder && x.uid < before)
          .filter((x) => !text || [x.subject, x.text ?? '', x.from?.name ?? '', x.from?.address ?? ''].some((s) => s.toLowerCase().includes(text)))
          .filter((x) => !category || tabOf(b, x) === category)
          .sort((x, y) => y.uid - x.uid);
        const page = all.slice(0, limit);
        await new Promise((r) => setTimeout(r, 150));
        return { status: 200, json: { messages: page.map((x) => withTab(b, x, summary(x))), next: all.length > limit ? page[page.length - 1]!.uid : null } };
      }
      if (rest === 'messages/category') {
        const { folder, uids, category } = body as { folder: string; uids: number[]; category: Category };
        const senders = [...new Set(uids.map((uid) => find(b, folder, uid).from?.address.toLowerCase() ?? '').filter(Boolean))];
        const previous = senders.map((address) => ({ address, category: b.overrides.get(address) ?? null }));
        for (const s of senders) b.overrides.set(s, category);
        return { status: 200, json: { ok: true, senders, previous } };
      }
      if (rest === 'senders/category') {
        for (const s of (body as { senders: { address: string; category: Category | null }[] }).senders) {
          if (s.category) b.overrides.set(s.address, s.category);
          else b.overrides.delete(s.address);
        }
        return { status: 200, json: { ok: true } };
      }
      if (rest === 'messages' && method === 'PATCH') {
        const { folder, uids, seen, flagged } = body as { folder: string; uids: number[]; seen?: boolean; flagged?: boolean };
        for (const uid of uids) {
          const x = find(b, folder, uid);
          if (seen !== undefined) x.seen = seen;
          if (flagged !== undefined) x.flagged = flagged;
        }
        return { status: 200, json: { ok: true } };
      }
      if (rest === 'messages/move' || rest === 'messages/delete') {
        const { folder, uids, to } = body as { folder: string; uids: number[]; to?: string };
        const trash = b.folders.find((f) => f.specialUse === 'trash')!.path;
        for (const uid of uids) {
          const x = find(b, folder, uid);
          if (rest === 'messages/delete' && folder === trash) b.messages.splice(b.messages.indexOf(x), 1);
          else {
            x.folder = rest === 'messages/move' ? to! : trash;
            x.uid = b.nextUid++;
          }
        }
        return { status: 200, json: { ok: true } };
      }
      if (rest === 'send') {
        const s = body as { to: { name: string; address: string }[]; cc?: []; subject: string; html: string; text?: string; inReplyTo?: string; references?: string[]; attachments?: { filename: string; contentType: string; contentBase64: string }[] };
        const id = `<sent${b.nextUid}@mock.test>`;
        b.messages.push({
          uid: b.nextUid++,
          folder: b.folders.find((f) => f.specialUse === 'sent')!.path,
          messageId: id,
          from: { name: b.account.displayName, address: b.account.email },
          to: s.to,
          cc: s.cc ?? [],
          bcc: [],
          replyTo: [],
          subject: s.subject,
          snippet: (s.text ?? '').slice(0, 160),
          date: new Date().toISOString(),
          seen: true,
          flagged: false,
          answered: false,
          hasAttachments: !!s.attachments?.length,
          size: s.html.length,
          inReplyTo: s.inReplyTo ?? null,
          references: s.references ?? [],
          html: s.html,
          text: s.text ?? null,
          attachments: (s.attachments ?? []).map((a) => ({ filename: a.filename, mimeType: a.contentType, contentId: null, inline: false, bytes: Buffer.from(a.contentBase64, 'base64') })),
        });
        const original = s.inReplyTo && b.messages.find((x) => x.messageId === s.inReplyTo);
        if (original) original.answered = true;
        return { status: 200, json: { ok: true, messageId: id } };
      }
      if ((m = rest.match(/^messages\/(\d+)\/attachments\/(\d+)$/))) {
        const x = find(b, q.get('folder') ?? 'INBOX', Number(m[1]));
        const a = x.attachments[Number(m[2])];
        if (!a) throw new HttpError(404, 'not_found', 'No such attachment');
        return { status: 200, bytes: { data: a.bytes, type: a.mimeType, disposition: `${q.get('inline') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}` } };
      }
      if ((m = rest.match(/^messages\/(\d+)$/))) {
        const x = find(b, q.get('folder') ?? 'INBOX', Number(m[1]));
        await new Promise((r) => setTimeout(r, 100));
        return {
          status: 200,
          json: { message: { ...x, attachments: x.attachments.map((a, index) => ({ index, filename: a.filename, mimeType: a.mimeType, size: a.bytes.length, contentId: a.contentId, inline: a.inline })) } },
        };
      }
    }
    throw new HttpError(404, 'not_found', `No mock for ${method} ${p}`);
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

/** The Vite plugin: answers /v1/* from the mock before anything else. */
export function mailMock(): Plugin {
  const handle = createMockApi(process.env.MAIL_MOCK === 'empty');
  return {
    name: 'flow-mail-mock',
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!req.url?.startsWith('/v1/')) return next();
        try {
          const out = await handle(req.method ?? 'GET', new URL(req.url, 'http://mock'), await readBody(req));
          res.statusCode = out.status;
          if (out.bytes) {
            res.setHeader('content-type', out.bytes.type);
            res.setHeader('content-disposition', out.bytes.disposition);
            res.end(out.bytes.data);
          } else {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(out.json));
          }
        } catch (e) {
          const err = e instanceof HttpError ? e : new HttpError(500, 'server_error', String(e));
          res.statusCode = err.status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { code: err.code, message: err.message } }));
        }
      });
    },
  };
}
