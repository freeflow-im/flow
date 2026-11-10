// Where the home page puts a new file, and the crumbs of a file shared with the user (listing.ts; freeflow-suite.md §2.4).
import { afterEach, describe, expect, it } from 'vitest';
import { placeFields, type Place } from './api.ts';
import { newFileShared, sharedFileCrumbs } from './listing.ts';
import { setOrganizationState } from './suite.ts';

afterEach(() => setOrganizationState({ active: null, organizations: [], ready: false }));

/** What a create request from the home page at this address names, as HomePage builds its place. */
const created = (address: string, folder = '') => {
  const place: Place = newFileShared(address, true) ? { folder, shared: true } : folder;
  return placeFields(place);
};

describe('a new file is private wherever it is made', () => {
  it('at the top of My files, with the trailing slash or without', () => {
    setOrganizationState({ active: { id: 'org-1', name: 'Harbor' }, organizations: [{ id: 'org-1', name: 'Harbor' }], ready: true });
    expect(newFileShared('/docs/', true)).toBe(false);
    expect(newFileShared('/docs', true)).toBe(false);
    expect(newFileShared('/', true)).toBe(false);
    expect(created('/docs/')).toEqual({ workspace: 'org-1' });
    expect(created('/docs')).toEqual({ workspace: 'org-1' });
    expect(created('/docs/?folder=Plans', 'Plans')).toEqual({ folder: 'Plans', workspace: 'org-1' });
  });

  it('in Organization files, at its top or in a folder of it, it is the organization’s', () => {
    setOrganizationState({ active: { id: 'org-1', name: 'Harbor' }, organizations: [{ id: 'org-1', name: 'Harbor' }], ready: true });
    expect(newFileShared('/docs/?org=org-1', true)).toBe(true);
    expect(created('/docs/?org=org-1&folder=Q4', 'Q4')).toEqual({ folder: 'Q4', workspace: 'org-1', shared: '1' });
    expect(created('/docs?org=org-1&folder=Q4', 'Q4')).toEqual({ folder: 'Q4', workspace: 'org-1', shared: '1' });
  });

  it('a list shown over Organization files is not a folder of it, and outside an organization nothing is shared', () => {
    for (const list of ['recents', 'favorites', 'withme']) expect(newFileShared(`/docs/?org=org-1&${list}=1`, true)).toBe(false);
    expect(newFileShared('/docs/?org=', true)).toBe(false);
    expect(newFileShared('/docs/?org=org-1', false)).toBe(false);
  });
});

describe("a shared file's crumbs", () => {
  it('start at Shared with me and name none of the owner’s folders', () => {
    expect(sharedFileCrumbs('', '?withme=1')).toEqual([{ name: 'Shared with me', href: '/?withme=1' }]);
    expect(sharedFileCrumbs('Reports/2026', '?withme=1')).toEqual([{ name: 'Shared with me', href: '/?withme=1' }]);
    // Opened another way (a notification's link): the last list says nothing of the file.
    expect(sharedFileCrumbs('Reports/2026', '?folder=Reports')).toEqual([{ name: 'Shared with me', href: '/?withme=1' }]);
  });

  it('opened from a shared folder, go from that folder down', () => {
    const id = 'me:alice:org-1/Projects/Q4';
    const crumbs = sharedFileCrumbs('Projects/Q4/Drafts', `?withme=1&in=${encodeURIComponent(id)}`);
    expect(crumbs.map((c) => c.name)).toEqual(['Shared with me', 'Q4', 'Drafts']);
    expect(new URLSearchParams(crumbs[1].href.slice(2)).get('in')).toBe(id);
    expect(new URLSearchParams(crumbs[2].href.slice(2)).get('in')).toBe('me:alice:org-1/Projects/Q4/Drafts');
    // A folder id that is not above the file names nothing more.
    expect(sharedFileCrumbs('Elsewhere', `?withme=1&in=${encodeURIComponent(id)}`).map((c) => c.name)).toEqual(['Shared with me']);
  });
});
