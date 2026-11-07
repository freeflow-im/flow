// The organization selected in the suite bar, for the bar and for the assistant (its chat lives in that organization's
// Docs). Kept where Chat keeps it (suite.ts); Chat or another tab choosing one moves it here too.
import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { readActiveOrganization, suite, writeActiveOrganization, type SuiteAccount, type SuiteOrganization } from '../suite';

const REFRESH_MS = 60_000;
const listeners = new Set<() => void>();
let current = readActiveOrganization();

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = () => {
    current = readActiveOrganization();
    l();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
}

export function chooseOrganization(id: string): void {
  writeActiveOrganization(id);
  current = id;
  for (const l of listeners) l();
}

/** The states in which the account's mailbox is still being made (platform.md §3.4). */
export const SETTING_UP: readonly SuiteAccount['state'][] = ['requested', 'mailbox_ready', 'calendars_ready'];
const SETUP_POLL_MS = 5_000;

/** The person's account in the organization, polled every 5 s while its mailbox is being set up, else not again. */
export function useAccountState(organizationId: string | null): SuiteAccount['state'] | null {
  const q = useQuery({
    queryKey: ['suite', 'accounts'],
    queryFn: suite.accounts,
    enabled: !!organizationId,
    refetchInterval: (query) => {
      const state = query.state.data?.find((a) => a.organizationId === organizationId)?.state;
      return state && SETTING_UP.includes(state) ? SETUP_POLL_MS : false;
    },
  });
  return q.data?.find((a) => a.organizationId === organizationId)?.state ?? null;
}

/** The user's organizations, the one selected (else the first), and whether the list has come (`ready`). */
export function useOrganizations(): { list: SuiteOrganization[]; active: SuiteOrganization | undefined; ready: boolean } {
  const orgs = useQuery({ queryKey: ['suite', 'organizations'], queryFn: suite.organizations, refetchInterval: REFRESH_MS });
  const activeId = useSyncExternalStore(subscribe, () => current, () => null);
  const list = orgs.data ?? [];
  return { list, active: list.find((o) => o.id === activeId) ?? list[0], ready: orgs.isSuccess };
}
