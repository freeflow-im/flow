import { describe, expect, it } from 'vitest';
import { intent } from './intents';

describe('intents', () => {
  const followed = (run: (navigate: (u: string) => void) => unknown) => { const urls: string[] = []; run((u) => urls.push(u)); return urls; };
  const ref = { organizationId: 'o1', app: 'docs', kind: 'sheet', id: 's1' };

  it('open follows the reference’s address, or a Chat page’s; nothing for a kind with no page', () => {
    expect(followed((navigate) => intent.open(ref, { navigate }))).toEqual(['/workspace/s/s1']);
    expect(followed((navigate) => intent.open({ app: 'chat', kind: 'artifact', id: 'a1' }, { navigate }))).toEqual(['/?open=artifact%3Aa1']);
    expect(followed((navigate) => intent.open('admin', { navigate }))).toEqual(['/?open=admin']);
    expect(followed((navigate) => intent.admin(undefined, { navigate }))).toEqual(['/admin']);
    expect(followed((navigate) => intent.admin('domains', { navigate }))).toEqual(['/admin/domains']);
    expect(followed((navigate) => expect(intent.open({ app: 'mail', kind: 'message', id: 'm' }, { navigate })).toBe(false))).toEqual([]);
  });

  it('create asks Calendar with the query it reads, and share opens the owner’s Share dialog', () => {
    const [made] = followed((navigate) => intent.create('calendar', { title: 'Plan', attendees: [{ email: 'a@x.org', name: 'Ann' }] }, { navigate }));
    expect(new URL(made!, 'https://x').searchParams.get('guests')).toBe('Ann <a@x.org>');
    expect(followed((navigate) => intent.share(ref, { navigate }))).toEqual(['/workspace/?share=o1%2Fdocs%2Fsheet%2Fs1']);
    expect(intent.share({ ...ref, app: 'mail', kind: 'message' }, { navigate: () => {} })).toBe(false);
  });
});
