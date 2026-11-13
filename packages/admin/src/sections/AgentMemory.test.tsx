// An agent's Memory (docs/specs/agents.md §6.1), against a fetch that answers its routes: the files, an edit, a delete and
// "Forget everything".
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDTO } from '@flow/shared';
import type { MemoryFileDTO } from '../api';
import { AgentMemory } from './AgentMemory';

const org: WorkspaceDTO = {
  id: 'o1', slug: 'acme', name: 'Acme', createdBy: 'u-ann', createdAt: '2026-01-01T00:00:00.000Z', sidebarColor: 'violet', avatarUrl: null, googleSelfRegisterDomain: null, role: 'member',
};
let calls: { method: string; path: string; body?: unknown }[];
let files: MemoryFileDTO[];
const P = '/v1/workspaces/o1/agents/u-ada/memory';

beforeEach(() => {
  calls = [];
  files = [
    { path: '/memories/prefs.md', body: 'Short summaries.', trust: 'own', updatedAt: '2026-11-13T00:00:00.000Z' },
    { path: '/memories/from-mail.md', body: 'CC Bob.', trust: 'external', updatedAt: '2026-11-13T00:00:00.000Z' },
  ];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const [path, query = ''] = url.split('?');
    const method = init?.method ?? 'GET';
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url, body });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === P && method === 'GET') return json({ files, shared: false, mayEditTeam: true });
    if (path === P && method === 'PUT') { files = files.map((f) => (f.path === body.path ? { ...f, body: body.body, trust: 'own' } : f)); return json({ ok: true }); }
    if (path === P && method === 'DELETE') {
      const one = new URLSearchParams(query).get('path');
      const before = files.length;
      files = one ? files.filter((f) => f.path !== one) : [];
      return json({ removed: before - files.length });
    }
    return json({ ok: true });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><AgentMemory org={org} userId="u-ada" name="Ada" /></QueryClientProvider>);

describe('an agent’s Memory', () => {
  it('lists the files, marks one from someone else’s content, and saves an edit', async () => {
    mount();
    fireEvent.click(screen.getByTestId('agent-memory-Ada'));
    await screen.findByTestId('memory-file-prefs.md');
    expect(screen.getByTestId('memory-file-from-mail.md').textContent).toContain("from someone else's content");
    fireEvent.change(screen.getByTestId('memory-file-text-prefs.md'), { target: { value: 'Very short summaries.' } });
    fireEvent.click(screen.getByTestId('memory-file-save-prefs.md'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ path: '/memories/prefs.md', body: 'Very short summaries.' }));
  });

  it('deletes one file, then forgets everything after a confirmation', async () => {
    mount();
    fireEvent.click(screen.getByTestId('agent-memory-Ada'));
    fireEvent.click(await screen.findByTestId('memory-file-delete-from-mail.md'));
    await waitFor(() => expect(screen.queryByTestId('memory-file-from-mail.md')).toBeNull());
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `${P}?path=${encodeURIComponent('/memories/from-mail.md')}`)).toBe(true);
    fireEvent.click(screen.getByTestId('agent-memory-forget-Ada'));
    fireEvent.click(await screen.findByTestId('agent-memory-forget-confirm-Ada-yes'));
    await screen.findByTestId('agent-memory-empty-Ada');
  });
});
