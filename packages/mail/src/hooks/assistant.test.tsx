import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useMailAssistant, type MailAssistantOptions } from './assistant';
import type { AgentEvent, AgentTurnRequest, MailContext } from '../lib/docsAgent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACC = 'acc1';
const ctx: MailContext = { page: 'mail', accountId: ACC, account: 'ann@test.local', folder: 'INBOX' };
const sse = (events: AgentEvent[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });

let root: Root, chat: ReturnType<typeof useMailAssistant>;
const calls: { url: string; body: unknown }[] = [];
function Harness(p: MailAssistantOptions) {
  chat = useMailAssistant(p);
  return null;
}

beforeEach(() => {
  calls.length = 0;
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('Mail’s assistant chat', () => {
  it('loads the Mail chat of the selected organization, runs a turn, opens a message for the assistant and refreshes the lists after a draft', async () => {
    const turns: AgentEvent[][] = [
      [
        { type: 'tool_start', id: 'd1', name: 'create_mail_draft', input: { body: 'Hi' } },
        { type: 'tool_end', id: 'd1', ok: true, result: JSON.stringify({ saved: true, draft_id: `${ACC}:Drafts:4` }) },
        { type: 'client_tools', calls: [{ id: 'o1', name: 'open_mail_message', input: { id: `${ACC}:Drafts:4` } }] },
      ],
      [{ type: 'text', text: 'Your draft is ready.' }, { type: 'done' }],
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.startsWith('/api/agent?')) return Response.json({ items: [{ kind: 'user', text: 'earlier' }], title: null });
        return sse(turns.shift()!);
      }),
    );
    const show = vi.fn(() => true);
    const onMailChanged = vi.fn();
    await act(async () => root.render(createElement(Harness, { org: 'org1', context: () => ctx, show, reply: async () => ({ shown: 'inline' as const }), onMailChanged })));
    expect(calls[0]?.url).toBe('/api/agent?scope=mail&workspace=org1');
    expect(chat.items).toEqual([{ kind: 'user', text: 'earlier' }]);

    await act(async () => {
      chat.send('Draft a reply to this');
      await vi.waitFor(() => expect(chat.running).toBe(false));
    });
    const first = calls[1]!;
    expect(first.url).toBe('/api/agent/turn?workspace=org1');
    expect(first.body).toMatchObject({ message: 'Draft a reply to this', context: ctx, scope: 'mail', workspace: 'org1' } satisfies Partial<AgentTurnRequest> & { workspace: string });
    // The turn resumes with open_mail_message's result, in the same chat.
    expect(calls[2]?.body).toMatchObject({ scope: 'mail', toolResults: [{ id: 'o1', content: JSON.stringify({ opened: `${ACC}:Drafts:4` }) }] });
    expect(show).toHaveBeenCalledWith({ account: ACC, folder: 'Drafts', uid: 4 });
    expect(onMailChanged).toHaveBeenCalledTimes(1);
    expect(chat.error).toBeNull();
    expect(chat.items.map((i) => (i.kind === 'tool' ? `${i.name}:${i.status}` : i.kind))).toEqual(['user', 'user', 'create_mail_draft:ok', 'open_mail_message:ok', 'assistant']);
    // The draft's result is kept for "Open draft".
    expect(chat.items.find((i) => i.kind === 'tool' && i.name === 'create_mail_draft')).toMatchObject({ result: expect.stringContaining('Drafts:4') });
  });

  it('says so when the stream is cut off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.startsWith('/api/agent?') ? Response.json({ items: [], title: null }) : sse([{ type: 'text', text: 'Hal' }]))),
    );
    await act(async () => root.render(createElement(Harness, { org: null, context: () => ctx, show: () => true, reply: async () => ({ shown: 'inline' as const }), onMailChanged: () => {} })));
    await act(async () => {
      chat.send('hello');
      await vi.waitFor(() => expect(chat.running).toBe(false));
    });
    expect(chat.error).toMatch(/interrupted/);
  });
});
