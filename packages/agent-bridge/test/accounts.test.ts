// The bridge reads its accounts from GET /v1/me at start (platform.md §3.3): an address per organization.
import { describe, expect, it } from 'vitest';
import type { AccountDTO } from '@flow/shared';
import { accountLines, addressIn, type MeDTO } from '../src/api.js';

const account = (organizationId: string, address: string, state: AccountDTO['state'] = 'active'): AccountDTO => ({
  id: `acct-${organizationId}`, principalId: 'agent', organizationId, address, displayName: 'Builder', role: 'member', kind: 'native', state, createdAt: '',
});
const me = (accounts?: AccountDTO[]) => ({ id: 'agent', displayName: 'Builder', isAgent: true, ...(accounts ? { accounts } : {}) }) as MeDTO;

describe('the agent\'s accounts', () => {
  it('logs each account with its organization, by name where it is known, and its state unless active', () => {
    const lines = accountLines(me([account('w1', 'builder@acme.freeflow.im'), account('w2', 'builder@beta.freeflow.im', 'removed')]), [{ id: 'w1', name: 'Acme' }]);
    expect(lines).toEqual(['account builder@acme.freeflow.im in "Acme"', 'account builder@beta.freeflow.im in "w2" (removed)']);
  });

  it('finds the address in the workspace it serves, and says nothing for a server without accounts', () => {
    expect(addressIn(me([account('w1', 'builder@acme.freeflow.im')]), 'w1')).toBe('builder@acme.freeflow.im');
    expect(addressIn(me([account('w1', 'builder@acme.freeflow.im')]), 'w2')).toBeNull();
    expect(addressIn(me(), 'w1')).toBeNull();
    expect(accountLines(me(), [])).toEqual([]);
  });
});
