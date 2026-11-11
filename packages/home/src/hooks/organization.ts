// The organization selected in the suite bar, the one Home shows. Kept where Chat keeps it (suite.ts); Chat or
// another tab choosing one moves it here too. As Admin's hooks/organization.ts.
import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { readActiveOrganization, suite, writeActiveOrganization, type SuiteOrganization } from '../suite';

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

export const ORGANIZATIONS_KEY = ['suite', 'organizations'] as const;

/** The user's organizations, the one selected (else the first), and whether the list has come (`ready`). */
export function useOrganizations(): { list: SuiteOrganization[]; active: SuiteOrganization | undefined; ready: boolean } {
  const orgs = useQuery({ queryKey: ORGANIZATIONS_KEY, queryFn: suite.organizations, refetchInterval: REFRESH_MS });
  const activeId = useSyncExternalStore(subscribe, () => current, () => null);
  const list = orgs.data ?? [];
  return { list, active: list.find((o) => o.id === activeId) ?? list[0], ready: orgs.isSuccess };
}
