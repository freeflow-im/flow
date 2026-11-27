// The assistant's chat for Home and Admin (suiteChat.ts): the stream read event by event, a turn's text and server
// tools, and a browser tool answered "open its app" so the turn goes on.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEvents } from './suiteChat';
import { SuiteAssistant, SuiteAssistantColumn } from './AssistantChat';

const sse = (...events: unknown[]) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))); c.close(); } }), { status: 200 });
let turns: Record<string, unknown>[];
/** The agents GET /api/agent/agents lists (the person's assistant alone, unless a test adds more). */
let usable: Record<string, unknown>[];
const ADA = { id: 'ada', accountId: 'a', displayName: 'Ada', avatarUrl: '/agent-avatars/mint.svg', mode: 'personal', self: true };
beforeEach(() => {
  turns = [];
  usable = [ADA];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path.startsWith('/api/agent/agents')) return json({ agents: usable });
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
  it('starts with the admin agent where Admin prefers it, and the picker switches to any other agent (agents.md §1.4)', async () => {
    usable = [ADA, { id: 'carl', accountId: 'c', displayName: 'Carl', avatarUrl: null, mode: 'shared', self: false, role: 'admin' }];
    render(<SuiteAssistant organizationId="o1" page="admin" prefer="admin" />);
    await waitFor(() => expect(screen.getByText('Carl')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Open Assistant/ }));
    const picker = (await screen.findByTestId('suite-assistant-picker')) as HTMLSelectElement;
    expect(picker.value).toBe('carl');
    fireEvent.change(await screen.findByTestId('suite-assistant-input'), { target: { value: 'who is here?' } });
    await act(async () => { fireEvent.click(screen.getByTestId('suite-assistant-send')); });
    await screen.findByText('two');
    // Both requests of the turn (the message, then the browser tool's answer) go to Carl.
    expect(turns.map((t) => t.agent)).toEqual(['carl', 'carl']);
    expect(turns[0]).toMatchObject({ workspace: 'o1' });
    await waitFor(() => expect(picker.disabled).toBe(false));
    fireEvent.change(picker, { target: { value: 'ada' } });
    expect(picker.value).toBe('ada');
  });

  it('starts with the person\'s own assistant when they cannot use the admin agent', async () => {
    render(<SuiteAssistant organizationId="o1" page="admin" prefer="admin" />);
    await waitFor(() => expect(screen.getByText('Ada')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Open Assistant/ }));
    expect(screen.queryByTestId('suite-assistant-picker')).toBeNull();
  });

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

  it('lets a page add context to each message and run the browser tools itself (FreeFlow Browser\'s side panel)', async () => {
    const prepare = vi.fn(async () => ({ browser: true, webPage: { tab: 7, url: 'https://example.com/', title: 'Example', text: 'Hello' } }));
    const runClientCalls = vi.fn(async (calls: { id: string; name: string }[]) => ({ toolResults: calls.map((c) => ({ id: c.id, content: 'ran it' })), pictures: { c1: 'data:image/jpeg;base64,AAAA' } }));
    render(<SuiteAssistantColumn organizationId="o1" page="home" options={{ prepare, runClientCalls }} composerTop={<div>chip here</div>} placeholder="Ask about this page…" />);
    expect(await screen.findByText('chip here')).toBeTruthy();
    const input = (await screen.findByTestId('suite-assistant-input')) as HTMLTextAreaElement;
    expect(input.placeholder).toBe('Ask about this page…');
    fireEvent.change(input, { target: { value: 'summarize' } });
    await act(async () => { fireEvent.click(screen.getByTestId('suite-assistant-send')); });
    await screen.findByText('two');
    // Read once for the message, and sent with both requests of its turn.
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(turns.map((t) => (t.context as { webPage?: { tab: number } }).webPage?.tab)).toEqual([7, 7]);
    expect(turns[0]!.context).toMatchObject({ page: 'home', browser: true });
    // The page ran the call, so its answer went back as it is, with the picture under the tool's line.
    expect(runClientCalls).toHaveBeenCalledWith([{ id: 'c1', name: 'open_sheet', input: {} }]);
    expect(turns[1]!.toolResults).toEqual([{ id: 'c1', content: 'ran it' }]);
    expect(screen.getByAltText('Picture 1 the tool took')).toBeTruthy();
  });
});
