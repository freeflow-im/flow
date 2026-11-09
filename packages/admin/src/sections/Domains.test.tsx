// Domains & mail (docs/specs/workspace-admin.md §4), against a fetch that answers the suite's API: the platform card,
// an own domain's five steps, Turn on mail and when it is allowed, the refusals in the admin's words, add, primary,
// remove, and the Mail card's counts.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDTO, DomainDTO, WorkspaceDTO } from '@flow/shared';
import { Domains } from './Domains';

const org: WorkspaceDTO = {
  id: 'o1', slug: 'acme', name: 'Acme', createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z', sidebarColor: 'violet', avatarUrl: null, googleSelfRegisterDomain: null, role: 'owner',
};
const platform: DomainDTO = {
  domain: 'acme.freeflow.im', kind: 'platform', verified: true, primary: true, atProvider: false, createdAt: '2026-01-01T00:00:00.000Z',
  records: [{ type: 'MX', name: 'acme.freeflow.im', value: 'mx.fake-mail.test', priority: 10, purpose: 'mx' }],
  status: [],
};
const own = (extra: Partial<DomainDTO> = {}, present: Record<string, boolean> = {}): DomainDTO => {
  const records: DomainDTO['records'] = [
    { type: 'TXT', name: '_freeflow.acme.test', value: 'freeflow-verify=abc', purpose: 'verification' },
    { type: 'TXT', name: '_da-verify-123.acme.test', value: 'domain-verified', purpose: 'provider' },
    { type: 'MX', name: 'acme.test', value: 'mx.fake-mail.test', priority: 10, purpose: 'mx' },
    { type: 'TXT', name: 'acme.test', value: 'v=spf1 include:_spf.fake-mail.test ~all', purpose: 'spf' },
    { type: 'TXT', name: '_dmarc.acme.test', value: 'v=DMARC1; p=none', purpose: 'dmarc' },
    ...(extra.atProvider ? [{ type: 'TXT' as const, name: 'x._domainkey.acme.test', value: 'v=DKIM1; k=rsa; p=abc', purpose: 'dkim' as const }] : []),
  ];
  return {
    domain: 'acme.test', kind: 'own', verified: false, primary: false, atProvider: false, createdAt: '2026-01-02T00:00:00.000Z',
    records,
    status: records.map((r) => ({ record: present[r.purpose] ? 'present' : 'missing' })),
    ...extra,
  };
};
const account = (extra: Partial<AccountDTO>): AccountDTO => ({ id: 'a', principalId: 'u', organizationId: 'o1', address: 'x@acme.test', displayName: 'X', role: 'member', kind: 'native', state: 'active', hosted: true, createdAt: '', ...extra });

let calls: { method: string; path: string; body: unknown }[];
let domains: DomainDTO[];
let accounts: AccountDTO[];
let refuse: { method: string; status: number; code: string; message: string } | null;

beforeEach(() => {
  calls = [];
  domains = [platform];
  accounts = [];
  refuse = null;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (refuse && refuse.method === method) return json({ error: { code: refuse.code, message: refuse.message } }, refuse.status);
    if (path === '/v1/config') return json({ google: false, googleClientId: null, apple: false, maxFileBytes: 1, hostedMail: true, mail: { imapHost: 'mail.fake-mail.test', smtpHost: 'mail.fake-mail.test' } });
    if (path.endsWith('/accounts')) return json({ accounts });
    if (path.endsWith('/verify')) return json({ verified: false, found: [] });
    if (path.endsWith('/dkim')) return json({ domain: 'acme.test', kind: 'own', selector: 'x', record: { type: 'TXT', name: 'x._domainkey.acme.test', value: 'v=DKIM1; k=rsa; p=abc', purpose: 'dkim' } });
    if (path.startsWith('/v1/workspaces/o1/domains')) return method === 'GET' ? json({ domains }) : json(method === 'POST' ? domains[1] ?? platform : { ok: true });
    return json({});
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
      <Domains org={org} />
    </QueryClientProvider>,
  );
};
const card = (id: string) => within(screen.getByTestId(`domain-${id}`));
const stepState = (id: string, n: number) => screen.getByTestId(`step-${n}-${id}`).getAttribute('data-state');

