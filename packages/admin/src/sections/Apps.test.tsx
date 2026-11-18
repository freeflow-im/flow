// Apps (docs/specs/user-apps.md, phase 1), against a fetch that answers the suite's API: an owner reads a manifest and sees
// what it asks for with the external app's notice before installing, the secret is shown once, a manifest's problems are
// all shown, and a member sees only the switch for their own agents.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledAppDTO, UserAppManifest, WorkspaceDTO } from '@flow/shared';
import { Apps, grantsOf } from './Apps';

const org = { id: 'o1', slug: 'acme', name: 'Acme', role: 'owner' } as WorkspaceDTO;

const manifest: UserAppManifest = {
  name: 'taskboard', label: 'Tasks', icon: '🗂️',
  scopes: [{ id: 'taskboard:read', label: 'See tasks', read: true }, { id: 'taskboard:write', label: 'Change tasks' }],
  tools: [{ name: 'claim_task', description: 'Claim a task and move it to In progress.', input: { type: 'object' }, scopes: ['taskboard:write'] }],
  events: ['task.assigned'],
  server: { url: 'https://tasks.example.com/freeflow' },
  ui: { url: 'https://tasks.example.com/' },
};

const installed: InstalledAppDTO = {
  name: 'taskboard', label: 'Tasks', icon: '🗂️', manifestUrl: 'https://tasks.example.com/freeflow-app.json', serverOrigin: 'https://tasks.example.com',
  hasScreen: true, hosted: false, version: 1, scopes: manifest.scopes, tools: manifest.tools.map((t) => ({ name: t.name, description: t.description, scopes: t.scopes })), events: ['task.assigned'],
  grants: { 'taskboard:read': ['members', 'acct-bot'], 'taskboard:write': ['members', 'acct-bot'] }, usable: true, agentsOn: false,
  installedBy: 'acct-ann', installedAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z',
};

let calls: { method: string; path: string; body: unknown }[];
let apps: InstalledAppDTO[];
let previewProblems: string | null;
let uploads: unknown[];

beforeEach(() => {
  calls = [];
  apps = [];
  previewProblems = null;
  uploads = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/apps/versions')) return json({ versions: uploads });
    if (path.endsWith('/apps/preview')) return previewProblems ? json({ error: { code: 'manifest', message: previewProblems } }, 400) : json({ manifest });
    if (path.endsWith('/apps') && method === 'POST') return json({ app: 'taskboard', secret: 'c2VjcmV0' }, 201);
    if (path.endsWith('/apps')) return json({ apps });
    if (path.endsWith('/accounts')) return json({ accounts: [
      { id: 'acct-ann', displayName: 'Ann', kind: 'native', state: 'active' },
      { id: 'acct-bot', displayName: 'Builder', kind: 'native', state: 'active', agentMode: 'shared' },
      { id: 'acct-gus', displayName: 'Gus', kind: 'guest', state: 'active' },
    ] });
    return json({ ok: true });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (admin: boolean) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Apps org={org} admin={admin} />
    </QueryClientProvider>,
  );

describe('Apps', () => {
  it('shows what an app asks for, with the external notice, before installing; then the secret once', async () => {
    show(true);
    fireEvent.change(screen.getByTestId('manifest-url'), { target: { value: 'https://tasks.example.com/freeflow-app.json' } });
    fireEvent.click(screen.getByTestId('preview-app'));
    await screen.findByTestId('install-card');
    expect(screen.getByTestId('external-notice').textContent).toContain('https://tasks.example.com');
    expect(screen.getByTestId('app-asks').textContent).toContain('Claim a task and move it to In progress.');
    // People and shared agents can be named; a guest cannot.
    await screen.findByTestId('grant-agent-acct-bot');
    expect(screen.queryByText('Gus')).toBeNull();
    fireEvent.click(screen.getByTestId('grant-agent-acct-bot'));
    fireEvent.click(screen.getByTestId('install-confirm'));
    await screen.findByTestId('app-secret');
    expect(screen.getByTestId('app-secret-value').textContent).toBe('c2VjcmV0');
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/apps'))?.body).toEqual({ url: 'https://tasks.example.com/freeflow-app.json', grants: { members: true, accounts: ['acct-bot'] } });
  });

  it('shows every problem of a manifest that does not pass', async () => {
    previewProblems = 'name: "docs" is reserved\ntools.x: scope "x:y" is not declared in scopes';
    show(true);
    fireEvent.change(screen.getByTestId('manifest-url'), { target: { value: 'https://x.example.com/m.json' } });
    fireEvent.click(screen.getByTestId('preview-app'));
    const error = await screen.findByTestId('install-error');
    expect(error.textContent).toContain('is reserved');
    expect(error.textContent).toContain('is not declared');
  });

  it('gives a member the switch for their own agents and nothing to install', async () => {
    apps = [{ ...installed, grants: undefined }];
    show(false);
    const toggle = await screen.findByTestId('agents-on-taskboard');
    expect(screen.queryByTestId('install-app')).toBeNull();
    expect(screen.queryByTestId('edit-grants-taskboard')).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path.endsWith('/apps/taskboard/agents'))).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/agents'))?.body).toEqual({ on: true });
  });

  it('installs an uploaded hosted version after showing what it may use and reach, with no secret to hand out', async () => {
    uploads = [{ name: 'notes', version: 1, manifest: { ...manifest, name: 'notes', label: 'Notes', server: { hosted: true }, uses: ['chat:write'], egress: ['api.example.com'] }, files: { 'server.js': 10 }, by: 'acct-ann', at: '2026-11-17T00:00:00.000Z', installed: false }];
    show(true);
    fireEvent.click(await screen.findByTestId('open-upload-notes-1'));
    expect(screen.getByTestId('hosted-notice').textContent).toContain('chat:write');
    expect(screen.getByTestId('hosted-notice').textContent).toContain('api.example.com');
    fireEvent.click(screen.getByTestId('upload-confirm'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/apps') && (c.body as { version?: number }).version === 1)).toBe(true));
    expect(screen.queryByTestId('app-secret')).toBeNull();
  });

  it('offers going back and the export for a hosted app with a restore point', async () => {
    apps = [{ ...installed, hosted: true, serverOrigin: null, version: 2, restorePoint: { fromVersion: 1, at: '2026-11-17T00:00:00.000Z' } }];
    show(true);
    fireEvent.click(await screen.findByTestId('go-back-taskboard'));
    fireEvent.click(screen.getByTestId('back-taskboard-yes'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/apps/taskboard/restore'))).toBe(true));
    expect(screen.getByTestId('export-taskboard').getAttribute('href')).toBe('/v1/workspaces/o1/apps/taskboard/export');
    expect(screen.queryByTestId('update-taskboard')).toBeNull();
  });

  it('reads the grants back for the editor', () => {
    expect(grantsOf(installed)).toEqual({ members: true, accounts: ['acct-bot'] });
  });
});
