// @vitest-environment happy-dom
// The assistant panel's ‹ › (ChatHistoryNav): where each step goes, newest first, and a step reopening that conversation.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatHistoryNav, historySteps, type ChatSummary } from './AssistantDock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const chat = (id: string, active = false): ChatSummary => ({ id, startedAt: '2026-11-12T10:00:00Z', title: `Chat ${id}`, active });

describe('historySteps', () => {
  it('steps older and newer from the active conversation, newest first', () => {
    expect(historySteps([chat('c'), chat('b', true), chat('a')])).toEqual({ older: chat('a'), newer: chat('c'), position: 2 });
    expect(historySteps([chat('c', true), chat('b')])).toEqual({ older: chat('b'), newer: undefined, position: 2 });
    expect(historySteps([chat('b'), chat('a', true)])).toEqual({ older: undefined, newer: chat('b'), position: 1 });
  });
  it('treats a new, empty chat as before the newest', () => {
    expect(historySteps([chat('b'), chat('a')])).toEqual({ older: chat('b'), position: null });
    expect(historySteps([])).toEqual({ older: undefined, position: null });
  });
});

describe('ChatHistoryNav', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const q = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

  it('is hidden with nothing earlier, and steps back by reopening the conversation', async () => {
    let list = [chat('b', true)];
    const reopened: string[] = [];
    let reloads = 0;
    const history = { list: async () => list, reopen: async (id: string) => { reopened.push(id); list = list.map((c) => ({ ...c, active: c.id === id })); } };
    await act(async () => root.render(<ChatHistoryNav history={history} busy={false} refreshKey={1} onReopened={() => reloads++} />));
    expect(q('assistant-history')).toBeNull();
    list = [chat('b', true), chat('a')];
    await act(async () => root.render(<ChatHistoryNav history={history} busy={false} refreshKey={2} onReopened={() => reloads++} />));
    expect(host.textContent).toContain('2/2');
    expect(q('assistant-history-newer')!.disabled).toBe(true);
    await act(async () => { q('assistant-history-older')!.click(); });
    expect(reopened).toEqual(['a']);
    expect(reloads).toBe(1);
    expect(host.textContent).toContain('1/2');
    expect(q('assistant-history-older')!.disabled).toBe(true);
    expect(q('assistant-history-newer')!.disabled).toBe(false);
  });

  it('cannot step while a turn runs', async () => {
    const history = { list: async () => [chat('b', true), chat('a')], reopen: async () => {} };
    await act(async () => root.render(<ChatHistoryNav history={history} busy refreshKey={1} onReopened={() => {}} />));
    expect(q('assistant-history-older')!.disabled).toBe(true);
  });
});