describe('Domains & mail', () => {
  it('shows the platform domain as managed, primary, with its records published and Turn on mail until it is at the provider', async () => {
    show();
    await screen.findByTestId('domain-acme-freeflow-im');
    const c = card('acme-freeflow-im');
    expect(c.getByTestId('domain-turn-on-acme-freeflow-im')).toBeTruthy();
    expect(c.getByTestId('domain-primary-acme-freeflow-im')).toBeTruthy();
    expect(c.queryByTestId('domain-remove-acme-freeflow-im')).toBeNull();
    expect(c.queryByTestId('domain-steps-acme-freeflow-im')).toBeNull();
    fireEvent.click(c.getByTestId('records-show'));
    expect(c.getAllByTestId('domain-record-status').map((s) => s.textContent)).toEqual(['published']);
  });

  it('walks an own domain through its steps: ownership first, Verify, and Turn on mail only once the provider’s record is in DNS', async () => {
    domains = [platform, own()];
    show();
    const id = 'acme-test';
    await screen.findByTestId(`domain-steps-${id}`);
    expect(stepState(id, 1)).toBe('done');
    expect(stepState(id, 2)).toBe('current');
    expect(stepState(id, 3)).toBe('later');
    expect(screen.getByTestId(`domain-status-${id}`).textContent).toBe('not verified');
    fireEvent.click(screen.getByTestId(`domain-verify-${id}`));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/workspaces/o1/domains/acme.test/verify')).toBe(true));
    expect((await screen.findByTestId(`domain-note-${id}`)).textContent).toContain('not found yet');

    // Verified, the mail records still missing: step 3 is current, step 4 waits (no Turn on mail yet).
    domains = [platform, own({ verified: true }, { verification: true })];
    fireEvent.click(screen.getByTestId(`domain-recheck-${id}`));
    await waitFor(() => expect(stepState(id, 3)).toBe('current'));
    expect(calls.some((c) => c.path === '/v1/workspaces/o1/domains?refresh=1')).toBe(true);
    expect(screen.getByTestId(`domain-recheck-${id}`).textContent).toBe('Checked just now');
    expect(stepState(id, 4)).toBe('later');
    expect(screen.queryByTestId(`domain-turn-on-${id}`)).toBeNull();
    expect(screen.getByTestId(`domain-status-${id}`).textContent).toBe('verified');
  });

  it('turns mail on once the records are there, then asks for the signing record and reports mail ready', async () => {
    domains = [platform, own({ verified: true }, { verification: true, provider: true, mx: true, spf: true, dmarc: true })];
    show();
    const id = 'acme-test';
    await screen.findByTestId(`domain-steps-${id}`);
    expect(stepState(id, 3)).toBe('done');
    expect(stepState(id, 4)).toBe('current');
    const turnOn = screen.getByTestId(`domain-turn-on-${id}`) as HTMLButtonElement;
    expect(turnOn.disabled).toBe(false);
    domains = [platform, own({ verified: true, atProvider: true }, { verification: true, provider: true, mx: true, spf: true, dmarc: true })];
    fireEvent.click(turnOn);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/workspaces/o1/domains/acme.test/dkim')).toBe(true));
    await waitFor(() => expect(stepState(id, 4)).toBe('done'));
    expect(stepState(id, 5)).toBe('current');
    expect(screen.getAllByTestId('domain-record').some((r) => r.textContent?.includes('x._domainkey.acme.test'))).toBe(true);

    domains = [platform, own({ verified: true, atProvider: true }, { verification: true, provider: true, mx: true, spf: true, dmarc: true, dkim: true })];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.advanceTimersByTime(6_000);
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByTestId(`domain-recheck-${id}`).textContent).toBe('Check again'));
    fireEvent.click(screen.getByTestId(`domain-recheck-${id}`));
    await waitFor(() => expect(screen.getByTestId(`domain-status-${id}`).textContent).toBe('mail ready'));
    expect(screen.getByTestId(`domain-make-primary-${id}`)).toBeTruthy();
  });

  it('says what a pending provider means, in the admin’s words', async () => {
    domains = [platform, own({ verified: true }, { verification: true, provider: true, mx: true, spf: true, dmarc: true })];
    refuse = { method: 'POST', status: 409, code: 'mail_provider_pending', message: 'TXT _da-verify… is not in DNS yet' };
    show();
    fireEvent.click(await screen.findByTestId('domain-turn-on-acme-test'));
    expect((await screen.findByTestId('domain-error-acme-test')).textContent).toContain('cannot see its ownership record yet');
  });

  it('adds a domain, makes a verified one primary, and removes after a confirmation; a refusal is shown', async () => {
    domains = [platform];
    show();
    await screen.findByTestId('domain-acme-freeflow-im');
    fireEvent.change(screen.getByTestId('domain-add-input'), { target: { value: 'acme.test' } });
    domains = [platform, own({ verified: true }, { verification: true })];
    fireEvent.click(screen.getByTestId('domain-add'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/workspaces/o1/domains' && (c.body as { domain: string }).domain === 'acme.test')).toBe(true));
    await screen.findByTestId('domain-acme-test');
    fireEvent.click(screen.getByTestId('domain-make-primary-acme-test'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.path === '/v1/workspaces/o1/domains/acme.test')).toBe(true));
    fireEvent.click(screen.getByTestId('domain-remove-acme-test'));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    refuse = { method: 'DELETE', status: 409, code: 'domain_in_use', message: 'accounts have addresses on this domain' };
    fireEvent.click(screen.getByTestId('domain-remove-confirm-acme-test-yes'));
    expect((await screen.findByTestId('domain-error-acme-test')).textContent).toBe('accounts have addresses on this domain');
  });

  it('counts the native accounts’ mailboxes on the Mail card and names the provider’s hosts', async () => {
    accounts = [
      account({ id: '1' }),
      account({ id: '2', state: 'mailbox_ready', hosted: true }),
      account({ id: '3', state: 'requested', hosted: false, statusMessage: 'the provider refused' }),
      account({ id: '4', kind: 'guest', address: null, hosted: false }),
      account({ id: '5', state: 'suspended' }),
    ];
    show();
    const counts = await screen.findByTestId('mail-counts');
    expect(counts.textContent).toContain('Native accounts3');
    expect(counts.textContent).toContain('Mailboxes ready1');
    expect(counts.textContent).toContain('Being set up1');
    expect(counts.textContent).toContain('Stopped1');
    expect(screen.getByTestId('mail-provider').textContent).toContain('mail.fake-mail.test');
    expect(screen.getByTestId('mail-provider').textContent).toContain('acme.freeflow.im');
  });
});
