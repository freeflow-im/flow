import { describe, expect, it } from 'vitest';
import type { MessageDetail } from './convert';
import { groupIds, MAIL_TOOLS, mailToolsFor, MailToolError, messageId, parseMessageId, validateMailInput, type MailToolContext } from './mailTools';

const ACC = '0b6f1c2e-1111-4222-8333-444455556666';
const OTHER = '9e9e9e9e-1111-4222-8333-444455556666';
const names = (scopes: string[]) => mailToolsFor(scopes).map((t) => t.name);
const tool = (name: string) => MAIL_TOOLS.find((t) => t.name === name)!;

describe('message ids', () => {
  it('round-trips, folders with colons and slashes included', () => {
    for (const folder of ['INBOX', '[Gmail]/All Mail', 'Work:2026/Q3', 'a:b:c']) {
      const id = messageId(ACC, folder, 42);
      expect(id).toBe(`${ACC}:${folder}:42`);
      expect(parseMessageId(id)).toEqual({ account: ACC, folder, uid: 42 });
    }
  });

  it('refuses what is not one', () => {
    for (const bad of ['', '42', `${ACC}:INBOX`, `${ACC}::42`, `:INBOX:42`, `${ACC}:INBOX:0`, `${ACC}:INBOX:4.5`, `${ACC}:INBOX:x`]) expect(() => parseMessageId(bad)).toThrow(MailToolError);
  });

  it('groups ids by account and folder, each UID once', () => {
    expect(groupIds([`${ACC}:INBOX:1`, `${ACC}:Sent:2`, `${ACC}:INBOX:3`, `${ACC}:INBOX:1`, `${OTHER}:INBOX:1`])).toEqual([
      { account: ACC, folder: 'INBOX', uids: [1, 3] },
      { account: ACC, folder: 'Sent', uids: [2] },
      { account: OTHER, folder: 'INBOX', uids: [1] },
    ]);
  });
});

describe('scope gating', () => {
  it('lists only what the scopes allow', () => {
    expect(names([])).toEqual([]);
    expect(names(['files:read', 'files:write'])).toEqual([]);
    expect(names(['mail:read'])).toEqual(['list_mail_accounts', 'list_mail_folders', 'search_mail', 'read_mail']);
    expect(names(['mail:read', 'files:write'])).toContain('save_mail_attachment_to_docs');
    expect(names(['mail:read', 'files:read'])).not.toContain('save_mail_attachment_to_docs');
    const organise = names(['mail:read', 'mail:write']);
    for (const n of ['mark_mail', 'move_mail', 'archive_mail', 'move_mail_to_tab', 'trash_mail', 'create_mail_draft']) expect(organise).toContain(n);
    expect(organise).not.toContain('send_mail');
    expect(names(['mail:read', 'mail:write', 'mail:send'])).toContain('send_mail');
    expect(names(['files:read', 'files:write', 'mail:read', 'mail:write', 'mail:send'])).toHaveLength(MAIL_TOOLS.length);
  });

  it('marks the tools that change nothing as read-only, and gives every tool a description and described fields', () => {
    for (const t of MAIL_TOOLS) {
      expect(t.annotations.readOnlyHint).toBe(t.scopes.every((s) => s === 'mail:read'));
      expect(t.description.length).toBeGreaterThan(60);
      for (const [field, schema] of Object.entries(t.shape)) expect(schema.description, `${t.name}.${field}`).toBeTruthy();
    }
  });

  it('validates input against the tool’s schema', () => {
    expect(() => validateMailInput(tool('read_mail'), { ids: [] })).toThrow(/ids/);
    expect(() => validateMailInput(tool('read_mail'), { ids: Array.from({ length: 21 }, (_, i) => `${ACC}:INBOX:${i + 1}`) })).toThrow(/ids/);
    expect(() => validateMailInput(tool('search_mail'), { limit: 51 })).toThrow(/limit/);
    expect(() => validateMailInput(tool('search_mail'), { tab: 'spam' })).toThrow(/tab/);
    expect(validateMailInput(tool('search_mail'), { query: 'from:ann' })).toEqual({ query: 'from:ann' });
  });
});

