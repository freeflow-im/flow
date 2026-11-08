// GET /v1/references' resolution (src/references.ts, platform phase 6.4): the Org object first, then the resolver each
// app's manifest names for what it hands back; denied is all a reader learns of what they may not see.
import { describe, expect, it } from 'vitest';
import type { ResolvedReference } from '@flow/shared/addresses';
import { resolveReferences, resolverOf, type ReferenceSources } from './references';

const ORG = 'org1';
const r = (app: string, kind: string, id: string) => `${ORG}/${app}/${kind}/${id}`;

function sources(over: Partial<ReferenceSources> = {}): ReferenceSources & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    // A fake Org object: Chat's channel c1 visible, an artifact a2 not; a Docs file shared through the index; the rest asked of the app.
    org: async (refs) => refs.map((ref) => {
      if (ref === r('chat', 'channel', 'c1')) return { ref, app: 'chat', kind: 'channel', title: '#general', url: '/?open=channel%3Ac1', icon: '#', role: 'editor' as const };
      if (ref === r('docs', 'sheet', 'shared')) return { ref, app: 'docs', kind: 'sheet', title: 'Q4 plan', url: '/workspace/s/shared', icon: '📊', role: 'viewer' as const, fileKind: 'sheet' };
      if (ref.includes('/chat/')) return { ref, denied: true as const };
      return { ref, ask: true as const };
    }),
    docs: async (ref) => { asked.push(ref.id); return ref.id === 'mine' ? { title: 'Diary', fileKind: 'doc', role: 'owner' } : null; },
    calendar: async (ref) => { asked.push(ref.id); return ref.id === 'n.acct.cal' ? { title: 'Team', role: 'viewer' } : ref.kind === 'event' && ref.id.startsWith('n.acct.cal:') ? { title: 'Standup', summary: 'Team', role: 'viewer' } : null; },
    ...over,
  };
}

describe('resolveReferences', () => {
  it('answers a Chat kind from the Org object, and a Docs file shared with the reader from the share index', async () => {
    const s = sources();
    const out = await resolveReferences([r('chat', 'channel', 'c1'), r('docs', 'sheet', 'shared')], s);
    expect(out).toEqual([
      { ref: r('chat', 'channel', 'c1'), app: 'chat', kind: 'channel', title: '#general', url: '/?open=channel%3Ac1', icon: '#', role: 'editor' },
      expect.objectContaining({ ref: r('docs', 'sheet', 'shared'), title: 'Q4 plan', role: 'viewer', url: '/workspace/s/shared' }),
    ]);
    expect(s.asked).toEqual([]); // the index answered: Docs was not asked
  });

  it('asks Docs for a file the index does not hold (the owner’s own), with its kind for the address and icon', async () => {
    const [mine] = await resolveReferences([r('docs', 'sheet', 'mine')], sources());
    expect(mine).toEqual({ ref: r('docs', 'sheet', 'mine'), app: 'docs', kind: 'sheet', title: 'Diary', url: '/workspace/doc/mine', icon: '📄', role: 'owner', fileKind: 'doc' });
  });

  it('denies, with no title, what the reader may not see, what has no resolver, and what does not parse', async () => {
    const out = await resolveReferences([r('docs', 'sheet', 'private'), r('chat', 'artifact', 'a2'), r('mail', 'message', 'm1'), 'not-a-ref', r('docs', 'sheet', 'private')], sources());
    expect(out).toEqual<ResolvedReference[]>([
      { ref: r('docs', 'sheet', 'private'), denied: true },
      { ref: r('chat', 'artifact', 'a2'), denied: true },
      { ref: r('mail', 'message', 'm1'), denied: true },
      { ref: 'not-a-ref', denied: true },
    ]);
    // An app's failure is a denial too, not an error for the whole list.
    const failing = await resolveReferences([r('docs', 'sheet', 'mine')], sources({ docs: async () => { throw new Error('down'); } }));
    expect(failing).toEqual([{ ref: r('docs', 'sheet', 'mine'), denied: true }]);
  });

  it('asks the Calendar object for a calendar and an event', async () => {
    const out = await resolveReferences([r('calendar', 'calendar', 'n.acct.cal'), r('calendar', 'event', 'n.acct.cal:uid%40x'), r('calendar', 'calendar', 'n.acct.other')], sources());
    expect(out).toEqual([
      { ref: r('calendar', 'calendar', 'n.acct.cal'), app: 'calendar', kind: 'calendar', title: 'Team', url: '/calendar/?calendar=n.acct.cal', icon: '📅', role: 'viewer' },
      { ref: r('calendar', 'event', 'n.acct.cal:uid%40x'), app: 'calendar', kind: 'event', title: 'Standup', summary: 'Team', url: '/calendar/?event=n.acct.cal%3Auid%2540x', icon: '🗓️', role: 'viewer' },
      { ref: r('calendar', 'calendar', 'n.acct.other'), denied: true },
    ]);
  });

  it('reads each kind’s resolver from the manifests', () => {
    expect([resolverOf({ app: 'chat', kind: 'artifact' }), resolverOf({ app: 'docs', kind: 'file' }), resolverOf({ app: 'calendar', kind: 'event' }), resolverOf({ app: 'mail', kind: 'message' }), resolverOf({ app: 'nope', kind: 'x' })])
      .toEqual(['org', 'app', 'app', null, null]);
  });
});
