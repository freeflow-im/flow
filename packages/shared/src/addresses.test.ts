import { describe, expect, it } from 'vitest';
import { addressOf, chatPageAddress, createAddress, referenceOf, shareAddressOf, type AddressedReference } from './addresses.js';
import { APP_MANIFESTS } from './manifests.js';
import { formatReference, parseReference } from './platform.js';

const ORIGIN = 'https://app.freeflow.im';
const ctx = { origin: ORIGIN, organizationId: 'org1' };
const ref = (app: string, kind: string, id: string, fileKind?: string): AddressedReference => ({ organizationId: 'org1', app, kind, id, ...(fileKind ? { fileKind } : {}) });

// Every kind with a page, with ids that need escaping where an app's ids can (a calendar event's uid, a folder's path).
const KINDS: [AddressedReference, string][] = [
  [ref('chat', 'artifact', 'a1'), '/?open=artifact%3Aa1'],
  [ref('chat', 'channel', 'c1'), '/?open=channel%3Ac1'],
  [ref('chat', 'message', 'm1'), '/?open=message%3Am1'],
  [ref('docs', 'sheet', 's1', 'sheet'), '/docs/s/s1'],
  [ref('docs', 'sheet', 'd1', 'deck'), '/docs/d/d1'],
  [ref('docs', 'sheet', 'x1', 'doc'), '/docs/doc/x1'],
  [ref('docs', 'sheet', 'k1', 'markdown'), '/docs/md/k1'],
  [ref('docs', 'file', 'f1', 'file'), '/docs/f/f1'],
  [ref('docs', 'folder', 'org1:shared/Q4 plans'), '/docs/?withme=1&in=org1%3Ashared%2FQ4%20plans&org=org1'],
  [ref('calendar', 'calendar', 'n.acct.r1'), '/calendar/?calendar=n.acct.r1'],
  [ref('calendar', 'event', 'n.acct.r1:uid%40x.org'), '/calendar/?event=n.acct.r1%3Auid%2540x.org'],
];

describe('addresses', () => {
  it('every kind round-trips address ↔ reference, absolute or relative', () => {
    for (const [r, address] of KINDS) {
      expect([formatReference(r), addressOf(r)]).toEqual([formatReference(r), address]);
      expect(referenceOf(address, ctx)).toEqual(r);
      expect(referenceOf(`${ORIGIN}${address}`, ctx)).toEqual(r);
    }
  });

  it('covers every kind a manifest says has a page, and no other', () => {
    const covered = new Set(KINDS.map(([r]) => `${r.app}/${r.kind}`));
    // A kind whose manifest declares its `address` is covered by it, with no entry in the table.
    const declared = APP_MANIFESTS.flatMap((m) => m.kinds.filter((k) => k.resolve && !k.address && !(m.name === 'chat' && k.kind === 'file')).map((k) => `${m.name}/${k.kind}`));
    expect([...covered].sort()).toEqual([...new Set(declared)].sort());
    for (const m of APP_MANIFESTS) for (const k of m.kinds) if (k.address) {
      const r = ref(m.name, k.kind, 'acct:x y');
      expect(addressOf(r)).toBe(k.address.replace('{id}', 'acct%3Ax%20y'));
      expect(referenceOf(addressOf(r)!, ctx)).toEqual(r);
    }
    expect(addressOf(ref('chat', 'file', 'f'))).toBeNull();
    expect(addressOf(ref('mail', 'message', 'm'))).toBeNull();
  });

  it('a Docs file without its kind opens as a spreadsheet or a stored file, as the share index did', () => {
    expect(addressOf(ref('docs', 'sheet', 'x'))).toBe('/docs/s/x');
    expect(addressOf(ref('docs', 'file', 'y'))).toBe('/docs/f/y');
    expect(addressOf(ref('docs', 'sheet', 'x'), 'deck')).toBe('/docs/d/x');
  });

  it('is null for another origin and for pages that name no object', () => {
    for (const url of ['https://evil.example/docs/s/x', 'http://app.freeflow.im/docs/s/x', '/', '/?open=admin', '/docs/', '/docs/settings', '/calendar/week/2026-11-09', '/mail/', 'not a url at all ::', '/docs/s/a/b'])
      expect([url, referenceOf(url, ctx)]).toEqual([url, null]);
    expect(referenceOf('/calendar/week/2026-11-09?event=e1', ctx)).toEqual(ref('calendar', 'event', 'e1'));
  });

  it('a Docs folder names its own organization', () => {
    expect(referenceOf('/docs/?withme=1&in=r%2Fp&org=other', ctx)).toEqual({ organizationId: 'other', app: 'docs', kind: 'folder', id: 'r/p' });
  });

  it('shares on the owning app’s page, and creates with the queries the apps read', () => {
    const r = ref('docs', 'sheet', 's1');
    const share = shareAddressOf(r)!;
    expect(share).toBe(`/docs/?share=${encodeURIComponent('org1/docs/sheet/s1')}`);
    expect(parseReference(new URL(share, ORIGIN).searchParams.get('share')!)).toEqual({ organizationId: 'org1', app: 'docs', kind: 'sheet', id: 's1' });
    expect(shareAddressOf(ref('chat', 'artifact', 'a'))).toBe('/?share=org1%2Fchat%2Fartifact%2Fa');
    expect(shareAddressOf(ref('calendar', 'calendar', 'c'))).toBe('/calendar/?share=org1%2Fcalendar%2Fcalendar%2Fc');
    expect(shareAddressOf(ref('mail', 'message', 'm'))).toBeNull();
    const made = new URL(createAddress('calendar', { title: ' Plan ', attendees: [{ name: 'Lee, Ann', email: 'a@x.org' }, 'b@y.org'], start: '2026-11-09T10:00' }), ORIGIN);
    expect([made.pathname, made.searchParams.get('new'), made.searchParams.get('guests'), made.searchParams.get('start')]).toEqual(['/calendar/', 'Plan', 'Lee  Ann <a@x.org>,b@y.org', '2026-11-09T10:00']);
    const msg = new URL(createAddress('chat-message', { channel: 'c1', text: 'hi there' }), ORIGIN);
    expect([msg.pathname, msg.searchParams.get('open'), msg.searchParams.get('text')]).toEqual(['/', 'channel:c1', 'hi there']);
    expect(chatPageAddress('admin')).toBe('/?open=admin');
  });
});