/** A Mail object with one account and one message, recording what it was asked. */
function fakeMail(opts: { tabs?: string[] } = {}) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const original: MessageDetail = {
    uid: 7, folder: 'INBOX', messageId: '<orig@example.com>', from: { name: 'Bo', address: 'bo@example.com' }, to: [{ name: 'Ann', address: 'ann@test.local' }], cc: [{ name: '', address: 'cy@example.com' }],
    subject: 'Plans', snippet: 'Hello', date: '2026-11-01T10:00:00.000Z', seen: false, flagged: false, answered: false, hasAttachments: true, size: 900,
    replyTo: [], bcc: [], inReplyTo: null, references: ['<root@example.com>'], html: '<p>Hello <a href="https://x.test/a">there</a></p><script>bad()</script>', text: 'Hello there',
    attachments: [{ index: 0, filename: 'plan.csv', mimeType: 'text/csv', size: 12, contentId: null, inline: false }],
  };
  const mail: MailToolContext['mail'] = async (path, init) => {
    const url = new URL(`http://mail${path}`);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname + url.search, ...(body ? { body } : {}) });
    const json = (v: unknown, status = 200) => Response.json(v, { status });
    if (url.pathname === '/v1/mail/accounts') return json({ accounts: [{ id: ACC, email: 'ann@test.local', displayName: 'Ann', status: 'ok', tabs: opts.tabs ?? [] }] });
    if (!url.pathname.startsWith(`/v1/mail/accounts/${ACC}/`)) return json({ error: { code: 'not_found', message: 'no such account' } }, 404);
    const rest = url.pathname.slice(`/v1/mail/accounts/${ACC}`.length);
    if (rest === '/messages' && method === 'GET') return json({ messages: [{ ...original, category: 'primary' }, { ...original, uid: 6, category: 'promotions' }], next: 6 });
    if (rest === '/messages/7' && method === 'GET') return json({ message: original });
    if (rest === '/folders') return json({ folders: [{ path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: 'inbox', unread: 1, total: 2 }, { path: 'Archive', name: 'Archive', delimiter: '/', specialUse: 'archive', unread: 0, total: 0 }] });
    if (rest === '/drafts' && method === 'POST') return json({ ok: true, folder: 'Drafts', uid: 3, messageId: '<d@test.local>' }, 201);
    if (rest === '/messages/7/attachments/0') return new Response('a,b\n1,2\n', { headers: { 'content-type': 'text/csv', 'content-disposition': "attachment; filename=\"plan.csv\"; filename*=UTF-8''plan%20v2.csv" } });
    return json({ ok: true });
  };
  return { calls, ctx: { mail, origin: 'https://app.test' } as MailToolContext };
}

