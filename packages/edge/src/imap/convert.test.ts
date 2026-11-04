import { describe, expect, it } from 'vitest';
import type { FetchMessageObject, ListResponse, MessageStructureObject } from 'imapflow';
import PostalMime from 'postal-mime';
import { contentDisposition, filenameFromDisposition, hasAttachments, snippetOf, textPartOf, toDetail, toFolders, toSummary } from './convert';

const multipart: MessageStructureObject = {
  type: 'multipart/mixed',
  childNodes: [
    { part: '1', type: 'multipart/alternative', childNodes: [
      { part: '1.1', type: 'text/plain', encoding: 'quoted-printable', parameters: { charset: 'utf-8' } },
      { part: '1.2', type: 'text/html', encoding: 'base64', parameters: { charset: 'utf-8' } },
    ] },
    { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'q3.pdf' }, encoding: 'base64' },
  ],
};

describe('a message summary from FETCH', () => {
  it('maps the envelope, flags and structure', () => {
    const m = {
      seq: 4, uid: 42, size: 2048,
      flags: new Set(['\\Seen', '\\Answered']),
      internalDate: new Date('2026-11-01T10:00:00Z'),
      envelope: {
        date: new Date('2026-11-01T09:59:00Z'), subject: 'Q3 numbers', messageId: '<abc@example.com>',
        from: [{ name: 'Bob', address: 'bob@example.com' }], to: [{ address: 'ann@test.local' }], cc: [{ name: 'Cy', address: 'cy@example.com' }],
      },
      bodyStructure: multipart,
    } as FetchMessageObject;
    expect(toSummary(m, 'INBOX', 'Hello')).toEqual({
      uid: 42, folder: 'INBOX', messageId: '<abc@example.com>',
      from: { name: 'Bob', address: 'bob@example.com' }, to: [{ name: '', address: 'ann@test.local' }], cc: [{ name: 'Cy', address: 'cy@example.com' }],
      subject: 'Q3 numbers', snippet: 'Hello', date: '2026-11-01T09:59:00.000Z',
      seen: true, flagged: false, answered: true, hasAttachments: true, size: 2048,
    });
  });

  it('copes with a bare message: no envelope fields, an unparseable date', () => {
    const m = { seq: 1, uid: 7, envelope: { date: 'garbage' }, internalDate: new Date('2026-01-02T00:00:00Z'), bodyStructure: { type: 'text/plain' } } as FetchMessageObject;
    const s = toSummary(m, 'Archive');
    expect(s).toMatchObject({ uid: 7, from: null, to: [], subject: '', messageId: null, date: '2026-01-02T00:00:00.000Z', seen: false, hasAttachments: false, size: 0 });
  });

  it('counts attachments but not inline images or text bodies', () => {
    expect(hasAttachments({ type: 'text/plain' })).toBe(false);
    expect(hasAttachments({ type: 'multipart/related', childNodes: [{ part: '1', type: 'text/html' }, { part: '2', type: 'image/png', disposition: 'inline', id: '<logo>', parameters: { name: 'logo.png' } }] })).toBe(false);
    expect(hasAttachments({ type: 'multipart/mixed', childNodes: [{ part: '1', type: 'text/plain' }, { part: '2', type: 'image/jpeg', parameters: { name: 'photo.jpg' } }] })).toBe(true);
    expect(hasAttachments(multipart)).toBe(true);
  });
});

describe('snippets', () => {
  it('finds the plain text part, else the HTML one', () => {
    expect(textPartOf(multipart)).toEqual({ part: '1.1', type: 'text/plain', encoding: 'quoted-printable', charset: 'utf-8' });
    expect(textPartOf({ type: 'text/html', encoding: 'base64' })).toMatchObject({ part: '1', type: 'text/html' });
    expect(textPartOf({ type: 'multipart/mixed', childNodes: [{ part: '1', type: 'image/png' }] })).toBeNull();
  });

  it('decodes quoted-printable, base64 and HTML, cut short', () => {
    const qp = new TextEncoder().encode('Caf=C3=A9 at noon?=\r\n Sure.\r\n> quoted line\r\nBye');
    expect(snippetOf(qp, { part: '1', type: 'text/plain', encoding: 'quoted-printable', charset: 'utf-8' })).toBe('Café at noon? Sure. Bye');
    const b64 = new TextEncoder().encode(Buffer.from('<html><head><style>p{}</style></head><body><p>Hi &amp; welcome</p></body></html>').toString('base64').slice(0, 84));
    expect(snippetOf(b64, { part: '1', type: 'text/html', encoding: 'base64', charset: 'utf-8' })).toBe('Hi & welcome');
    const long = new TextEncoder().encode('word '.repeat(100));
    const s = snippetOf(long, { part: '1', type: 'text/plain', encoding: '7bit', charset: 'us-ascii' });
    expect(s.length).toBeLessThanOrEqual(160);
    expect(s.endsWith('…')).toBe(true);
  });
});

