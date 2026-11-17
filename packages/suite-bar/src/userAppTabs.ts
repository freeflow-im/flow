// The tabs of the apps installed in the organization (docs/specs/user-apps.md §6, phase 1), after the built-in apps'. They
// are data, not manifests in @flow/shared: GET /v1/workspaces/:id/apps says which apps there are and which the person may
// open (`usable`, holding one of the app's scopes). Each opens /apps/<name>, the page that frames the app's screen. They
// carry no ⌘ digit: the digits are the built-in apps'.
import { useEffect, useState } from 'react';
import type { SuiteTab } from './SuiteBar';

/** What a tab needs of an installed app (the API's InstalledAppDTO). */
export interface UserAppTabSource { name: string; label: string; icon?: string; usable: boolean; hasScreen: boolean }

/** The id of an installed app's tab: apart from the built-in apps' ids. */
export const userAppTabId = (name: string): string => `app:${name}`;

/** The tabs for the installed apps the person may open; `active` is the app whose page this is. */
export function userAppTabs(apps: readonly UserAppTabSource[], active?: string): SuiteTab[] {
  return apps
    .filter((a) => a.usable && a.hasScreen)
    .map((a) => ({
      id: userAppTabId(a.name),
      label: a.icon ? `${a.icon} ${a.label}` : a.label,
      href: `/apps/${a.name}`,
      ...(a.name === active ? { active: true } : {}),
    }));
}

const cache = new Map<string, UserAppTabSource[]>();

/** The installed apps of an organization, fetched on the suite's origin with its session cookie; none on any failure. */
export async function fetchUserApps(organizationId: string): Promise<UserAppTabSource[]> {
  try {
    const res = await fetch(`/v1/workspaces/${encodeURIComponent(organizationId)}/apps`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    const body = (await res.json()) as { apps?: UserAppTabSource[] };
    return Array.isArray(body.apps) ? body.apps : [];
  } catch {
    return [];
  }
}

/** The installed apps' tabs for the organization selected in the bar, fetched again when it changes. */
export function useUserAppTabs(organizationId: string | null | undefined, active?: string): SuiteTab[] {
  const [apps, setApps] = useState<UserAppTabSource[]>(() => (organizationId ? cache.get(organizationId) ?? [] : []));
  useEffect(() => {
    if (!organizationId) {
      setApps([]);
      return;
    }
    let live = true;
    setApps(cache.get(organizationId) ?? []);
    void fetchUserApps(organizationId).then((list) => {
      cache.set(organizationId, list);
      if (live) setApps(list);
    });
    return () => {
      live = false;
    };
  }, [organizationId]);
  return userAppTabs(apps, active);
}
