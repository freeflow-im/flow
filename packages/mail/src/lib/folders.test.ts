import { describe, expect, it } from 'vitest';
import type { MailFolder } from '../api';
import { orderFolders } from './folders';

const f = (path: string, specialUse: MailFolder['specialUse'] = null, delimiter = '/'): MailFolder => ({ path, name: path.split(delimiter).pop()!, delimiter, specialUse, unread: 0, total: 0 });

describe('orderFolders', () => {
  it('puts the special folders first in the usual order, then the rest as a sorted tree', () => {
    const { special, tree } = orderFolders([
      f('Work/Clients/Acme'),
      f('[Gmail]/Trash', 'trash'),
      f('Work'),
      f('[Gmail]/Sent Mail', 'sent'),
      f('Receipts'),
      f('INBOX'),
      f('[Gmail]/Drafts', 'drafts'),
      f('Work/Clients'),
      f('archive 2', null),
      f('Archive', 'archive'),
      f('[Gmail]/Spam', 'junk'),
    ]);
    expect(special.map((x) => x.specialUse)).toEqual(['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash']);
    expect(tree.map((n) => n.name)).toEqual(['archive 2', 'Receipts', 'Work']);
    const work = tree.find((n) => n.name === 'Work')!;
    expect(work.children.map((n) => n.name)).toEqual(['Clients']);
    expect(work.children[0]!.children.map((n) => n.path)).toEqual(['Work/Clients/Acme']);
  });

  it('treats INBOX as the inbox even unmarked, and gives a role to the first folder that claims it', () => {
    const { special, tree } = orderFolders([f('INBOX'), f('Sent', 'sent'), f('Sent Items', 'sent')]);
    expect(special.map((x) => x.path)).toEqual(['INBOX', 'Sent']);
    expect(tree.map((n) => n.path)).toEqual(['Sent Items']);
  });

  it('makes a level for a parent the server did not list, and splits by the folder’s own delimiter', () => {
    const { tree } = orderFolders([f('Lists.Rust.Announce', null, '.'), f('Lists.Go', null, '.')]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.folder).toBeNull();
    expect(tree[0]!.name).toBe('Lists');
    expect(tree[0]!.children.map((n) => n.name)).toEqual(['Go', 'Rust']);
    expect(tree[0]!.children[1]!.children[0]!.folder?.path).toBe('Lists.Rust.Announce');
  });

  it('lists a child of a special folder at the top level under its full name', () => {
    const { tree } = orderFolders([f('INBOX', 'inbox'), f('INBOX/Receipts')]);
    expect(tree.map((n) => n.name)).toEqual(['INBOX / Receipts']);
  });
});
