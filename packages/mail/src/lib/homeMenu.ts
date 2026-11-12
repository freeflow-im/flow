// Mail's menu in Home's sidebar (docs/specs/home.md §2.1): only what a person goes to most. New message, Inbox and
// Drafts. With more than one account, the accounts are a picker on the Mail row itself (`Mail ▾`), to switch to another
// one's inbox. The other folders are in Mail itself.
import type { SuiteMenuItem, SuiteMenuPicker } from '@flow/suite-bar';
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
    });
  }
  const drafts = findSpecial(folders, 'drafts');
  if (drafts) items.push({ id: folderItem(drafts.path), label: 'Drafts', icon: 'draft', count: drafts.total, href: folderHref(account.id, drafts.path) });
  return items;
}

/** The accounts, for the picker on the Mail row in Home's sidebar; null with only one (nothing to choose). */
export function mailPicker(accounts: MailAccount[], account: MailAccount): SuiteMenuPicker | null {
  if (accounts.length < 2) return null;
  return {
    items: accounts.map((a) => ({ id: accountItem(a.id), label: a.email, icon: 'user', href: `/mail/?${new URLSearchParams({ account: a.id })}` })),
    selected: accountItem(account.id),
    label: shortName(accounts, account),
  };
}

/** The account's domain, or its whole address when another account shares that domain (two gmail.com accounts). */
export function shortName(accounts: MailAccount[], account: MailAccount): string {
  const domain = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  const mine = domain(account.email);
  return accounts.some((a) => a.id !== account.id && domain(a.email) === mine) ? account.email : mine;
}
