import { describe, expect, it } from 'vitest';
import type { MailAccount, MailFolder } from '../api';
import { mailMenu } from './homeMenu';

const folder = (path: string, over: Partial<MailFolder> = {}) => ({ path, name: path.split('/').pop()!, delimiter: '/', specialUse: null, unread: 0, total: 0, ...over }) as MailFolder;
const account = (id: string, email: string) => ({ id, email, displayName: '' }) as MailAccount;

describe('mailMenu', () => {
  const folders = [
    folder('INBOX', { unread: 4 }),
    folder('Sent', { specialUse: 'sent', unread: 2 }),
    folder('Drafts', { specialUse: 'drafts', total: 3 }),
    folder('hiring', { unread: 1 }),
    folder('clients'),
    folder('clients/acme'),
  ];

  it('lists Compose, the special folders in order, then the rest under More folders', () => {
    const items = mailMenu([account('a', 'me@x.test')], account('a', 'me@x.test'), folders);
    expect(items.map((i) => [i.id, i.label, i.count ?? null])).toEqual([
      ['compose', 'Compose', null],
      ['folder:INBOX', 'Inbox', 4],
      ['folder:Drafts', 'Drafts', 3],
      ['folder:Sent', 'Sent', 0],
      ['more', 'More folders', null],
    ]);
    expect(items[1]!.href).toBe('/mail/?account=a&folder=INBOX');
    expect(items[4]!.children!.map((c) => c.label)).toEqual(['clients', 'clients / acme', 'hiring']);
  });

  it('offers the other accounts when there are several', () => {
    const items = mailMenu([account('a', 'me@x.test'), account('b', 'me@y.test')], account('a', 'me@x.test'), folders);
    const accounts = items[items.length - 1]!;
    expect(accounts.label).toBe('me@x.test');
    expect(accounts.children!.map((c) => c.id)).toEqual(['account:a', 'account:b']);
  });
});
