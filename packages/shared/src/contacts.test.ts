// Contacts, the fifth app (platform.md §11, phase 6.5), as its manifest and tool definitions declare it: what the kernel
// reads from them (the tab, the pages, the consent group, the tools at /mcp and in the assistant, the addresses and chips
// of its kinds) all comes from those two, with nothing else declared for it.
import { describe, expect, it } from 'vitest';
import { addressOf, iconOf, kindLabelOf, referenceOf } from './addresses.js';
import { APP_MANIFESTS } from './manifests.js';
import { CONTACTS_TOOLS, grantedScopes, allowedBy, toolsAtDoor } from './tools.js';

const contacts = APP_MANIFESTS.find((m) => m.name === 'contacts')!;

describe('the Contacts manifest', () => {
  it('declares an account-scoped app with its object, routes, tab, pages, client and events', () => {
    expect(contacts).toMatchObject({ path: '/contacts', scope: 'account', object: { className: 'Contacts' }, routes: 'contacts', tab: { label: 'Contacts', shortcut: '5' } });
    expect(contacts.client).toEqual({ dist: 'packages/contacts/dist', basePath: '/contacts/', optional: true });
    expect(contacts.pages?.every((p) => p.signIn)).toBe(true);
    expect(contacts.events).toEqual(['contacts.changed']);
    expect(contacts.assistant?.pages).toEqual(['contacts']);
    expect(contacts.kinds.find((k) => k.kind === 'contact')?.resolve).toBe('app');
  });

  it('has its three tools, defined for /mcp and the assistant under its consent group’s scopes', () => {
    expect(CONTACTS_TOOLS.map((t) => t.name)).toEqual(contacts.tools);
    const scopes = contacts.scopes!.flatMap((g) => g.scopes);
    expect(scopes).toEqual(['contacts:read', 'contacts:write']);
    for (const t of CONTACTS_TOOLS) {
      expect(t).toMatchObject({ app: 'contacts', kind: 'server' });
      expect(t.doors.sort()).toEqual(['assistant', 'mcp']);
      expect(t.scopes.length).toBe(1);
      expect(scopes).toContain(t.scopes[0]);
      expect(t.input.type).toBe('object');
    }
    const read = toolsAtDoor('mcp').filter((t) => t.app === 'contacts' && allowedBy(t, grantedScopes(['contacts:read']))).map((t) => t.name);
    expect(read).toEqual(['list_contacts', 'find_contact']);
    expect(CONTACTS_TOOLS.find((t) => t.name === 'find_contact')?.input.required).toEqual(['q']);
  });

  it('gives its kinds addresses, chips and the way back, from the manifest alone', () => {
    const ref = { organizationId: 'o1', app: 'contacts', kind: 'contact', id: 'acct-1:abc' };
    expect(addressOf(ref)).toBe('/contacts/?contact=acct-1%3Aabc');
    expect(referenceOf('https://app.test/contacts/?contact=acct-1%3Aabc', { origin: 'https://app.test', organizationId: 'o1' })).toEqual(ref);
    expect(referenceOf('/contacts?list=acct-1', { origin: 'https://app.test', organizationId: 'o1' })).toEqual({ organizationId: 'o1', app: 'contacts', kind: 'list', id: 'acct-1' });
    expect(referenceOf('/contacts/', { origin: 'https://app.test', organizationId: 'o1' })).toBeNull();
    expect(iconOf('contacts', 'contact')).toBe('👤');
    expect(kindLabelOf('contacts', 'contact')).toBe('Contact');
    expect(kindLabelOf('contacts', 'list')).toBe('Contacts');
  });
});