describe('the tools against a Mail object', () => {
  it('search_mail passes the query as Gmail syntax and returns opaque ids', async () => {
    const { ctx, calls } = fakeMail();
    const r = await tool('search_mail').run(ctx, { query: 'from:bo has:attachment', unread_only: true, limit: 5 });
    expect(calls.at(-1)!.path).toBe(`/v1/mail/accounts/${ACC}/messages?folder=INBOX&limit=5&q=from%3Abo+has%3Aattachment&raw=1&unread=1`);
    const first = (r.messages as Record<string, unknown>[])[0]!;
    expect(first).toMatchObject({ id: `${ACC}:INBOX:7`, from: 'Bo <bo@example.com>', subject: 'Plans', unread: true, has_attachments: true });
    expect(r.next).toBe(6);
  });

  it('search_mail keeps a tab with a query by each message’s tab, and refuses a tab where there are none', async () => {
    const { ctx } = fakeMail({ tabs: ['promotions'] });
    const r = await tool('search_mail').run(ctx, { query: 'plans', tab: 'promotions' });
    expect((r.messages as { id: string }[]).map((m) => m.id)).toEqual([`${ACC}:INBOX:6`]);
    await expect(tool('search_mail').run(ctx, { tab: 'social', folder: 'Sent' })).rejects.toThrow(/only in INBOX/);
    await expect(tool('search_mail').run(fakeMail().ctx, { tab: 'social' })).rejects.toThrow(/does not split/);
  });

  it('read_mail gives the body as text with links, the attachments, and refuses another person’s ids', async () => {
    const { ctx } = fakeMail();
    const r = await tool('read_mail').run(ctx, { ids: [`${ACC}:INBOX:7`, `${OTHER}:INBOX:7`] });
    const m = (r.messages as Record<string, unknown>[])[0]!;
    expect(m.body).toBe('Hello there (https://x.test/a)');
    expect(m.attachments).toEqual([{ index: 0, filename: 'plan.csv', type: 'text/csv', size: 12 }]);
    expect((r.errors as { id: string }[])[0]!.id).toBe(`${OTHER}:INBOX:7`);
    await expect(tool('read_mail').run(ctx, { ids: [`${OTHER}:INBOX:7`] })).rejects.toThrow(/Not found/);
  });

  it('create_mail_draft replies: recipients, subject, threading and the quote, from the original’s account', async () => {
    const { ctx, calls } = fakeMail();
    const r = await tool('create_mail_draft').run(ctx, { body: 'Sounds **good**.', reply_to_id: `${ACC}:INBOX:7`, reply_all: true });
    const sent = calls.find((c) => c.path.endsWith('/drafts'))!.body!;
    expect(sent.to).toEqual([{ name: 'Bo', address: 'bo@example.com' }]);
    expect(sent.cc).toEqual([{ name: '', address: 'cy@example.com' }]);
    expect(sent.subject).toBe('Re: Plans');
    expect(sent.inReplyTo).toBe('<orig@example.com>');
    expect(sent.references).toEqual(['<root@example.com>', '<orig@example.com>']);
    expect(sent.html).toMatch(/^<p>Sounds <strong>good<\/strong>\.<\/p>/);
    expect(sent.html).toContain('<blockquote>');
    expect(sent.html).not.toContain('script');
    expect(sent.text).toMatch(/^Sounds \*\*good\*\*\.\n\nOn .*Bo <bo@example.com> wrote:\n> Hello there/);
    expect(r).toMatchObject({ draft_id: `${ACC}:Drafts:3`, link: `https://app.test/mail/?account=${ACC}&folder=Drafts&uid=3` });
  });

  it('create_mail_draft forwards with the original’s attachments, and checks addresses', async () => {
    const { ctx, calls } = fakeMail();
    await tool('create_mail_draft').run(ctx, { to: ['Dee <dee@example.com>'], body: 'FYI', forward_id: `${ACC}:INBOX:7` });
    const sent = calls.find((c) => c.path.endsWith('/drafts'))!.body!;
    expect(sent).toMatchObject({ to: [{ name: 'Dee', address: 'dee@example.com' }], subject: 'Fwd: Plans', attachFrom: { folder: 'INBOX', uid: 7 } });
    expect(sent.inReplyTo).toBeUndefined();
    await expect(tool('create_mail_draft').run(ctx, { to: ['not an address'], body: 'x' })).rejects.toThrow(/not an email address/);
    await expect(tool('create_mail_draft').run(ctx, { body: 'x', reply_to_id: `${OTHER}:INBOX:7` })).rejects.toThrow(/Not found/);
  });

  it('trash_mail never expunges; archive_mail moves to Archive; send_mail sends a draft as it is', async () => {
    const { ctx, calls } = fakeMail();
    await tool('trash_mail').run(ctx, { ids: [`${ACC}:INBOX:7`] });
    expect(calls.at(-1)!.body).toEqual({ folder: 'INBOX', uids: [7], trashOnly: true });
    await tool('archive_mail').run(ctx, { ids: [`${ACC}:INBOX:7`] });
    expect(calls.at(-1)!.body).toEqual({ folder: 'INBOX', uids: [7], to: 'Archive' });
    await expect(tool('send_mail').run(ctx, { draft_id: `${ACC}:Drafts:3`, body: 'x' })).rejects.toThrow(/as it is/);
    await tool('send_mail').run(ctx, { draft_id: `${ACC}:Drafts:3` });
    expect(calls.at(-1)!.path).toBe(`/v1/mail/accounts/${ACC}/drafts/3/send?folder=Drafts`);
  });

  it('save_mail_attachment_to_docs hands the bytes and the file name to Docs', async () => {
    const { ctx } = fakeMail();
    let got: { bytes: Buffer; filename: string } | null = null;
    ctx.saveToDocs = async (bytes, filename) => ((got = { bytes, filename }), { file: { id: 's1', kind: 'sheet', url: 'https://app.test/workspace/s/s1' }, warnings: [] });
    const r = await tool('save_mail_attachment_to_docs').run(ctx, { id: `${ACC}:INBOX:7`, index: 0 });
    expect(got!.filename).toBe('plan v2.csv');
    expect(got!.bytes.toString()).toBe('a,b\n1,2\n');
    expect(r.file).toMatchObject({ id: 's1', kind: 'sheet' });
  });
});
