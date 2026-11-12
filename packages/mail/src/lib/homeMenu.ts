// Mail's menu in Home's sidebar (docs/specs/home.md §2.1): only what a person goes to most. New message, Inbox and
// Drafts. With more than one account, Inbox opens a list of the accounts, to switch to another one's inbox. The other
// folders are in Mail itself.
import type { SuiteMenuItem } from '@flow/suite-bar';
import type { MailAccount, MailFolder } from '../api';
import { findSpecial } from './folders';

export const COMPOSE_ITEM = 'compose';
export const folderItem = (path: string) => `folder:${path}`;
export const accountItem = (id: string) => `account:${id}`;

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
      ...(accounts.length > 1 ? { children: accounts.map((a) => ({ id: accountItem(a.id), label: a.email, icon: 'user' as const, href: `/mail/?${new URLSearchParams({ account: a.id })}` })) } : {}),
    });
  }
  const drafts = findSpecial(folders, 'drafts');
  if (drafts) items.push({ id: folderItem(drafts.path), label: 'Drafts', icon: 'draft', count: drafts.total, href: folderHref(account.id, drafts.path) });
  return items;
}
