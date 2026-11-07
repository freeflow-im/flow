// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelDTO, SubscriptionDTO, WorkspaceMemberDTO } from '@flow/shared';
import { ApiError } from '../lib/connectionRuntime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.fn();
vi.mock('../lib/useBoundApi', () => ({ useBoundApi: () => ({ api }) }));

import { AutomationsSection, buildSubscriptionBody, emptyDraft } from './AutomationsSection';

const member = (name: string, extra: Partial<WorkspaceMemberDTO> = {}): WorkspaceMemberDTO => ({
  userId: `u-${name}`, displayName: name, email: `${name.toLowerCase()}@example.com`, avatarUrl: null, statusEmoji: '',
  statusText: '', title: '', isAgent: false, isBot: false, sponsorId: null, privacyMode: false, role: 'member',
  joinedAt: '2026-11-01T00:00:00.000Z', ...extra,
});
const members = [
  member('Ann', { role: 'owner', accountId: 'acct-ann' }),
  member('Botty', { isAgent: true, accountId: 'acct-botty' }),
  member('Ghost', { isAgent: true }),
];
const channel = (id: string, name: string, isMember = true) =>
  ({ id, name, workspaceId: 'w1', kind: 'public', isMember, archivedAt: null }) as unknown as ChannelDTO;
const channels = [channel('c-gen', 'general'), channel('c-ops', 'ops'), channel('c-far', 'elsewhere', false)];

const base = { consumer: 'acct-ann', owner: 'acct-ann', cursor: 0, createdBy: 'acct-ann', createdAt: '2026-11-05T10:00:00.000Z' };
const subs: SubscriptionDTO[] = [
  { ...base, id: 's-wake', name: 'Summaries', consumer: 'acct-botty', filter: { types: ['chat.message.created'], channelId: 'c-gen' }, delivery: 'wake', cursor: 42, action: { kind: 'wake', prompt: 'Summarize {{data}}' } },
  { ...base, id: 's-post', name: 'Echo', filter: { types: ['chat.reaction.added'] }, delivery: 'post', action: { kind: 'post', channelId: 'c-ops', body: 'Reacted', includeSelf: true }, parkedAt: '2026-11-06T08:00:00.000Z' },
  { ...base, id: 's-sched', name: 'Standup', consumer: 'acct-botty', filter: { types: ['schedule.tick'] }, delivery: 'wake', action: { kind: 'wake', prompt: 'Run standup' }, schedule: { id: 'sc1', every: 'weekly@MON 09:30', timezone: 'Europe/Paris', nextAt: '' } },
];

let root: Root;
let host: HTMLDivElement;
const $ = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const click = (id: string) => act(async () => { $(id)!.click(); });
/** Set a form control's value the way React notices. */
const change = (id: string, value: string) => act(async () => {
  const el = $(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});

async function mount(list: SubscriptionDTO[] = subs) {
  api.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET' && path.startsWith('/v1/events/subscriptions')) return { subscriptions: list };
    if (method === 'GET' && path.startsWith('/v1/events/jobs')) {
      return { jobs: [{ id: 'j1', subscriptionId: 's-wake', agent: 'acct-botty', eventId: 'e1', eventSeq: 9, prompt: 'p', state: 'done', attempts: 1, note: 'summarized', depth: 1, createdAt: '2026-11-06T09:00:00.000Z', updatedAt: '' }] };
    }
    return { ok: true, subscription: {} };
  });
  await act(async () => {
    root.render(<AutomationsSection workspaceId="w1" members={members} channels={channels} />);
  });
  await flush();
}

beforeEach(() => {
  api.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the automations list', () => {
  it('renders a wake, a post and a schedule row', async () => {
    await mount();
    expect(api).toHaveBeenCalledWith('GET', '/v1/events/subscriptions?workspace=w1');
    expect($('automation-filter-s-wake')!.textContent).toBe('chat.message.created in #general');
    expect($('automation-action-s-wake')!.textContent).toBe('Wake Botty: “Summarize {{data}}”');
    expect($('automation-s-wake')!.textContent).toContain('cursor 42');
    expect($('automation-action-s-post')!.textContent).toBe('Post in #ops: “Reacted”, including your own events');
    expect($('automation-parked-s-post')!.textContent).toContain('parked');
    expect($('automation-parked-s-wake')).toBeNull();
    expect($('automation-filter-s-sched')!.textContent).toBe('every Monday at 09:30 (Europe/Paris)');
    expect($('automation-jobs-s-wake')).not.toBeNull();
    expect($('automation-jobs-s-post')).toBeNull();
  });

  it('expands a wake row\'s recent jobs', async () => {
    await mount();
    await click('automation-jobs-s-wake');
    await flush();
    expect(api).toHaveBeenCalledWith('GET', '/v1/events/jobs?subscription=s-wake&workspace=w1');
    expect($('automation-job-j1')!.textContent).toContain('done');
    expect($('automation-job-j1')!.textContent).toContain('summarized');
  });

  it('deletes after a confirm, then reloads', async () => {
    await mount();
    await click('automation-delete-s-post');
    expect(api).not.toHaveBeenCalledWith('DELETE', expect.anything());
    await click('automation-delete-confirm-s-post');
    await flush();
    expect(api).toHaveBeenCalledWith('DELETE', '/v1/events/subscriptions/s-post?workspace=w1');
    expect(api.mock.calls.filter(([m, p]) => m === 'GET' && String(p).startsWith('/v1/events/subscriptions')).length).toBe(2);
  });
});

