// The assistant panel's header: the person's assistant by name ("Ada"), and on hover or focus, what it runs on.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantPanel, type AssistantPanelProps } from './AssistantPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/settings/assistant')) return new Response(JSON.stringify({ settings: { provider: 'anthropic', anthropicModel: 'claude-opus-5-5', openaiModel: 'gpt-6.1-sol', openrouterModel: '' } }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  }));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const chat = { items: [], running: false, question: null, error: null, send: vi.fn(), stop: vi.fn(), reset: vi.fn(), reload: vi.fn() } as unknown as AssistantPanelProps['chat'];
const props = (over: Partial<AssistantPanelProps> = {}): AssistantPanelProps => ({ chat, organizationId: 'org1', onEvent: false, overlay: false, width: 400, onClose: vi.fn(), onOpenEvent: vi.fn(), ...over });
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

describe('AssistantPanel header', () => {
  it("shows the assistant's name, and its provider and model on focus", async () => {
    await act(async () => root.render(createElement(AssistantPanel, props({ assistantName: 'Ada' }))));
    await settle();
    const name = host.querySelector<HTMLElement>('[data-testid=calendar-assistant-name]')!;
    expect(name.textContent).toBe('Ada');
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u) === '/api/settings/assistant?workspace=org1')).toBe(true);
    await act(async () => name.focus());
    await settle();
    expect(document.body.textContent).toContain('Anthropic · Claude Opus 5.5');
  });
  it('says "Assistant" until the name is known', async () => {
    await act(async () => root.render(createElement(AssistantPanel, props())));
    expect(host.querySelector('[data-testid=calendar-assistant-name]')!.textContent).toBe('Assistant');
  });
});
