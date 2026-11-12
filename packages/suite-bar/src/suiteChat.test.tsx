// The assistant's chat for Home and Admin (suiteChat.ts): the stream read event by event, a turn's text and server
// tools, and a browser tool answered "open its app" so the turn goes on.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEvents } from './suiteChat';
import { SuiteAssistant } from './AssistantChat';

const sse = (...events: unknown[]) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))); c.close(); } }), { status: 200 });
let turns: Record<string, unknown>[];
beforeEach(() => {
  turns = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path.startsWith('/api/agent/agents')) return json({ agents: [{ id: 'ada', accountId: 'a', displayName: 'Ada', avatarUrl: '/agent-avatars/mint.svg', mode: 'personal', self: true }] });
    if (path.startsWith('/api/agent?')) return json({ items: [] });
    if (path.endsWith('/assistant-prompts')) return json({ prompts: { home: ['Plan my day'] } });
    if (path.startsWith('/api/agent/turn')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      turns.push({ ...body, tz: (init?.headers as Record<string, string>)['X-Timezone'] });
      if (turns.length === 1) return sse({ type: 'text', text: 'Looking. ' }, { type: 'tool_start', id: 't1', name: 'list_events', input: {} }, { type: 'tool_end', id: 't1', ok: true }, { type: 'client_tools', calls: [{ id: 'c1', name: 'open_sheet', input: {} }] });
      return sse({ type: 'text', text: 'You have **two** meetings.' }, { type: 'done' });
    }
    return json({ ok: true });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the suite assistant chat', () => {
  it('reads the stream event by event, keeping a part event for the next chunk', () => {
    const { events, rest } = parseEvents('data: {"type":"text","text":"a"}\n\ndata: {"type":"do');
    expect(events).toEqual([{ type: 'text', text: 'a' }]);
    expect(rest).toBe('data: {"type":"do');
  });

  it('is the person’s assistant: a turn’s text, its server tool, and a browser tool answered so the turn goes on', async () => {
    render(<SuiteAssistant organizationId="o1" page="home" />);
    await waitFor(() => expect(screen.getByText('Ada')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Open Assistant/ }));
    // The organization's own suggested prompt for Home (Admin → Prompts).
    expect(await screen.findByRole('button', { name: 'Plan my day' })).toBeTruthy();
    fireEvent.change(await screen.findByTestId('suite-assistant-input'), { target: { value: 'what is today?' } });
    await act(async () => { fireEvent.click(screen.getByTestId('suite-assistant-send')); });
    await screen.findByText('two');
    expect(turns[0]).toMatchObject({ message: 'what is today?', scope: 'home', workspace: 'o1', context: { page: 'home' } });
    expect(typeof turns[0]!.tz).toBe('string');
    expect(turns[1]).toMatchObject({ toolResults: [{ id: 'c1', isError: true }] });
    expect(screen.getByText(/list events/)).toBeTruthy();
  });
});
