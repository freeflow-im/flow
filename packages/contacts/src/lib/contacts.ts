// The merged list as the page shows it: searched, grouped by where each contact comes from, and what each address chip does.
// The server merges the sources (packages/edge/src/contacts/object.ts); this is the page's side of it.

export type ContactSource = 'own' | 'member' | 'shared' | 'mail';

/** A contact as GET /v1/contacts answers it. */
export interface Contact {
  id: string;
  source: ContactSource;
  name: string;
  emails: string[];
  phone?: string;
  orgName?: string;
  notes?: string;
  owner?: { accountId: string; name: string };
  userId?: string;
  accountId?: string;
}

/** The groups in the order the page lists them, with their headings. */
export const GROUPS: { source: ContactSource; label: string }[] = [
  { source: 'own', label: 'My contacts' },
  { source: 'member', label: 'Organization members' },
  { source: 'shared', label: 'Shared with the organization' },
  { source: 'mail', label: 'People you wrote to' },
];

/** Whether a contact matches the search box: its name, an address, its organization, its phone or its list's owner. */
export function matches(c: Contact, q: string): boolean {
  const s = q.trim().toLowerCase();
  return !s || [c.name, ...c.emails, c.orgName ?? '', c.phone ?? '', c.owner?.name ?? ''].some((x) => x.toLowerCase().includes(s));
}

/** The list searched and grouped by source, in GROUPS' order, empty groups left out; each group keeps the server's order. */
export function groupContacts(list: readonly Contact[], q = ''): { source: ContactSource; label: string; contacts: Contact[] }[] {
  const shown = list.filter((c) => matches(c, q));
  return GROUPS.map((g) => ({ ...g, contacts: shown.filter((c) => c.source === g.source) })).filter((g) => g.contacts.length > 0);
}

/** What an address chip does: a member's (any address a member has, whatever the card) opens a DM with them in Chat;
 * any other is copied. */
export type ChipAction = { kind: 'dm'; userId: string; name: string } | { kind: 'copy'; address: string };

export function chipAction(address: string, list: readonly Contact[]): ChipAction {
  const a = address.toLowerCase();
  const member = list.find((c) => c.source === 'member' && c.userId && c.emails.includes(a));
  return member ? { kind: 'dm', userId: member.userId!, name: member.name } : { kind: 'copy', address };
}
