// Prompts (docs/specs/agents.md §1.2): the assistant's suggested prompts by page, the defaults where the organization has
// changed nothing, saved together with only the changed pages, against a fetch that answers the /v1 route.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDTO } from '@flow/shared';
import { DEFAULT_PROMPTS } from '@flow/suite-bar';
import { Prompts } from './Prompts';

const ORG = { id: 'org-1', name: 'Acme' } as WorkspaceDTO;
let saved: Record<string, string[]>;
let puts: unknown[];
beforeEach(() => {
  saved = { home: ['Plan my day'] };
  puts = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/v1/workspaces/org-1/assistant-prompts') {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { prompts: Record<string, string[]> };
        puts.push(body.prompts);
        saved = body.prompts;
      }
      return json({ prompts: saved });
    }
    return json({ ok: true });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><Prompts org={ORG} /></QueryClientProvider>);
const value = (id: string) => (screen.getByTestId(id) as HTMLInputElement).value;

describe('Prompts', () => {
  it("shows the organization's prompts where it changed them, and the defaults elsewhere", async () => {
    mount();
    await waitFor(() => expect(value('prompts-home-0')).toBe('Plan my day'));
    expect(value('prompts-mail-message-0')).toBe(DEFAULT_PROMPTS['mail-message'][0]);
    expect(screen.getByTestId('prompts-chat').textContent).toContain('no assistant panel yet');
    expect((screen.getByTestId('prompts-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves only the pages that differ from the defaults: an edit, an added prompt, a reset', async () => {
    mount();
    await waitFor(() => expect(value('prompts-home-0')).toBe('Plan my day'));
    fireEvent.change(screen.getByTestId('prompts-calendar-0'), { target: { value: 'What is next?' } });
    fireEvent.click(screen.getByTestId('prompts-admin-add'));
    fireEvent.change(screen.getByTestId(`prompts-admin-${DEFAULT_PROMPTS.admin.length}`), { target: { value: 'Who joined this week?' } });
    fireEvent.click(screen.getByTestId('prompts-home-reset'));
    fireEvent.click(screen.getByTestId('prompts-save'));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      admin: [...DEFAULT_PROMPTS.admin, 'Who joined this week?'],
      calendar: ['What is next?', ...DEFAULT_PROMPTS.calendar.slice(1)],
    });
  });

  it('keeps a page with every prompt removed as none', async () => {
    mount();
    await waitFor(() => expect(value('prompts-home-0')).toBe('Plan my day'));
    fireEvent.click(screen.getByTestId('prompts-home-remove-0'));
    fireEvent.click(screen.getByTestId('prompts-save'));
    await waitFor(() => expect(puts[0]).toEqual({ home: [] }));
  });
});
