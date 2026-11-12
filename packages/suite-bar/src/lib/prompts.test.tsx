// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_PROMPTS, promptsChanged, useSuggestedPrompts, type PromptPage } from './prompts';

function Prompts({ org, page, fallback }: { org: string | null; page: PromptPage; fallback?: string[] }) {
  return <ul>{useSuggestedPrompts(org, page, fallback).map((p) => <li key={p}>{p}</li>)}</ul>;
}
const shown = () => screen.queryAllByRole('listitem').map((li) => li.textContent);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useSuggestedPrompts', () => {
  it("offers the organization's prompts for a page it changed, and the defaults elsewhere", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ prompts: { home: ['Plan my day'] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    render(
      <>
        <Prompts org="org-1" page="home" />
        <Prompts org="org-1" page="calendar" fallback={['Who is coming?']} />
      </>,
    );
    await waitFor(() => expect(shown()).toEqual(['Plan my day', 'Who is coming?']));
    // One read for the two panels.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shows the defaults with no organization, or when the read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    render(<Prompts org="org-2" page="admin" />);
    expect(shown()).toEqual(DEFAULT_PROMPTS.admin);
    await act(async () => {});
    expect(shown()).toEqual(DEFAULT_PROMPTS.admin);
  });

  it('shows a save made on this page at once', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ prompts: {} }), { status: 200 })));
    render(<Prompts org="org-3" page="chat" />);
    await act(async () => {});
    expect(shown()).toEqual(DEFAULT_PROMPTS.chat);
    await act(async () => promptsChanged('org-3', { chat: [] }));
    await waitFor(() => expect(shown()).toEqual([]));
  });
});
