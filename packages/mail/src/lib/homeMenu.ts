// Mail's menu in Home's sidebar (docs/specs/home.md §2.1): what Mail's own sidebar shows first. Compose, the special
// folders, then "More folders" with the rest (a tree, flattened under its full names), and with more than one account,
// the accounts to switch to.
import type { SuiteMenuIcon, SuiteMenuItem } from '@flow/suite-bar';
import type { MailAccount, MailFolder, SpecialUse } from '../api';
import { folderLabel, orderFolders, type FolderNode } from './folders';

const ICONS: Record<SpecialUse, SuiteMenuIcon> = {
  inbox: 'inbox',
  flagged: 'star',
  drafts: 'draft',
  sent: 'send',
  archive: 'archive',
  all: 'mail',
  junk: 'spam',
  trash: 'trash',
};

export const COMPOSE_ITEM = 'compose';
export const folderItem = (path: string) => `folder:${path}`;
export const accountItem = (id: string) => `account:${id}`;

export function folderHref(account: string, path: string): string {
  return `/mail/?${new URLSearchParams({ account, folder: path })}`;
}

/** The count Mail's sidebar shows beside a special folder: unread where it means something to do, drafts in all. */
function countOf(f: MailFolder): number {
  return f.specialUse === 'inbox' || f.specialUse === 'junk' || f.specialUse === 'archive' ? f.unread : f.specialUse === 'drafts' ? f.total : 0;
}

export function mailMenu(accounts: MailAccount[], account: MailAccount, folders: MailFolder[]): SuiteMenuItem[] {
  const { special, tree } = orderFolders(folders);
  const items: SuiteMenuItem[] = [{ id: COMPOSE_ITEM, label: 'Compose', icon: 'pen' }];
  for (const f of special) items.push({ id: folderItem(f.path), label: folderLabel(f), icon: ICONS[f.specialUse!], count: countOf(f), href: folderHref(account.id, f.path) });
  const rest: SuiteMenuItem[] = [];
  const walk = (nodes: FolderNode[], prefix: string) => {
    for (const n of nodes) {
      const label = prefix ? `${prefix} / ${n.name}` : n.name;
      if (n.folder) rest.push({ id: folderItem(n.folder.path), label, icon: 'folder', count: n.folder.unread, href: folderHref(account.id, n.folder.path) });
      walk(n.children, label);
    }
  };
  walk(tree, '');
  if (rest.length) items.push({ id: 'more', label: 'More folders', children: rest });
  if (accounts.length > 1) {
    items.push({
      id: 'accounts',
      label: account.email,
      children: accounts.map((a) => ({ id: accountItem(a.id), label: a.email, icon: 'user', href: `/mail/?${new URLSearchParams({ account: a.id })}` })),
    });
  }
  return items;
}
