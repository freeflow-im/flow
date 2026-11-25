// Mail's menu in Home's sidebar (docs/specs/home.md §2.1): only what a person goes to most. New message, Inbox,
// Drafts and Sent. The accounts are a picker on the Mail row itself (`Mail ann@acme.test ▾`): it always shows the inbox's address,
// switches to another account's inbox, and adds an account. The other folders are in Mail itself.
import type { SuiteMenuItem, SuiteMenuPicker } from '@flow/suite-bar';
import type { MailAccount, MailFolder } from '../api';
import { findSpecial } from './folders';

export const COMPOSE_ITEM = 'compose';
export const folderItem = (path: string) => `folder:${path}`;
export const accountItem = (id: string) => `account:${id}`;
export const ADD_ACCOUNT_ITEM = 'add-account';

export function folderHref(account: string, path: string): string {
  return `/mail/?${new URLSearchParams({ account, folder: path })}`;
}

export function mailMenu(accounts: MailAccount[], account: MailAccount, folders: MailFolder[]): SuiteMenuItem[] {
  const items: SuiteMenuItem[] = [{ id: COMPOSE_ITEM, label: 'New message', icon: 'pen' }];
  const inbox = findSpecial(folders, 'inbox') ?? folders.find((f) => f.path.toUpperCase() === 'INBOX');
  if (inbox) {
    items.push({
      id: folderItem(inbox.path),
      label: 'Inbox',
      icon: 'inbox',
      count: inbox.unread,
      href: folderHref(account.id, inbox.path),
    });
  }
  const drafts = findSpecial(folders, 'drafts');
  if (drafts) items.push({ id: folderItem(drafts.path), label: 'Drafts', icon: 'draft', count: drafts.total, href: folderHref(account.id, drafts.path) });
  // No count on Sent, as in Mail's own sidebar: what was sent is never unread.
  const sent = findSpecial(folders, 'sent');
  if (sent) items.push({ id: folderItem(sent.path), label: 'Sent', icon: 'send', href: folderHref(account.id, sent.path) });
  return items;
}

/** The accounts, for the picker on the Mail row in Home's sidebar, labelled with the shown inbox's address, and Add
 * account last. Shown with one account too, so the address is always in sight. */
export function mailPicker(accounts: MailAccount[], account: MailAccount): SuiteMenuPicker {
  return {
    items: [
      ...accounts.map((a) => ({ id: accountItem(a.id), label: a.email, icon: 'user' as const, href: `/mail/?${new URLSearchParams({ account: a.id })}` })),
      { id: ADD_ACCOUNT_ITEM, label: 'Add account', icon: 'plus' as const },
    ],
    selected: accountItem(account.id),
    label: account.email,
  };
}
