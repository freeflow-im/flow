// The caller gates the account apps share (routes/auth.ts): a guest uses Chat only (docs/specs/workspace-admin.md §6.5).
import { describe, expect, it } from 'vitest';
import type { AccountDTO } from '@flow/shared';
import { guestRefusal } from './auth';

const account = (kind: AccountDTO['kind']): AccountDTO => ({ id: 'a', principalId: 'u', organizationId: 'o', address: kind === 'guest' ? null : 'a@acme.freeflow.im', displayName: 'A', role: 'member', kind, state: 'active', createdAt: '' });

describe('guestRefusal', () => {
  it('refuses a guest with 403 guest, naming the app, and lets a native account through', () => {
    const refused = guestRefusal(account('guest'), 'Mail');
    expect(refused).toMatchObject({ statusCode: 403, code: 'guest' });
    expect(refused!.message).toContain('Mail');
    expect(guestRefusal(account('native'), 'Mail')).toBeNull();
    expect(guestRefusal(null, 'Mail')).toBeNull();
  });
});
