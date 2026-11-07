import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceDTO, WorkspaceMemberDTO } from '@flow/shared';

vi.mock('../lib/useBoundApi', () => ({ useBoundApi: () => ({ api: async () => ({}) }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: async () => {} }) }));

import { OrganizationSection } from './AdminView';

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

  it('offers to set up mailboxes for everyone only when a mail provider is configured', () => {
    expect(renderToStaticMarkup(<OrganizationSection ws={ws()} roster={roster} meId="u-Ann" />)).not.toContain('admin-provision');
    const html = renderToStaticMarkup(<OrganizationSection ws={ws()} roster={roster} meId="u-Ann" hostedMail />);
    expect(html).toMatch(/admin-provision[^>]*>Set up mailboxes for everyone</);
  });
});
