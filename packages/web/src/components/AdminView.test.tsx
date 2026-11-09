import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AccountDTO, WorkspaceDTO, WorkspaceMemberDTO } from '@flow/shared';

vi.mock('../lib/useBoundApi', () => ({ useBoundApi: () => ({ api: async () => ({}) }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: async () => {} }) }));

import { MemberRow, OrganizationSection } from './AdminView';

const member = (name: string, extra: Partial<WorkspaceMemberDTO> = {}): WorkspaceMemberDTO => ({
  userId: `u-${name}`, displayName: name, email: `${name.toLowerCase()}@example.com`, avatarUrl: null, statusEmoji: '',
  statusText: '', title: '', isAgent: false, isBot: false, sponsorId: null, privacyMode: false, role: 'member',
  joinedAt: '2026-11-01T00:00:00.000Z', ...extra,
});
const ws = (extra: Partial<WorkspaceDTO> = {}): WorkspaceDTO => ({
  id: 'w1', slug: 'acme', name: 'Acme', createdBy: 'u-Ann', createdAt: '', sidebarColor: 'violet', avatarUrl: null,
  googleSelfRegisterDomain: null, role: 'owner', ...extra,
});
const roster = [member('Ann', { role: 'owner' }), member('Bob'), member('Botty', { isAgent: true })];
const account = (name: string, extra: Partial<AccountDTO> = {}): AccountDTO => ({
  id: `a-${name}`, principalId: `u-${name}`, organizationId: 'w1', address: `${name.toLowerCase()}@acme.freeflow.im`, displayName: name,
  role: 'member', kind: 'native', state: 'active', createdAt: '', ...extra,
});
const accounts = [account('Ann', { role: 'owner' }), account('Bob'), account('Cal', { kind: 'guest', address: null }), account('Dee', { role: 'admin' })];

describe('OrganizationSection', () => {
  it('names the owner, shows the policies with their defaults, and offers the owner a transfer to people only', () => {
    const html = renderToStaticMarkup(<OrganizationSection ws={ws()} roster={roster} meId="u-Ann" />);
    expect(html).toContain('admin-owner');
    expect(html).toMatch(/admin-owner[^>]*>Ann</);
    expect(html).toContain('admin-policy-invite');
    expect(html).toContain('admin-policy-agents');
    expect(html).toMatch(/admin-policy-links[^>]*checked/);
    expect(html).toContain('admin-transfer-select');
    expect(html).toContain('>Bob</option>');
    expect(html).not.toContain('>Botty</option>');
    expect(html).not.toContain('>Ann</option>');
  });

  it('reflects stored policies, and shows an admin no transfer', () => {
    const html = renderToStaticMarkup(
      <OrganizationSection ws={ws({ role: 'admin', policies: { inviteBy: 'admins', agentsBy: 'members', linkSharing: false } })} roster={roster} meId="u-Bob" />,
    );
    expect(html).not.toMatch(/admin-policy-links[^>]*checked/);
    expect(html).toMatch(/<option value="admins" selected/);
    expect(html).not.toContain('admin-transfer-select');
  });

  it('has no "new members join as" setting (joiners are native, decision_log 2026-11-09), and offers to make every member a guest', () => {
    const html = renderToStaticMarkup(
      <OrganizationSection ws={ws({ policies: { inviteBy: 'admins', agentsBy: 'members', linkSharing: true } })} roster={roster} meId="u-Ann" />,
    );
    expect(html).not.toContain('admin-policy-kind');
    expect(html).toMatch(/admin-guests[^>]*>Make every member a guest</);
    expect(html).not.toContain('admin-guests-confirm');
  });

  it('says how many native accounts "set up mailboxes for everyone" covers', () => {
    const html = renderToStaticMarkup(<OrganizationSection ws={ws()} roster={roster} meId="u-Ann" hostedMail accounts={accounts} />);
    expect(html).toMatch(/admin-provision-count[^>]*>3 native accounts; guests get none</);
    expect(renderToStaticMarkup(<OrganizationSection ws={ws()} roster={roster} meId="u-Ann" hostedMail />)).not.toContain('admin-provision-count');
  });

  it('offers to set up mailboxes for everyone only when a mail provider is configured', () => {
    expect(renderToStaticMarkup(<OrganizationSection ws={ws()} roster={roster} meId="u-Ann" />)).not.toContain('admin-provision');
    const html = renderToStaticMarkup(<OrganizationSection ws={ws()} roster={roster} meId="u-Ann" hostedMail />);
    expect(html).toMatch(/admin-provision[^>]*>Set up mailboxes for everyone</);
  });
});

describe('MemberRow', () => {
  const row = (m: WorkspaceMemberDTO, a?: AccountDTO) =>
    renderToStaticMarkup(<table><tbody><MemberRow member={m} meId="u-Ann" workspaceId="w1" account={a} /></tbody></table>);

  it('shows a native member\'s address and a Native/Guest choice', () => {
    const html = row(member('Bob'), account('Bob'));
    expect(html).toMatch(/admin-address-bob@example.com[^>]*>bob@acme.freeflow.im</);
    expect(html).toMatch(/<select data-testid="admin-kind-bob@example.com"/);
    expect(html).toMatch(/<option value="native" selected/);
  });

  it('shows "guest" where a guest\'s address would be', () => {
    const html = row(member('Cal'), account('Cal', { kind: 'guest', address: null }));
    expect(html).toMatch(/admin-address-cal@example.com[^>]*>guest</);
    expect(html).toMatch(/<option value="guest" selected/);
  });

  it('keeps the owner native, with no choice', () => {
    const html = row(member('Ann', { role: 'owner' }), account('Ann', { role: 'owner' }));
    expect(html).toMatch(/admin-kind-ann@example.com[^>]*>Native</);
    expect(html).not.toContain('<select data-testid="admin-kind-');
  });

  it('shows no kind before the accounts load', () => {
    const html = row(member('Bob'));
    expect(html).not.toContain('admin-kind-');
    expect(html).not.toContain('admin-address-');
  });
});
