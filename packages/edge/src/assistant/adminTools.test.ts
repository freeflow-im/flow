// The admin agent's tools (agents.md §1.4): each calls the Admin app's own /v1 route, a change that takes something away
// waits for the admin's yes, and they are offered only in the admin agent's turns.
import { describe, expect, it } from 'vitest';
import { ADMIN_TOOLS, AdminToolError, adminToolDefinitions, runAdminTool, validateAdminTool, type AdminToolContext } from './adminTools';
import { suiteTools, validateSuiteTool } from '../docs/assistantTools';

function fakeContext(answer: unknown = { ok: true }) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const ctx: AdminToolContext = {
    organizationId: 'org-1',
    call: async (method, path, body) => {
      calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
      return answer;
    },
  };
  return { ctx, calls };
}

describe('the admin tools', () => {
  it('call the routes the Admin app calls, as the asking admin', async () => {
    const { ctx, calls } = fakeContext();
    await runAdminTool('admin_invite', { emails: ['a@x.test'] }, ctx);
    await runAdminTool('admin_update_organization', { policies: { inviteBy: 'admins' } }, ctx);
    await runAdminTool('admin_read_event_log', { types: 'members.*', limit: 5 }, ctx);
    expect(calls).toEqual([
      { method: 'POST', path: '/v1/workspaces/org-1/invites', body: { emails: ['a@x.test'], kind: 'native' } },
      { method: 'PATCH', path: '/v1/workspaces/org-1', body: { policies: { inviteBy: 'admins' } } },
      { method: 'GET', path: '/v1/events?workspace=org-1&before=0&limit=5&types=members.*' },
    ]);
  });

  it('do a removal only with confirmed: true', async () => {
    const { ctx, calls } = fakeContext();
    await expect(runAdminTool('admin_remove_member', { user_id: 'u1' }, ctx)).rejects.toThrow(AdminToolError);
    await expect(runAdminTool('admin_remove_member', { user_id: 'u1', confirmed: false }, ctx)).rejects.toThrow(/needs the admin's yes/);
    expect(calls).toEqual([]);
    await runAdminTool('admin_remove_member', { user_id: 'u1', confirmed: true }, ctx);
    expect(calls).toEqual([{ method: 'DELETE', path: '/v1/workspaces/org-1/members/u1' }]);
  });

  it('mark every removal or take-away as needing a yes', () => {
    const confirmed = ADMIN_TOOLS.filter((t) => t.confirm).map((t) => t.name).sort();
    expect(confirmed).toEqual([
      'admin_change_join_link', 'admin_delete_automation', 'admin_make_domain_primary', 'admin_remove_agent', 'admin_remove_domain',
      'admin_remove_member', 'admin_revoke_invite', 'admin_set_member_kind', 'admin_set_role',
    ]);
    for (const t of ADMIN_TOOLS.filter((x) => x.confirm)) expect(t.shape).toHaveProperty('confirmed');
  });

  it('leave out deleting the organization and handing it over', () => {
    const paths = JSON.stringify(ADMIN_TOOLS.map((t) => t.name));
    expect(paths).not.toMatch(/delete_organization|transfer|owner/);
  });

  it('refuse without a context: no admin turn, no tools', async () => {
    await expect(runAdminTool('admin_list_members', {}, undefined)).rejects.toThrow(/only for an owner or admin/);
  });

  it('check their input', () => {
    expect(validateAdminTool('admin_set_role', { user_id: 'u1', role: 'owner' })).toMatchObject({ ok: false });
    expect(validateAdminTool('admin_set_role', { user_id: 'u1', role: 'admin' })).toMatchObject({ ok: true });
    expect(adminToolDefinitions().map((d) => d.name)).toEqual(ADMIN_TOOLS.map((t) => t.name));
  });

  it('are offered only in a turn the server marked as the admin agent\'s', () => {
    const names = (admin: boolean) => suiteTools({ page: 'home', ...(admin ? { admin: true } : {}) }, false).map((t) => t.name);
    expect(names(false).some((n) => n.startsWith('admin_'))).toBe(false);
    expect(names(true)).toContain('admin_list_members');
    expect(validateSuiteTool('admin_list_members', {}, { page: 'home' })).toMatchObject({ ok: false });
    expect(validateSuiteTool('admin_list_members', {}, { page: 'home', admin: true })).toMatchObject({ ok: true });
  });
});
