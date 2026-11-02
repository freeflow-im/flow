// The FreeFlow suite's two roots in the client (docs/specs/freeflow-suite.md §2.4): what the bar's organization makes
// the API calls name, the root switch, and the menus' actions.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { placeFields, placeOf } from './api.ts';
import { scopeActionLabels } from './components/OrganizationActions.tsx';
import { RootSwitch } from './components/RootSwitch.tsx';
import { activeOrganizationId, organizationSnapshot, setOrganizationState, subscribeOrganization } from './suite.ts';

afterEach(() => setOrganizationState({ active: null, organizations: [], ready: false }));

describe('the organization in the bar', () => {
  it('names nothing outside the suite: the one list, as before', () => {
    expect(activeOrganizationId()).toBeNull();
    expect(placeFields('Reports')).toEqual({ folder: 'Reports' });
    expect(placeFields('')).toEqual({});
  });

  it('makes lists and new files name the selected organization: My files there, or with `shared` its Organization files', () => {
    let told = 0;
    const stop = subscribeOrganization(() => told++);
    setOrganizationState({ active: { id: 'ws1', name: 'Harbor & Pine' }, organizations: [{ id: 'ws1', name: 'Harbor & Pine' }, { id: 'ws2', name: 'Other' }], ready: true });
    setOrganizationState({ ...organizationSnapshot() });
    stop();
    expect(told).toBe(1);
    expect(placeFields('Reports')).toEqual({ folder: 'Reports', workspace: 'ws1' });
    expect(placeFields({ folder: '', shared: true })).toEqual({ workspace: 'ws1', shared: '1' });
    // A file's own organization wins over the bar's: a copy beside it goes where it is.
    expect(placeFields(placeOf({ folder: 'Plans', workspaceId: 'ws2', shared: true }))).toEqual({ folder: 'Plans', workspace: 'ws2', shared: '1' });
    expect(placeOf({ folder: 'Old' })).toBe('Old');
  });
});

describe('the two roots', () => {
  it('shows Organization files first, and marks the one shown', () => {
    const html = renderToStaticMarkup(createElement(RootSwitch, { organization: 'Harbor & Pine', shared: true, onSelect: () => {} }));
    expect(html.indexOf('Organization files')).toBeLessThan(html.indexOf('My files'));
    expect(html).toMatch(/aria-selected="true"[^>]*>.*?Organization files/);
    expect(renderToStaticMarkup(createElement(RootSwitch, { organization: 'Harbor & Pine', shared: false, onSelect: () => {} }))).toMatch(/aria-selected="true"[^>]*>(?:(?!<button).)*My files/);
  });

  it('offers Share with organization for a private file, Make private for a shared one, and Move to organization… for someone in several', () => {
    expect(scopeActionLabels({}, 1)).toEqual({ share: 'Share with organization', move: null });
    expect(scopeActionLabels({ shared: true }, 2)).toEqual({ share: 'Make private', move: 'Move to organization…' });
  });
});
