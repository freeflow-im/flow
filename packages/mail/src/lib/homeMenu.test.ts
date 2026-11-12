import { describe, expect, it } from 'vitest';
import type { MailAccount, MailFolder } from '../api';
import { mailMenu } from './homeMenu';

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

  it('opens the accounts under Inbox when there are several', () => {
    const items = mailMenu([account('a', 'me@x.test'), account('b', 'me@y.test')], account('a', 'me@x.test'), folders);
    expect(items).toHaveLength(3);
    expect(items[1]!.children!.map((c) => [c.id, c.label])).toEqual([
      ['account:a', 'me@x.test'],
      ['account:b', 'me@y.test'],
    ]);
  });
});
