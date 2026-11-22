// Members (docs/specs/workspace-admin.md §3.2, §5), against a fetch that answers the suite's API: the one-line roster with
// email, role, kind and mail state, the filters, Retry and Create inbox, the bulk actions, the Add member dialog (a user
// created or invited, a chat guest, a native or an external agent), pending invitations.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDTO, DomainDTO, PendingSetupDTO, WorkspaceDTO, WorkspaceInviteDTO, WorkspaceMemberDTO } from '@flow/shared';
import { kindLabel, mailState, Members, suggestUsername, visibleEmail } from './Members';
import { addressLocal, agentHandle, bridgeCommand } from './AddMember';

const org: WorkspaceDTO = {
  id: 'o1', slug: 'acme', name: 'Acme', createdBy: 'u-ann', createdAt: '2026-01-01T00:00:00.000Z', sidebarColor: 'violet', avatarUrl: null, googleSelfRegisterDomain: null, role: 'owner',
};
const member = (name: string, extra: Partial<WorkspaceMemberDTO> = {}): WorkspaceMemberDTO => ({
  userId: `u-${name.toLowerCase()}`, displayName: name, email: `${name.toLowerCase()}@example.com`, avatarUrl: null, statusEmoji: '', statusText: '', title: '',
  isAgent: false, isBot: false, sponsorId: null, privacyMode: false, role: 'member', joinedAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const account = (name: string, extra: Partial<AccountDTO> = {}): AccountDTO => ({
  id: `a-${name.toLowerCase()}`, principalId: `u-${name.toLowerCase()}`, organizationId: 'o1', address: `${name.toLowerCase()}@acme.freeflow.im`, displayName: name,
  role: 'member', kind: 'native', state: 'active', hosted: true, createdAt: '', ...extra,
});

let calls: { method: string; path: string; body: unknown }[];
let members: WorkspaceMemberDTO[];
let accounts: AccountDTO[];
let invites: WorkspaceInviteDTO[];
let hostedMail: boolean;
let setups: PendingSetupDTO[];
let createAnswer: { status: number; body: unknown };
const domain = (name: string, extra: Partial<DomainDTO> = {}): DomainDTO => ({ domain: name, kind: 'own', verified: true, primary: false, records: [], status: [], atProvider: true, createdAt: '', ...extra });
const domains: DomainDTO[] = [domain('acme.freeflow.im', { kind: 'platform' }), domain('acme.com', { primary: true }), domain('pending.com', { verified: false })];

beforeEach(() => {
  window.history.replaceState(null, '', '/admin/members');
  calls = [];
  hostedMail = true;
  members = [member('Ann', { role: 'owner' }), member('Bob'), member('Cal'), member('Dee'), member('Botty', { isAgent: true, email: 'agent-u-botty@agents.flow.local', sponsorId: 'u-ann' }), member('Hosty', { isAgent: true, agentRuntime: undefined, email: 'agent-u-hosty@agents.flow.local', sponsorId: 'u-bob' })];
  accounts = [
    account('Ann', { role: 'owner' }),
    account('Bob'),
    account('Cal', { kind: 'guest', address: null, hosted: false }),
    account('Dee', { state: 'requested', hosted: false, statusMessage: 'the provider refused: quota' }),
    account('Botty'),
    account('Hosty', { agentRuntime: 'hosted', hosted: false, sponsorId: 'u-bob' }),
  ];
  setups = [{ accountId: 'a-hal', userId: 'u-hal', address: 'hal@acme.com', displayName: 'Hal', backupEmail: 'hal@gmail.example', createdAt: '2026-01-02T00:00:00.000Z', linkExpiresAt: null }];
  createAnswer = { status: 201, body: { account: account('Bea', { address: 'bea.lin@acme.com' }), pending: { ...setups[0], backupEmail: 'bea@gmail.example' }, emailSent: true } };
  invites = [{ id: 'i1', email: 'eve@example.com', kind: 'guest', invitedBy: { id: 'u-ann', displayName: 'Ann' }, createdAt: '2026-01-02T00:00:00.000Z', expiresAt: '2026-01-09T00:00:00.000Z' }];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/v1/config') return json({ google: false, googleClientId: null, apple: false, maxFileBytes: 1, hostedMail });
    if (path === '/v1/me') return json({ id: 'u-ann', email: 'ann@example.com', displayName: 'Ann', avatarUrl: null, statusEmoji: '', statusText: '' });
    if ((path.split('?')[0] ?? '').endsWith('/members')) return json({ members });
    if (path.endsWith('/accounts')) return json({ accounts });
    if (path.endsWith('/invites') && method === 'GET') return json({ invites });
    if (path.endsWith('/domains')) return json({ domains });
    if (path.endsWith('/created-members') && method === 'GET') return json({ pending: setups });
    if (path.endsWith('/created-members') && method === 'POST') return json(createAnswer.body, createAnswer.status);
    if (path.endsWith('/setup-link')) return json({ pending: { ...setups[0], linkExpiresAt: '2026-01-20T00:00:00.000Z' } });
    if (path.endsWith('/invites') && method === 'POST') return json({ results: (body as { emails: string[]; kind: string }).emails.map((email) => ({ email, status: email.includes('@') ? 'sent' : 'invalid_email', kind: (body as { kind: string }).kind })) }, 201);
    if (path.endsWith('/agents/mine')) return json({ agents: [{ id: 'u-ada', accountId: 'a-ada', displayName: 'Ada', mode: 'personal', self: true }], limit: 5 });
    if (path.endsWith('/agents/personal')) return json({ agent: { id: 'u-pip', accountId: 'a-pip', displayName: 'Pip', mode: 'personal', self: false }, definition: { name: 'Pip', instructions: '', updatedAt: null } }, 201);
    if (path.endsWith('/agents/hosted')) return json({ agent: { id: 'u-scout', accountId: 'a-scout', displayName: 'Scout', mode: 'shared', self: false }, definition: { name: 'Scout', instructions: '', updatedAt: null } }, 201);
    if (path.includes('/assistant/avatar')) return json({ avatarUrl: '/x.png' });
    if (path.endsWith('/agent-invites')) return json({ code: 'flow-ABCD-EFGH', command: 'npx flow-agent-bridge flow-ABCD-EFGH', expiresAt: '2026-01-09T00:00:00.000Z' }, 201);
    if (path === '/v1/me/agent-connections') return json({ mcpUrl: 'https://app.test/mcp', agents: [] });
    if ((path.split('?')[0] ?? '').endsWith('/usage')) {
      const range = new URLSearchParams(path.split('?')[1]).get('range');
      const n = range === '1d' ? 24 : range === '30d' ? 30 : 7;
      const buckets = Array.from({ length: n }, (_, i) => ({ start: new Date(Date.UTC(2026, 10, 1 + i)).toISOString(), inputK: i === n - 1 ? 120.5 : 0, outputK: i === n - 1 ? 1.5 : 0, requests: i === n - 1 ? 3 : 0 }));
      return json({ range, bucket: range === '1d' ? 'hour' : 'day', buckets, total: { inputK: 120.5, outputK: 1.5, requests: 3 } });
    }
    if (path.endsWith('/provision')) return json(path.includes('/accounts/') ? { queued: true } : { queued: 2 });
    if (path.endsWith('/accounts/kind')) return json({ changed: 2, unchanged: 1 });
    return json({ ok: true });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Members org={org} />
    </QueryClientProvider>,
  );
};

describe('Members', () => {
  it('links each agent to its usage page: totals, a chart per token kind, the ranges, the table, and back', async () => {
    window.history.replaceState(null, '', '/admin/members');
    show();
    await screen.findByTestId('member-bob@example.com');
    expect(screen.queryByTestId('usage-bob@example.com')).toBeNull();
    fireEvent.click(screen.getByTestId('usage-agent-u-botty@agents.flow.local'));
    expect(window.location.pathname).toBe('/admin/members/u-botty/usage');
    await waitFor(() => expect(screen.getByTestId('usage-total-input').textContent).toContain('121K'));
    expect(screen.getByTestId('card-usage').textContent).toContain('Botty');
    expect(screen.getByTestId('usage-total-output').textContent).toContain('1.5K');
    expect(screen.getByTestId('usage-total-requests').textContent).toContain('3');
    expect(screen.getByTestId('usage-chart-input')).toBeTruthy();
    expect(screen.getByTestId('usage-chart-output')).toBeTruthy();
    expect(calls.some((c) => c.path.startsWith('/v1/workspaces/o1/agents/u-botty/usage?range=7d'))).toBe(true);
    fireEvent.focus(screen.getByTestId('usage-chart-input-bar-6'));
    expect(screen.getByTestId('usage-chart-input-tooltip').textContent).toContain('121K');
    fireEvent.click(screen.getByTestId('usage-range-1d'));
    await waitFor(() => expect(calls.some((c) => c.path.includes('/usage?range=1d'))).toBe(true));
    fireEvent.click(screen.getByTestId('usage-table-toggle'));
    await waitFor(() => expect(screen.getByTestId('usage-table').querySelectorAll('tbody tr')).toHaveLength(24));
    fireEvent.click(screen.getByTestId('usage-back'));
    await screen.findByTestId('member-bob@example.com');
    expect(window.location.pathname).toBe('/admin/members');
  });

  it('lists the roster owner first, one line each: the address here or a guest’s own email, role, kind and mail state', async () => {
    show();
    await screen.findByTestId('member-bob@example.com');
    const rows = [...document.querySelectorAll('tbody tr')].map((r) => r.getAttribute('data-testid'));
    expect(rows[0]).toBe('member-ann@example.com');
    expect(screen.getByTestId('address-cal@example.com').textContent).toBe('cal@example.com');
    expect(screen.getByTestId('address-bob@example.com').textContent).toBe('bob@acme.freeflow.im');
    expect(screen.queryByTestId('mail-bob@example.com')).toBeNull();
    expect(screen.queryByTestId('mail-cal@example.com')).toBeNull();
    expect(screen.getByTestId('mail-dee@example.com').textContent).toBe('stopped');
    expect(screen.getByTestId('mail-dee@example.com').getAttribute('title')).toBe('stopped: the provider refused: quota');
    // Agents: never the synthetic sign-in; a short kind, and the sponsor as a muted suffix.
    expect(document.body.textContent).not.toContain('agents.flow.local');
    expect(screen.getByTestId('address-agent-u-botty@agents.flow.local').textContent).toBe('botty@acme.freeflow.im');
    expect(screen.getByTestId('kind-agent-u-botty@agents.flow.local').textContent).toBe('External agent');
    expect(screen.getByTestId('sponsor-agent-u-botty@agents.flow.local').textContent).toBe('of Ann');
    expect(screen.getByTestId('kind-agent-u-hosty@agents.flow.local').textContent).toBe('Agent');
    expect(screen.getByTestId('sponsor-agent-u-hosty@agents.flow.local').textContent).toBe('of Bob');
    expect(screen.queryByTestId('add-member-modal')).toBeNull();
    // The owner and an agent are native with no choice; the owner cannot be removed; you cannot act on yourself.
    expect(screen.getByTestId('kind-ann@example.com').tagName).toBe('SPAN');
    expect(screen.getByTestId('kind-agent-u-botty@agents.flow.local').tagName).toBe('SPAN');
    expect(screen.getByTestId('kind-bob@example.com').tagName).toBe('SELECT');
    expect(screen.queryByTestId('remove-ann@example.com')).toBeNull();
    expect(screen.getByTestId('members-count').textContent).toBe('6 members');
  });

  it('filters: Guests shows the guest, Needs attention the stopped account, Agents the agent', async () => {
    show();
    await screen.findByTestId('member-bob@example.com');
    fireEvent.click(screen.getByTestId('filter-guests'));
    expect([...document.querySelectorAll('tbody tr')]).toHaveLength(1);
    expect(screen.getByTestId('member-cal@example.com')).toBeTruthy();
    fireEvent.click(screen.getByTestId('filter-attention'));
    expect(screen.getByTestId('member-dee@example.com')).toBeTruthy();
    expect(screen.queryByTestId('member-bob@example.com')).toBeNull();
    fireEvent.click(screen.getByTestId('filter-agents'));
    expect(screen.getByTestId('member-agent-u-botty@agents.flow.local')).toBeTruthy();
    expect(screen.queryByTestId('member-bob@example.com')).toBeNull();
  });

  it('changes a role and a kind with one call each, retries a stopped account, and removes after a confirmation', async () => {
    show();
    await screen.findByTestId('member-bob@example.com');
    fireEvent.change(screen.getByTestId('role-bob@example.com'), { target: { value: 'admin' } });
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.path === '/v1/workspaces/o1/members/u-bob/role')).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/role'))!.body).toEqual({ role: 'admin' });
    fireEvent.change(screen.getByTestId('kind-bob@example.com'), { target: { value: 'guest' } });
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.path === '/v1/workspaces/o1/accounts/a-bob/kind')).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/kind'))!.body).toEqual({ kind: 'guest' });
    fireEvent.click(screen.getByTestId('retry-dee@example.com'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/workspaces/o1/accounts/a-dee/provision')).toBe(true));
    fireEvent.click(screen.getByTestId('remove-bob@example.com'));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByTestId('remove-confirm-bob@example.com-yes'));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/v1/workspaces/o1/members/u-bob')).toBe(true));
  });

  it('invites people as members and, separately, as chat guests; only what failed stays in the box', async () => {
    show();
    await screen.findByTestId('member-bob@example.com');
    fireEvent.click(screen.getByTestId('add-member'));
    fireEvent.click(screen.getByTestId('add-mode-guest'));
    fireEvent.change(screen.getByTestId('invite-emails'), { target: { value: 'fay@example.com, not-an-address' } });
    fireEvent.click(screen.getByTestId('invite-guests'));
    await screen.findByTestId('invite-results');
    const post = calls.find((c) => c.method === 'POST' && c.path === '/v1/workspaces/o1/invites')!;
    expect(post.body).toEqual({ emails: ['fay@example.com', 'not-an-address'], kind: 'guest' });
    expect(screen.getByTestId('invite-results').textContent).toContain('invited as a chat guest');
    expect(screen.getByTestId('invite-results').textContent).toContain('not an email address');
    expect((screen.getByTestId('invite-emails') as HTMLTextAreaElement).value).toBe('not-an-address');
    expect(document.body.textContent).toContain('Chat guests use Chat only.');
    fireEvent.click(screen.getByTestId('add-mode-invite'));
    fireEvent.change(screen.getByTestId('invite-emails'), { target: { value: 'gil@example.com' } });
    fireEvent.click(screen.getByTestId('invite-people'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/invites'))).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/invites'))[1]!.body).toEqual({ emails: ['gil@example.com'], kind: 'native' });
  });

  it('creates a member at username@domain on the primary verified domain, the username suggested from the name', async () => {
    show();
    fireEvent.click(await screen.findByTestId('add-member'));
    await waitFor(() => expect((screen.getByTestId('create-domain') as HTMLSelectElement).value).toBe('acme.com'));
    expect([...(screen.getByTestId('create-domain') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['acme.com', 'acme.freeflow.im']);
    fireEvent.change(screen.getByTestId('create-name'), { target: { value: 'Bea Lin' } });
    expect((screen.getByTestId('create-username') as HTMLInputElement).value).toBe('bea.lin');
    expect(screen.getByTestId('create-preview').textContent).toContain('bea.lin@acme.com');
    fireEvent.change(screen.getByTestId('create-domain'), { target: { value: 'acme.freeflow.im' } });
    expect(screen.getByTestId('create-preview').textContent).toContain('bea.lin@acme.freeflow.im');
    fireEvent.change(screen.getByTestId('create-domain'), { target: { value: 'acme.com' } });
    expect((screen.getByTestId('create-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('create-backup'), { target: { value: 'bea@gmail.example' } });
    fireEvent.click(screen.getByTestId('create-submit'));
    expect((await screen.findByTestId('add-done')).textContent).toBe('Created bea.lin@acme.com. A setup link went to bea@gmail.example.');
    expect(calls.find((c) => c.method === 'POST' && c.path === '/v1/workspaces/o1/created-members')!.body).toEqual({ displayName: 'Bea Lin', username: 'bea.lin', domain: 'acme.com', backupEmail: 'bea@gmail.example' });
    // The dialog closes and the roster is read again, so the new member shows at once.
    expect(screen.queryByTestId('add-member-modal')).toBeNull();
    expect(calls.filter((c) => (c.path.split('?')[0] ?? '').endsWith('/members')).length).toBeGreaterThan(1);
  });

  it('shows the server\'s refusal and keeps what was typed', async () => {
    createAnswer = { status: 409, body: { error: { code: 'username_taken', message: 'bea@acme.com is already taken.' } } };
    show();
    fireEvent.click(await screen.findByTestId('add-member'));
    await waitFor(() => expect((screen.getByTestId('create-domain') as HTMLSelectElement).value).toBe('acme.com'));
    fireEvent.change(screen.getByTestId('create-name'), { target: { value: 'Bea' } });
    fireEvent.change(screen.getByTestId('create-username'), { target: { value: 'Bea' } });
    fireEvent.change(screen.getByTestId('create-backup'), { target: { value: 'bea@gmail.example' } });
    fireEvent.click(screen.getByTestId('create-submit'));
    expect((await screen.findByTestId('create-error')).textContent).toContain('already taken');
    expect((screen.getByTestId('create-username') as HTMLInputElement).value).toBe('bea');
  });

  it('lists created members waiting to set a password, and resends a setup link', async () => {
    show();
    const row = await screen.findByTestId('setup-hal@acme.com');
    expect(row.textContent).toContain('hal@gmail.example');
    expect(row.textContent).toContain('link expired');
    fireEvent.click(screen.getByTestId('resend-hal@acme.com'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/workspaces/o1/created-members/a-hal/setup-link')).toBe(true));
    expect((await screen.findByText('sent again'))).toBeTruthy();
  });

  it('makes a native agent with its picture, which shows in the roster', async () => {
    show();
    fireEvent.click(await screen.findByTestId('add-member'));
    fireEvent.click(screen.getByTestId('add-kind-agent'));
    fireEvent.change(screen.getByTestId('agent-name'), { target: { value: 'Scout Bot' } });
    await waitFor(() => expect(screen.getByTestId('agent-preview').textContent).toContain('scout.bot@acme.com'));
    fireEvent.change(screen.getByTestId('agent-picture-file'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    fireEvent.click(screen.getByTestId('agent-submit'));
    expect((await screen.findByTestId('add-done')).textContent).toContain('Created Scout.');
    expect(calls.find((c) => c.method === 'POST' && c.path === '/v1/workspaces/o1/agents/hosted')!.body).toEqual({ name: 'Scout Bot' });
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/workspaces/o1/assistant/avatar?agent=u-scout')).toBe(true);
    expect(calls.some((c) => c.path.endsWith('/agent-invites'))).toBe(false);
  });

  it('a hosted agent is shared by default; Private makes the admin’s own private agent, with no address', async () => {
    show();
    fireEvent.click(await screen.findByTestId('add-member'));
    fireEvent.click(screen.getByTestId('add-kind-agent'));
    expect(screen.getByTestId('agent-shared').getAttribute('aria-checked')).toBe('true');
    fireEvent.change(screen.getByTestId('agent-name'), { target: { value: 'Pip' } });
    fireEvent.click(screen.getByTestId('agent-private'));
    expect(screen.getByTestId('agent-preview').textContent).toContain('No address');
    expect(await screen.findByText(/You have 1 of 5/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('agent-submit'));
    expect((await screen.findByTestId('add-done')).textContent).toContain('Only you can ask it');
    expect(calls.find((c) => c.method === 'POST' && c.path === '/v1/workspaces/o1/agents/personal')!.body).toEqual({ name: 'Pip' });
    expect(calls.some((c) => c.path.endsWith('/agents/hosted'))).toBe(false);
  });

  it('an external agent (Hosted unchecked): a one-time code, then its connection steps with the name it joins as', async () => {
    show();
    fireEvent.click(await screen.findByTestId('add-member'));
    fireEvent.click(screen.getByTestId('add-kind-agent'));
    fireEvent.change(screen.getByTestId('agent-name'), { target: { value: "Bob's Builder" } });
    fireEvent.click(screen.getByTestId('agent-hosted'));
    expect(screen.queryByTestId('agent-private')).toBeNull();
    expect(screen.queryByTestId('agent-picture-file')).toBeNull();
    fireEvent.click(screen.getByTestId('agent-submit'));
    const command = await screen.findByTestId('connect-command');
    expect(command.textContent).toBe("npx flow-agent-bridge flow-ABCD-EFGH --name 'Bob'\\''s Builder' --handle bob-s-builder");
    expect(calls.some((c) => c.path.endsWith('/agents/hosted'))).toBe(false);
    fireEvent.click(screen.getByTestId('connect-tab-mcp'));
    expect((await screen.findByTestId('connect-url')).textContent).toBe('https://app.test/mcp');
    expect(screen.getByTestId('connect-prompt').textContent).toContain('claude mcp add --transport http freeflow https://app.test/mcp');
    fireEvent.click(screen.getByTestId('connect-done'));
    expect(screen.queryByTestId('connect-agent-modal')).toBeNull();
  });

  it('Create inbox: an agent with no mailbox gets one through the provision route; a person’s assistant has none to make', async () => {
    show();
    const btn = await screen.findByTestId('create-inbox-agent-u-hosty@agents.flow.local');
    expect(screen.queryByTestId('create-inbox-agent-u-botty@agents.flow.local')).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/workspaces/o1/accounts/a-hosty/provision')).toBe(true));
    expect((await screen.findByTestId('mail-agent-u-hosty@agents.flow.local')).textContent).toBe('setting up…');
    expect(screen.queryByTestId('create-inbox-agent-u-hosty@agents.flow.local')).toBeNull();
  });

  it('a person’s assistant has no address and shows No inbox, with nothing for an admin to make', async () => {
    members.push(member('Ada', { isAgent: true, kind: 'personal_agent', agentRuntime: 'hosted', email: 'agent-u-ada@agents.flow.local', sponsorId: 'u-bob' }));
    accounts.push(account('Ada', { kind: 'personal_agent', address: null, hosted: false, agentRuntime: 'hosted', sponsorId: 'u-bob' }));
    show();
    const key = 'agent-u-ada@agents.flow.local';
    expect((await screen.findByTestId(`address-${key}`)).textContent).toBe('No inbox');
    expect(screen.queryByTestId(`create-inbox-${key}`)).toBeNull();
    expect(screen.getByTestId(`kind-${key}`).textContent).toBe('Private agent');
    expect(screen.getByTestId(`sponsor-${key}`).textContent).toBe('of Bob');
    expect(screen.queryByTestId(`remove-${key}`)).toBeNull();
  });

  it('suggests a username from a display name', () => {
    expect(suggestUsername('Bea Lin')).toBe('bea.lin');
    expect(suggestUsername("José O'Brien")).toBe('jose.obrien');
    expect(suggestUsername('  ')).toBe('');
  });

  it('lists pending invitations with their kind and inviter, and revokes one after a confirmation', async () => {
    show();
    const row = await screen.findByTestId('invite-eve@example.com');
    expect(row.textContent).toContain('chat guest');
    expect(row.textContent).toContain('by Ann');
    fireEvent.click(screen.getByTestId('revoke-eve@example.com'));
    fireEvent.click(screen.getByTestId('revoke-confirm-eve@example.com-yes'));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/v1/workspaces/o1/invites/i1')).toBe(true));
  });

  it('runs the bulk actions: mailboxes for everyone, and every member a guest after a confirmation', async () => {
    show();
    await screen.findByTestId('provision-all');
    expect(screen.getByTestId('provision-count').textContent).toBe('5 native accounts; guests get none');
    fireEvent.click(screen.getByTestId('provision-all'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/workspaces/o1/provision')).toBe(true));
    expect((await screen.findByText('Setting up 2 mailboxes.'))).toBeTruthy();
    fireEvent.click(screen.getByTestId('guests-all'));
    fireEvent.click(screen.getByTestId('guests-confirm-yes'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/workspaces/o1/accounts/kind')).toBe(true));
    expect((await screen.findByText('2 members are now guests.'))).toBeTruthy();
  });

  it('hides the Mail column and the mailbox action when hosted mail is off', async () => {
    hostedMail = false;
    show();
    await screen.findByTestId('member-bob@example.com');
    expect(screen.queryByTestId('mail-bob@example.com')).toBeNull();
    expect(screen.queryByTestId('provision-all')).toBeNull();
  });
});

describe('labels', () => {
  it('names each kind shortly, and hides synthetic addresses', () => {
    expect(kindLabel(member('A'), account('A'))).toBe('Person');
    expect(kindLabel(member('A', { kind: 'guest' }), account('A', { kind: 'guest' }))).toBe('Guest');
    expect(kindLabel(member('A', { isAgent: true }), account('A', { agentRuntime: 'hosted' }))).toBe('Agent');
    expect(kindLabel(member('A', { isAgent: true }), account('A'))).toBe('External agent');
    expect(kindLabel(member('A', { isAgent: true, kind: 'personal_agent', agentRuntime: 'hosted' }), undefined)).toBe('Private agent');
    expect(kindLabel(member('A', { isAgent: true, kind: 'personal_agent' }), undefined)).toBe('Personal agent');
    expect(visibleEmail('agent-01a1@agents.flow.local')).toBeNull();
    expect(visibleEmail('u1@hidden.invalid')).toBeNull();
    expect(visibleEmail('bea@example.com')).toBe('bea@example.com');
    expect(agentHandle('Scout Bot')).toBe('scout-bot');
    expect(addressLocal(agentHandle('Scout Bot'))).toBe('scout.bot');
    expect(bridgeCommand({ code: 'c', command: 'npx flow-agent-bridge c', expiresAt: '' }, 'Scout')).toBe('npx flow-agent-bridge c --name Scout --handle scout');
  });
});

describe('mailState', () => {
  const a = (extra: Partial<AccountDTO>) => account('X', extra);
  it('maps an account’s state to the Mail column', () => {
    expect(mailState(a({}), true)).toEqual({ text: 'ready', tone: 'ok', retry: false });
    expect(mailState(a({ kind: 'guest', address: null }), true)).toEqual({ text: '—', tone: 'muted', retry: false });
    expect(mailState(a({ state: 'mailbox_ready', hosted: true }), true)).toEqual({ text: 'being set up', tone: 'muted', retry: false });
    expect(mailState(a({ statusMessage: 'refused' }), true)).toEqual({ text: 'stopped: refused', tone: 'warn', retry: true });
    expect(mailState(a({ hosted: false }), true)).toEqual({ text: 'no mailbox yet', tone: 'muted', retry: true });
    expect(mailState(a({ state: 'suspended' }), true)).toEqual({ text: 'suspended', tone: 'muted', retry: false });
    // A person where people get no hosted address (platform.md §3.2): their linked mailbox, or none; nothing to retry.
    expect(mailState(a({ address: null, hosted: false, linkedAddress: 'x@gmail.example' }), true)).toEqual({ text: 'linked', tone: 'muted', retry: false });
    expect(mailState(a({ address: null, hosted: false }), true)).toEqual({ text: 'none', tone: 'muted', retry: false });
    expect(mailState(a({}), false)).toBeNull();
    expect(mailState(undefined, true)).toBeNull();
  });
});