describe('the new-automation form', () => {
  const posted = () => api.mock.calls.find(([m]) => m === 'POST');

  it('offers only agents with an account, and channels the person is in', async () => {
    await mount([]);
    const agents = [...($('automation-agent') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(agents).toEqual(['Choose an agent…', 'Botty']);
    const chans = [...($('automation-channel') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(chans).toEqual(['Any channel', '#general', '#ops']);
  });

  it('builds a wake on an event', async () => {
    await mount([]);
    await change('automation-channel', 'c-gen');
    await change('automation-text', 'urgent');
    await change('automation-agent', 'acct-botty');
    await change('automation-prompt', 'Look at {{data}}');
    expect(($('automation-name') as HTMLInputElement).value).toBe('Wake Botty on chat.message.created in #general');
    await click('automation-create');
    await flush();
    expect(posted()).toEqual(['POST', '/v1/events/subscriptions?workspace=w1', {
      name: 'Wake Botty on chat.message.created in #general',
      filter: { types: ['chat.message.created'], channelId: 'c-gen', text: 'urgent' },
      delivery: 'wake', consumer: 'acct-botty', action: { kind: 'wake', prompt: 'Look at {{data}}' },
    }]);
  });

  it('builds a post on a schedule, with an edited name', async () => {
    await mount([]);
    await click('automation-trigger-schedule');
    await change('automation-freq', 'monthly');
    await change('automation-date', '15');
    await change('automation-time', '08:15');
    await change('automation-timezone', 'America/New_York');
    await click('automation-action-post');
    await change('automation-post-channel', 'c-ops');
    await change('automation-body', 'Invoices are due');
    await click('automation-include-self');
    await change('automation-name', 'Invoice reminder');
    await click('automation-create');
    await flush();
    expect(posted()![2]).toEqual({
      name: 'Invoice reminder', filter: {}, delivery: 'post',
      action: { kind: 'post', channelId: 'c-ops', body: 'Invoices are due', includeSelf: true },
      schedule: { every: 'monthly@15 08:15', timezone: 'America/New_York' },
    });
  });

  it('builds a scheduled wake, and shows the server\'s agent_forbidden message', async () => {
    await mount([]);
    api.mockImplementation(async (method: string) => {
      if (method === 'POST') throw new ApiError(403, 'agent_forbidden', "only the agent's sponsor may make it a wake subscription");
      return { subscriptions: [] };
    });
    await click('automation-trigger-schedule');
    await change('automation-freq', 'weekly');
    await change('automation-day', 'FRI');
    await change('automation-agent', 'acct-botty');
    await change('automation-run-in', 'c-ops');
    await change('automation-prompt', 'Weekly report');
    await click('automation-create');
    await flush();
    expect(posted()![2]).toMatchObject({
      delivery: 'wake', consumer: 'acct-botty', filter: {},
      action: { kind: 'wake', prompt: 'Weekly report', channelId: 'c-ops' },
      schedule: { every: 'weekly@FRI 09:00' },
    });
    expect($('automation-form-error')!.textContent).toBe("only the agent's sponsor may make it a wake subscription");
  });

  it('builds hourly and daily every strings', () => {
    const names = { member: () => 'X', channel: () => '#x' };
    const d = { ...emptyDraft(), trigger: 'schedule' as const, action: 'post' as const, postChannel: 'c', body: 'b', timezone: 'UTC' };
    expect(buildSubscriptionBody({ ...d, freq: 'hourly' }, names).schedule).toEqual({ every: 'hourly', timezone: 'UTC' });
    expect(buildSubscriptionBody({ ...d, freq: 'daily', time: '17:45' }, names).schedule).toEqual({ every: 'daily@17:45', timezone: 'UTC' });
    expect(buildSubscriptionBody({ ...d, freq: 'hourly' }, names).name).toBe('Post in #x every hour');
  });
});
