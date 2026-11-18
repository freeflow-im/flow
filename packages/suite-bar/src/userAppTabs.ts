// The installed apps in the suite bar (docs/specs/user-apps.md §6): one Apps tab after the built-in apps', with a menu of
// the installed apps the person may open (GET /v1/workspaces/:id/apps: `usable`, holding one of the app's scopes, and a
// screen) and Build an app, the apps home where people build and edit apps (§9.6). It carries no ⌘ digit: the digits are
// the built-in apps'. The list is read again when the page is shown again and when an app is installed here
// (APPS_CHANGED), so a new app appears without a reload.
import { useEffect, useState } from 'react';
import type { SuiteTab } from './SuiteBar';

/** What the menu needs of an installed app (the API's InstalledAppDTO). */
export interface UserAppTabSource { name: string; label: string; icon?: string; usable: boolean; hasScreen: boolean }

/** A window event: an app was installed, updated or removed on this page; the Apps menu reads its list again. */
export const APPS_CHANGED = 'freeflow:apps-changed';
export const appsChanged = (): void => { window.dispatchEvent(new Event(APPS_CHANGED)); };

/** The id of an installed app's entry: apart from the built-in apps' ids. */
export const userAppTabId = (name: string): string => `app:${name}`;

/**
 * The Apps tab: its menu lists the installed apps the person may open, then Build an app. `active` is the app whose page
 * this is ('' for the apps home itself). None when the person may not build and has no app to open (a guest).
 */
export function userAppTabs(apps: readonly UserAppTabSource[], active?: string, canBuild = true): SuiteTab[] {
  const open = apps.filter((a) => a.usable && a.hasScreen);
  if (!open.length && !canBuild) return [];
  return [{
    id: 'apps',
    label: 'Apps',
    href: '/apps/',
    ...(active !== undefined ? { active: true } : {}),
    menu: [
      ...open.map((a) => ({ id: userAppTabId(a.name), label: a.icon ? `${a.icon} ${a.label}` : a.label, href: `/apps/${a.name}`, ...(a.name === active ? { current: true } : {}) })),
      ...(canBuild ? [...(open.length ? [{ id: 'apps-divider', label: '', href: '', divider: true }] : []), { id: 'apps-build', label: 'Build an app', href: '/apps/', ...(active === '' ? { current: true } : {}) }] : []),
    ],
  }];
}

interface AppsAnswer { apps: UserAppTabSource[]; canBuild: boolean }
const cache = new Map<string, AppsAnswer>();

/** The installed apps of an organization, on the suite's origin with its session cookie; none on any failure. */
export async function fetchUserApps(organizationId: string): Promise<AppsAnswer> {
  try {
    const res = await fetch(`/v1/workspaces/${encodeURIComponent(organizationId)}/apps`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!res.ok) return { apps: [], canBuild: false };
    const body = (await res.json()) as { apps?: UserAppTabSource[]; canBuild?: boolean };
    return { apps: Array.isArray(body.apps) ? body.apps : [], canBuild: body.canBuild !== false };
  } catch {
    return { apps: [], canBuild: false };
  }
}

/** The Apps tab for the organization selected in the bar. `active`: the app whose page this is, '' for the apps home. */
export function useUserAppTabs(organizationId: string | null | undefined, active?: string): SuiteTab[] {
  const [answer, setAnswer] = useState<AppsAnswer>(() => (organizationId ? cache.get(organizationId) : undefined) ?? { apps: [], canBuild: false });
  useEffect(() => {
    if (!organizationId) {
      setAnswer({ apps: [], canBuild: false });
      return;
    }
    let live = true;
    const load = () => void fetchUserApps(organizationId).then((a) => {
      cache.set(organizationId, a);
      if (live) setAnswer(a);
    });
    setAnswer(cache.get(organizationId) ?? { apps: [], canBuild: false });
    load();
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    window.addEventListener(APPS_CHANGED, load);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', load);
    return () => {
      live = false;
      window.removeEventListener(APPS_CHANGED, load);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', load);
    };
  }, [organizationId]);
  return userAppTabs(answer.apps, active, answer.canBuild);
}
