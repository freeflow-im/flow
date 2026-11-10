import { describe, expect, it } from 'vitest';
import { draftOf, mailContext, messageId, parseMessageId, refOfLink, runMailClientCalls, savedFileOf } from './assistant';
import { chatScope, MAIL_CHAT } from '../../../docs/shared/agent/protocol';

const ACC = '0b6f1c2e-1111-4222-8333-444455556666';

describe('message ids', () => {
  it('round-trip the mail tools’ <account>:<folder>:<uid>, colons in the folder too', () => {
    expect(parseMessageId(messageId({ account: ACC, folder: '[Gmail]/All Mail', uid: 42 }))).toEqual({ account: ACC, folder: '[Gmail]/All Mail', uid: 42 });
    expect(parseMessageId(`${ACC}:Work:2026:7`)).toEqual({ account: ACC, folder: 'Work:2026', uid: 7 });
    for (const bad of ['', 'x', `${ACC}:INBOX`, `${ACC}:INBOX:0`, `${ACC}::3`, `:INBOX:3`, 3]) expect(parseMessageId(bad)).toBeNull();
  });

  it('reads Mail’s links to a message, only on this origin', () => {
    const origin = 'https://app.test';
    expect(refOfLink(`${origin}/mail/?account=${ACC}&folder=Drafts&uid=9`, origin)).toEqual({ account: ACC, folder: 'Drafts', uid: 9 });
    expect(refOfLink(`/mail/?account=${ACC}&folder=INBOX&uid=3`, origin)).toEqual({ account: ACC, folder: 'INBOX', uid: 3 });
    expect(refOfLink(`https://evil.test/mail/?account=${ACC}&folder=INBOX&uid=3`, origin)).toBeNull();
    expect(refOfLink(`${origin}/docs/s/abc`, origin)).toBeNull();
    expect(refOfLink(`${origin}/mail/?account=${ACC}&folder=Drafts`, origin)).toBeNull();
  });
});

describe('the mail context', () => {
  const account = { id: ACC, email: 'ann@test.local' };

  it('names the open message by the tools’ id, with its sender, subject and date', () => {
    const ctx = mailContext({
      account,
      folder: 'INBOX',
      tab: 'primary',
      search: '',
      message: { uid: 12, folder: 'INBOX', subject: 'Lunch?', from: { name: 'Bo', address: 'bo@test.local' }, date: '2026-11-03T10:00:00.000Z' },
      checked: [],
    });
    expect(ctx).toEqual({
      page: 'mail',
      accountId: ACC,
      account: 'ann@test.local',
      folder: 'INBOX',
      tab: 'primary',
      message: { id: `${ACC}:INBOX:12`, accountId: ACC, folder: 'INBOX', uid: 12, subject: 'Lunch?', from: 'Bo <bo@test.local>', date: '2026-11-03T10:00:00.000Z' },
    });
    // Mail has a chat of its own, apart from Docs' home chat and files' chats.
    expect(chatScope(ctx)).toBe(MAIL_CHAT);
  });

  it('in the list, names the search and the checked messages (at most 50)', () => {
    const ctx = mailContext({ account, folder: 'Archive', tab: null, search: 'invoice', message: null, checked: Array.from({ length: 60 }, (_, i) => i + 1) });
    expect(ctx).toMatchObject({ folder: 'Archive', search: 'invoice' });
    expect(ctx.message).toBeUndefined();
    expect(ctx.tab).toBeUndefined();
    expect(ctx.selected).toHaveLength(50);
    expect(ctx.selected?.[0]).toBe(`${ACC}:Archive:1`);
  });
});

describe('what the chat links to', () => {
  const tool = (name: string, result: unknown, status: 'ok' | 'error' = 'ok') => ({ kind: 'tool' as const, id: 't1', name, input: {}, status, result: JSON.stringify(result) });

  it('a draft the assistant made', () => {
    expect(draftOf(tool('create_mail_draft', { saved: true, draft_id: `${ACC}:Drafts:5`, link: 'x' }))).toEqual({ account: ACC, folder: 'Drafts', uid: 5 });
    expect(draftOf(tool('create_mail_draft', { saved: true, link: 'x' }))).toBeNull();
    expect(draftOf(tool('create_mail_draft', { draft_id: `${ACC}:Drafts:5` }, 'error'))).toBeNull();
    expect(draftOf(tool('read_mail', { draft_id: `${ACC}:Drafts:5` }))).toBeNull();
  });

  it('a file saved to Docs, on its Docs page', () => {
    expect(savedFileOf(tool('save_mail_attachment_to_docs', { saved: true, filename: 'q3.xlsx', file: { id: 's1', kind: 'sheet', title: 'q3' } }))).toEqual({ href: '/docs/s/s1', name: 'q3' });
    expect(savedFileOf(tool('save_mail_attachment_to_docs', { saved: true, filename: 'a.pdf', file: { id: 'f1', kind: 'file', filename: 'a.pdf' } }))).toEqual({ href: '/docs/f/f1', name: 'a.pdf' });
    expect(savedFileOf(tool('save_mail_attachment_to_docs', { saved: true }))).toBeNull();
  });
});

describe('browser tools in Mail', () => {
  it('opens a message for open_mail_message, and answers any other tool as unknown (the server offers Mail only its own)', async () => {
    const shown: unknown[] = [];
    const results = await runMailClientCalls(
      [
        { id: 'a', name: 'open_mail_message', input: { id: `${ACC}:INBOX:3` } },
        { id: 'b', name: 'open_mail_message', input: { id: 'other:INBOX:3' } },
        { id: 'c', name: 'open_mail_message', input: { id: 'nope' } },
        { id: 'd', name: 'read_doc', input: {} },
      ],
      (ref) => {
        shown.push(ref);
        return ref.account === ACC;
      },
    );
    expect(shown).toEqual([
      { account: ACC, folder: 'INBOX', uid: 3 },
      { account: 'other', folder: 'INBOX', uid: 3 },
    ]);
    expect(results.map((r) => [r.id, !!r.isError])).toEqual([
      ['a', false],
      ['b', true],
      ['c', true],
      ['d', true],
    ]);
    expect(results[3]?.content).toBe('Unknown tool read_doc.');
  });
});
