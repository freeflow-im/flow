// The organization selected in the suite bar, for the bar and for the assistant (its chat lives in that organization's
// Docs). Kept where Chat keeps it (suite.ts); Chat or another tab choosing one moves it here too.
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

/** The user's organizations, and the one selected (else the first). */
export function useOrganizations(): { list: SuiteOrganization[]; active: SuiteOrganization | undefined } {
  const orgs = useQuery({ queryKey: ['suite', 'organizations'], queryFn: suite.organizations, refetchInterval: REFRESH_MS });
  const activeId = useSyncExternalStore(subscribe, () => current, () => null);
  const list = orgs.data ?? [];
  return { list, active: list.find((o) => o.id === activeId) ?? list[0] };
}
