import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SuiteAssistant } from './AssistantChat';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => localStorage.clear());

/** The server: the agents the person may use (with `?app=`, those that may use the app), and empty answers elsewhere. */
function serve(agents: unknown[]) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    asked.push(url);
    const body = url.startsWith('/api/agent/agents') ? { agents } : url.startsWith('/api/agent/history') ? { chats: [] } : { items: [], prompts: {} };
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
