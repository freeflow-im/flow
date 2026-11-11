// Members (docs/specs/workspace-admin.md §3.2, §5), against a fetch that answers the suite's API: the roster with roles,
// kinds and mail state, the filters, Retry setup, the bulk actions, inviting people and chat guests, pending invitations.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDTO, WorkspaceDTO, WorkspaceInviteDTO, WorkspaceMemberDTO } from '@flow/shared';
import { mailState, Members } from './Members';

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

beforeEach(() => {
  calls = [];
  hostedMail = true;
  members = [member('Ann', { role: 'owner' }), member('Bob'), member('Cal'), member('Dee'), member('Botty', { isAgent: true })];
  accounts = [
    account('Ann', { role: 'owner' }),
    account('Bob'),
    account('Cal', { kind: 'guest', address: null, hosted: false }),
    account('Dee', { state: 'requested', hosted: false, statusMessage: 'the provider refused: quota' }),
    account('Botty'),
  ];
  invites = [{ id: 'i1', email: 'eve@example.com', kind: 'guest', invitedBy: { id: 'u-ann', displayName: 'Ann' }, createdAt: '2026-01-02T00:00:00.000Z', expiresAt: '2026-01-09T00:00:00.000Z' }];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/v1/config') return json({ google: false, googleClientId: null, apple: false, maxFileBytes: 1, hostedMail });
    if (path === '/v1/me') return json({ id: 'u-ann', email: 'ann@example.com', displayName: 'Ann', avatarUrl: null, statusEmoji: '', statusText: '' });
    if (path.split('?')[0].endsWith('/members')) return json({ members });
    if (path.endsWith('/accounts')) return json({ accounts });
    if (path.endsWith('/invites') && method === 'GET') return json({ invites });
    if (path.endsWith('/invites') && method === 'POST') return json({ results: (body as { emails: string[]; kind: string }).emails.map((email) => ({ email, status: email.includes('@') ? 'sent' : 'invalid_email', kind: (body as { kind: string }).kind })) }, 201);
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
  it('lists the roster owner first, with each member’s address or "guest", role, kind and mail state', async () => {
    show();
    await screen.findByTestId('member-bob@example.com');
    const rows = [...document.querySelectorAll('tbody tr')].map((r) => r.getAttribute('data-testid'));
    expect(rows[0]).toBe('member-ann@example.com');
    expect(screen.getByTestId('address-cal@example.com').textContent).toBe('guest');
    expect(screen.getByTestId('address-bob@example.com').textContent).toBe('bob@acme.freeflow.im');
    expect(screen.getByTestId('mail-bob@example.com').textContent).toBe('ready');
    expect(screen.getByTestId('mail-cal@example.com').textContent).toBe('—');
    expect(screen.getByTestId('mail-dee@example.com').textContent).toBe('stopped: the provider refused: quota');
    // The owner and an agent are native with no choice; the owner cannot be removed; you cannot act on yourself.
    expect(screen.getByTestId('kind-ann@example.com').tagName).toBe('SPAN');
    expect(screen.getByTestId('kind-botty@example.com').tagName).toBe('SPAN');
    expect(screen.getByTestId('kind-bob@example.com').tagName).toBe('SELECT');
    expect(screen.queryByTestId('remove-ann@example.com')).toBeNull();
    expect(screen.getByTestId('members-count').textContent).toBe('5 members');
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
    expect(screen.getByTestId('member-botty@example.com')).toBeTruthy();
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
    fireEvent.change(screen.getByTestId('invite-emails'), { target: { value: 'fay@example.com, not-an-address' } });
    fireEvent.click(screen.getByTestId('invite-guests'));
    await screen.findByTestId('invite-results');
    const post = calls.find((c) => c.method === 'POST' && c.path === '/v1/workspaces/o1/invites')!;
    expect(post.body).toEqual({ emails: ['fay@example.com', 'not-an-address'], kind: 'guest' });
    expect(screen.getByTestId('invite-results').textContent).toContain('invited as a chat guest');
    expect(screen.getByTestId('invite-results').textContent).toContain('not an email address');
    expect((screen.getByTestId('invite-emails') as HTMLTextAreaElement).value).toBe('not-an-address');
    expect(document.body.textContent).toContain('Guests use Chat only.');
    fireEvent.change(screen.getByTestId('invite-emails'), { target: { value: 'gil@example.com' } });
    fireEvent.click(screen.getByTestId('invite-people'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/invites'))).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/invites'))[1]!.body).toEqual({ emails: ['gil@example.com'], kind: 'native' });
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
    expect(screen.getByTestId('provision-count').textContent).toBe('4 native accounts; guests get none');
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

describe('mailState', () => {
  const a = (extra: Partial<AccountDTO>) => account('X', extra);
  it('maps an account’s state to the Mail column', () => {
    expect(mailState(a({}), true)).toEqual({ text: 'ready', tone: 'ok', retry: false });
    expect(mailState(a({ kind: 'guest', address: null }), true)).toEqual({ text: '—', tone: 'muted', retry: false });
    expect(mailState(a({ state: 'mailbox_ready', hosted: true }), true)).toEqual({ text: 'being set up', tone: 'muted', retry: false });
    expect(mailState(a({ statusMessage: 'refused' }), true)).toEqual({ text: 'stopped: refused', tone: 'warn', retry: true });
    expect(mailState(a({ hosted: false }), true)).toEqual({ text: 'no mailbox yet', tone: 'muted', retry: true });
    expect(mailState(a({ state: 'suspended' }), true)).toEqual({ text: 'suspended', tone: 'muted', retry: false });
    expect(mailState(a({}), false)).toBeNull();
    expect(mailState(undefined, true)).toBeNull();
  });
});
