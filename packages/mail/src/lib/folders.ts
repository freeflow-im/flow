// The folder list in the left panel: the special-use folders first, in the order people expect and with their icons,
// then everything else as a tree by the server's delimiter, alphabetically at each level.
import type { MailFolder, SpecialUse } from '../api';

export const SPECIAL_ORDER: SpecialUse[] = ['inbox', 'flagged', 'drafts', 'sent', 'archive', 'all', 'junk', 'trash'];

export const SPECIAL_NAMES: Record<SpecialUse, string> = {
  inbox: 'Inbox',
  flagged: 'Starred',
  drafts: 'Drafts',
  sent: 'Sent',
  archive: 'Archive',
  all: 'All mail',
  junk: 'Spam',
  trash: 'Trash',
};

export interface FolderNode {
  /** The folder's path; for a level with no folder of its own (a parent the server did not list), its would-be path. */
  path: string;
  name: string;
  folder: MailFolder | null;
  children: FolderNode[];
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

/** What the user calls a folder: the special ones by their role, the others by their own name. */
export function folderLabel(f: MailFolder): string {
  return f.specialUse ? SPECIAL_NAMES[f.specialUse] : f.name || f.path;
}

export function orderFolders(folders: MailFolder[]): { special: MailFolder[]; tree: FolderNode[] } {
  // A server can mark two folders with one role (Gmail's [Gmail]/Sent Mail and an old Sent): the first keeps it.
  const taken = new Set<SpecialUse>();
  const special: MailFolder[] = [];
  const rest: MailFolder[] = [];
  for (const f of folders) {
    const use = f.specialUse ?? (f.path.toUpperCase() === 'INBOX' ? 'inbox' : null);
    if (use && !taken.has(use)) {
      taken.add(use);
      special.push(use === f.specialUse ? f : { ...f, specialUse: use });
    } else rest.push(f);
  }
  special.sort((a, b) => SPECIAL_ORDER.indexOf(a.specialUse!) - SPECIAL_ORDER.indexOf(b.specialUse!));

  const specialPaths = new Set(special.map((f) => f.path));
  const roots: FolderNode[] = [];
  const nodes = new Map<string, FolderNode>();
  const nodeFor = (path: string, name: string, delimiter: string): FolderNode => {
    let node = nodes.get(path);
    if (node) return node;
    node = { path, name, folder: null, children: [] };
    nodes.set(path, node);
    const cut = delimiter ? path.lastIndexOf(delimiter) : -1;
    // A child of a special folder (INBOX/Receipts) is listed at the top of the tree, under its full name.
    if (cut <= 0 || specialPaths.has(path.slice(0, cut))) roots.push(node);
    else {
      const parentPath = path.slice(0, cut);
      const parentName = delimiter ? parentPath.split(delimiter).pop()! : parentPath;
      nodeFor(parentPath, parentName, delimiter).children.push(node);
    }
    return node;
  };
  for (const f of rest) {
    const cut = f.delimiter ? f.path.lastIndexOf(f.delimiter) : -1;
    const underSpecial = cut > 0 && specialPaths.has(f.path.slice(0, cut));
    const node = nodeFor(f.path, underSpecial ? f.path : f.name || f.path, f.delimiter);
    node.folder = f;
    if (underSpecial) node.name = f.path.split(f.delimiter).join(' / ');
  }
  const sortTree = (list: FolderNode[]) => {
    list.sort(byName);
    for (const n of list) sortTree(n.children);
  };
  sortTree(roots);
  return { special, tree: roots };
}

/** The folder for a role (to archive into, to delete to), if the account has one. */
export const findSpecial = (folders: MailFolder[] | undefined, use: SpecialUse) => folders?.find((f) => f.specialUse === use) ?? null;
