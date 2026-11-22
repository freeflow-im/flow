// show_alert (shared/alerts.ts): the bridge's tool posts the alert to /v1/alerts as the agent, naming no one, and passes
// the server's refusal on.
import { describe, expect, it } from 'vitest';
import { FlowApiError } from '../src/api.js';
import { ALERT_TOOL_NAMES, alertTool, type AlertApi } from '../src/alert-tools.js';

function fake(fail?: FlowApiError) {
  const calls: { workspaceId: string; body: unknown }[] = [];
  const api: AlertApi = {
    alerts: (async (workspaceId: string, body: unknown) => {
      calls.push({ workspaceId, body });
      if (fail) throw fail;
      return { alert: { alertId: 'a1', to: 'the person you are working for', endsAt: '2026-11-22T18:30:00.000Z' } };
    }) as AlertApi['alerts'],
  };
  return { api, calls };
}

describe('show_alert', () => {
  it('is one tool, by name', () => {
    expect([...ALERT_TOOL_NAMES]).toEqual(['show_alert']);
  });

  it('sends the alert with no recipient, and says who got it', async () => {
    const f = fake();
    const out = await alertTool(f.api, 'ws-1', 'show_alert', { title: ' Report ready ', lines: ['Q3 numbers'], links: [{ label: 'Open', url: '/docs/x' }], minutes: 10, to: 'someone-else' });
    expect(out).toEqual({ text: 'alert shown to the person you are working for until 2026-11-22T18:30:00.000Z (id a1)', isError: false });
    expect(f.calls[0]).toEqual({ workspaceId: 'ws-1', body: { title: 'Report ready', lines: ['Q3 numbers'], links: [{ label: 'Open', url: '/docs/x' }], minutes: 10 } });
  });

  it('refuses without a title or a workspace, and passes the server’s refusal on', async () => {
    const f = fake();
    expect((await alertTool(f.api, 'ws-1', 'show_alert', {})).isError).toBe(true);
    expect((await alertTool(f.api, '', 'show_alert', { title: 'x' })).isError).toBe(true);
    const refused = fake(new FlowApiError(400, 'bad_alert', 'Link 1 is not a web address.'));
    expect(await alertTool(refused.api, 'ws-1', 'show_alert', { title: 'x', links: [{ label: 'x', url: 'javascript:1' }] })).toEqual({ text: 'Link 1 is not a web address.', isError: true });
    expect(f.calls).toHaveLength(0);
  });
});