describe('folders', () => {
  const f = (path: string, specialUse?: string, flags: string[] = []): ListResponse => ({ path, pathAsListed: path, name: path.split('/').pop()!, delimiter: '/', parent: [], parentPath: '', flags: new Set(flags), specialUse, listed: true, subscribed: true, status: { path, messages: 3, unseen: 1 } });
  it('puts INBOX first, then special-use folders, then the rest by name, without unselectable ones', () => {
    const out = toFolders([f('Zeta'), f('Trash', '\\Trash'), f('[Gmail]', undefined, ['\\Noselect']), f('Alpha'), f('Sent', '\\Sent'), f('INBOX', '\\Inbox')]);
    expect(out.map((x) => x.path)).toEqual(['INBOX', 'Sent', 'Trash', 'Alpha', 'Zeta']);
    expect(out[0]).toEqual({ path: 'INBOX', name: 'Inbox', delimiter: '/', specialUse: 'inbox', unread: 1, total: 3 });
    expect(out[3].specialUse).toBeNull();
  });
});

describe('a message in full', () => {
  it('adds the parsed bodies and attachments', async () => {
    const raw = [
      'From: Bob <bob@example.com>', 'To: ann@test.local', 'Reply-To: help@example.com', 'Subject: Hi', 'Message-ID: <m1@example.com>',
      'In-Reply-To: <m0@example.com>', 'References: <a@example.com> <m0@example.com>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '',
      '--b', 'Content-Type: text/html; charset=utf-8', '', '<p>Hello <img src="cid:logo@x"></p>',
      '--b', 'Content-Type: image/png', 'Content-ID: <logo@x>', 'Content-Disposition: inline; filename="logo.png"', 'Content-Transfer-Encoding: base64', '', 'iVBORw0K',
      '--b', 'Content-Type: text/plain; name="notes.txt"', 'Content-Disposition: attachment; filename="notes.txt"', '', 'some notes',
      '--b--', '',
    ].join('\r\n');
    const email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
    const summary = toSummary({ seq: 1, uid: 9, envelope: { subject: 'Hi' }, flags: new Set() } as FetchMessageObject, 'INBOX');
    const d = toDetail(summary, email);
    expect(d.from).toEqual({ name: 'Bob', address: 'bob@example.com' });
    expect(d.replyTo).toEqual([{ name: '', address: 'help@example.com' }]);
    expect(d.inReplyTo).toBe('<m0@example.com>');
    expect(d.references).toEqual(['<a@example.com>', '<m0@example.com>']);
    expect(d.html).toContain('cid:logo@x');
    expect(d.attachments).toEqual([
      { index: 0, filename: 'logo.png', mimeType: 'image/png', size: 6, contentId: 'logo@x', inline: true },
      { index: 1, filename: 'notes.txt', mimeType: 'text/plain', size: 11, contentId: null, inline: false },
    ]);
  });

  it('names a download in ASCII and UTF-8', () => {
    expect(contentDisposition('attachment', 'Résumé "final".pdf')).toBe(`attachment; filename="R_sum_ _final_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.pdf`);
    expect(filenameFromDisposition(contentDisposition('attachment', 'Résumé "final".pdf'))).toBe('Résumé "final".pdf');
    expect(filenameFromDisposition('attachment; filename="plain name.txt"')).toBe('plain name.txt');
    expect(filenameFromDisposition('inline; filename=bare.csv')).toBe('bare.csv');
    expect(filenameFromDisposition("attachment; filename=\"x\"; filename*=UTF-8''%E0%A4%A")).toBe('x');
    expect(filenameFromDisposition('attachment')).toBeNull();
    expect(filenameFromDisposition(null)).toBeNull();
  });
});
