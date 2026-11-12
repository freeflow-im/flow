import { describe, expect, it } from 'vitest';
import type { MailAccount, MailFolder } from '../api';
import { mailMenu, mailPicker } from './homeMenu';

const folder = (path: string, over: Partial<MailFolder> = {}) => ({ path, name: path.split('/').pop()!, delimiter: '/', specialUse: null, unread: 0, total: 0, ...over }) as MailFolder;
const account = (id: string, email: string) => ({ id, email, displayName: '' }) as MailAccount;

describe('mailMenu', () => {
  const folders = [folder('INBOX', { specialUse: 'inbox', unread: 4 }), folder('Sent', { specialUse: 'sent', unread: 2 }), folder('Drafts', { specialUse: 'drafts', total: 3 }), folder('hiring', { unread: 1 })];

  it('lists only New message, Inbox and Drafts', () => {
    const items = mailMenu([account('a', 'me@x.test')], account('a', 'me@x.test'), folders);
    expect(items.map((i) => [i.id, i.label, i.count ?? null])).toEqual([
      ['compose', 'New message', null],
      ['folder:INBOX', 'Inbox', 4],
      ['folder:Drafts', 'Drafts', 3],
    ]);
    expect(items[1]!.href).toBe('/mail/?account=a&folder=INBOX');
    expect(items[1]!.children).toBeUndefined();
  });

  it('puts several accounts in the Mail row picker, not under Inbox', () => {
    const accounts = [account('a', 'me@x.test'), account('b', 'me@y.test')];
    const items = mailMenu(accounts, accounts[1]!, folders);
    expect(items).toHaveLength(3);
    expect(items[1]!.children).toBeUndefined();
    const picker = mailPicker(accounts, accounts[1]!)!;
    expect(picker.items.map((c) => [c.id, c.label, c.href])).toEqual([
      ['account:a', 'me@x.test', '/mail/?account=a'],
      ['account:b', 'me@y.test', '/mail/?account=b'],
    ]);
    expect(picker.selected).toBe('account:b');
    expect(picker.label).toBe('y.test');
  });

  it('names the account by its domain, or its address when the domain is shared', () => {
    const accounts = [account('a', 'me@gmail.com'), account('b', 'work@Gmail.com'), account('c', 'pat@lockedin.ai')];
    expect(mailPicker(accounts, accounts[2]!)!.label).toBe('lockedin.ai');
    expect(mailPicker(accounts, accounts[1]!)!.label).toBe('work@Gmail.com');
  });

  it('has no picker with one account', () => {
    expect(mailPicker([account('a', 'me@x.test')], account('a', 'me@x.test'))).toBeNull();
  });
});
