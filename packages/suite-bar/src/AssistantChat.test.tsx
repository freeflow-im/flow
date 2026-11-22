import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SuiteAssistant } from './AssistantChat';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => localStorage.clear());

/** The server: the agents the person may use (with `?app=`, those that may use the app), and empty answers elsewhere. */
function serve(agents: unknown[], bodies: unknown[] = []) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    asked.push(url);
    if (url.startsWith('/api/agent/turn')) {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('data: {"type":"done"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    const body = url.startsWith('/api/settings/assistant') ? { settings: { provider: 'openai', openaiModel: 'gpt-6-astra', anthropicModel: 'claude-sonnet-5-5', openrouterModel: '' } } : url.startsWith('/api/agent/agents') ? { agents } : url.startsWith('/api/agent/history') ? { chats: [] } : { items: [], prompts: {} };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return asked;
}

const taskboard = { name: 'taskboard', label: 'Taskboard' };

describe('SuiteAssistant over an installed app', () => {
  it('asks only for the agents that may use the app, and opens on one of them', async () => {
    const asked = serve([{ id: 'a1', accountId: 'acc1', displayName: 'Ada', mode: 'personal', self: true }, { id: 'a2', accountId: 'acc2', displayName: 'Helper', mode: 'shared', self: false }]);
    render(<SuiteAssistant organizationId="org1" page="home" app={taskboard} />);
    const pill = await screen.findByRole('button', { name: 'Open Assistant' });
    await waitFor(() => expect(pill.textContent).toBe('Ada'));
    expect(asked).toContain('/api/agent/agents?workspace=org1&app=taskboard');
    fireEvent.click(pill);
    expect(screen.getByTestId('suite-assistant-picker')).toBeTruthy();
    expect(screen.getByText(/Ask Ada to work in Taskboard/)).toBeTruthy();
    // Anchoring works as in every app.
    fireEvent.click(screen.getByRole('button', { name: 'Anchor the panel beside the page' }));
    expect(screen.getByTestId('assistant-dock').className).toBe('assistant-dock docked');
  });

  it('says where to turn the app on when no agent may use it', async () => {
    serve([]);
    render(<SuiteAssistant organizationId="org1" page="home" app={taskboard} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Assistant' }));
    expect((await screen.findByTestId('suite-assistant-no-agent')).textContent).toMatch(/None of your agents can use Taskboard yet/);
  });
});

describe("the panel's header", () => {
  it("names the agent, and shows the organization's model on focus", async () => {
    const asked = serve([{ id: 'a1', accountId: 'acc1', displayName: 'Ada', mode: 'personal', self: true }]);
    render(<SuiteAssistant organizationId="org1" page="home" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Assistant' }));
    const name = await screen.findByTestId('suite-assistant-name');
    await waitFor(() => expect(name.textContent).toBe('Ada'));
    await waitFor(() => expect(asked).toContain('/api/settings/assistant?workspace=org1'));
    fireEvent.focus(name);
    expect((await screen.findByRole('tooltip')).textContent).toBe('OpenAI · Astra');
    expect(name.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);
    fireEvent.blur(name);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('images in the panel (⌘V, drop, attach)', () => {
  const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'shot.png', { type: 'image/png' });
  const clipboard = (files: File[]) => ({ items: files.map((f) => ({ kind: 'file', getAsFile: () => f })), files, types: ['Files'] });

  it('takes a pasted screenshot as a thumbnail, and sends it with the message', async () => {
    const bodies: Record<string, unknown>[] = [];
    serve([{ id: 'a1', accountId: 'acc1', displayName: 'Ada', mode: 'personal', self: true }], bodies);
    render(<SuiteAssistant organizationId="org1" page="home" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Assistant' }));
    const box = screen.getByTestId('suite-assistant-input');
    fireEvent.paste(box, { clipboardData: clipboard([png()]) });
    const thumbs = await screen.findByTestId('suite-assistant-attachments');
    expect(thumbs.querySelectorAll('img')).toHaveLength(1);
    // An image alone may be sent.
    expect((screen.getByTestId('suite-assistant-send') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(box, { target: { value: 'what is this?' } });
    fireEvent.click(screen.getByTestId('suite-assistant-send'));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]!.message).toBe('what is this?');
    expect(bodies[0]!.images).toEqual([{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
    // The thumbnails go; the sent message shows the image.
    expect(screen.queryByTestId('suite-assistant-attachments')).toBeNull();
    expect(screen.getByAltText('Attached image 1').getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('keeps at most four, says so, and removes one on ×', async () => {
    serve([{ id: 'a1', accountId: 'acc1', displayName: 'Ada', mode: 'personal', self: true }]);
    render(<SuiteAssistant organizationId="org1" page="home" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Assistant' }));
    fireEvent.paste(screen.getByTestId('suite-assistant-input'), { clipboardData: clipboard([png(), png(), png(), png(), png()]) });
    const thumbs = await screen.findByTestId('suite-assistant-attachments');
    await waitFor(() => expect(thumbs.querySelectorAll('img')).toHaveLength(4));
    expect(thumbs.textContent).toMatch(/Only 4 images fit in one message/);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove image' })[0]!);
    expect(screen.getByTestId('suite-assistant-attachments').querySelectorAll('img')).toHaveLength(3);
  });

  it('leaves a text paste to the box', async () => {
    serve([{ id: 'a1', accountId: 'acc1', displayName: 'Ada', mode: 'personal', self: true }]);
    render(<SuiteAssistant organizationId="org1" page="home" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Assistant' }));
    fireEvent.paste(screen.getByTestId('suite-assistant-input'), { clipboardData: { items: [{ kind: 'string', getAsFile: () => null }], files: [], types: ['text/plain'] } });
    expect(screen.queryByTestId('suite-assistant-attachments')).toBeNull();
  });
});
