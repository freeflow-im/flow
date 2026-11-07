import { describe, expect, it } from 'vitest';
import { chipAction, groupContacts, type Contact } from './contacts';

const c = (source: Contact['source'], name: string, emails: string[], extra: Partial<Contact> = {}): Contact => ({ id: `${source}:${name}`, source, name, emails, ...extra });
const LIST: Contact[] = [
  c('own', 'Zed Quill', ['zed@quill.test'], { orgName: 'Quill & Co' }),
  c('member', 'Bob', ['bob@acme.freeflow.im'], { userId: 'u-bob', accountId: 'acct-bob' }),
  c('shared', 'Yan', ['yan@far.test'], { owner: { accountId: 'acct-ann', name: 'Ann' } }),
  c('mail', 'Dee', ['dee@outside.test']),
  c('own', 'Bob at home', ['bob@acme.freeflow.im']),
];

describe('the merged list on the page', () => {
  it('groups by source in a fixed order, keeping the server’s order within each, empty groups left out', () => {
    expect(groupContacts(LIST).map((g) => [g.label, g.contacts.map((x) => x.name)])).toEqual([
      ['My contacts', ['Zed Quill', 'Bob at home']],
      ['Organization members', ['Bob']],
      ['Shared with the organization', ['Yan']],
      ['People you wrote to', ['Dee']],
    ]);
    expect(groupContacts(LIST.filter((x) => x.source === 'mail')).map((g) => g.source)).toEqual(['mail']);
  });

  it('searches names, addresses, organizations and a shared list’s owner', () => {
    expect(groupContacts(LIST, 'QUILL').flatMap((g) => g.contacts.map((x) => x.name))).toEqual(['Zed Quill']);
    expect(groupContacts(LIST, 'acme').map((g) => [g.source, g.contacts.length])).toEqual([['own', 1], ['member', 1]]);
    expect(groupContacts(LIST, 'ann').flatMap((g) => g.contacts.map((x) => x.name))).toEqual(['Yan']);
    expect(groupContacts(LIST, 'nobody')).toEqual([]);
  });

  it('makes a member’s address a DM, from any card, and copies the rest', () => {
    expect(chipAction('Bob@Acme.freeflow.im', LIST)).toEqual({ kind: 'dm', userId: 'u-bob', name: 'Bob' });
    expect(chipAction('dee@outside.test', LIST)).toEqual({ kind: 'copy', address: 'dee@outside.test' });
    expect(chipAction('zed@quill.test', LIST)).toEqual({ kind: 'copy', address: 'zed@quill.test' });
  });
});
