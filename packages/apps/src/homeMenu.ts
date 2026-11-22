// The Apps page inside Home (docs/specs/home.md §2.1): the menu it sends Home for the Apps row in Home's sidebar. The
// installed apps the person may open, then Build an app, as the suite bar's Apps menu lists them (userAppTabs).
import type { SuiteMenuItem, SuiteTab } from '@flow/suite-bar';

/** The menu items for Home, from the Apps tab `useUserAppTabs` makes; null while there is no tab (nothing to send). */
export function appsHomeMenu(tabs: SuiteTab[]): SuiteMenuItem[] | null {
  const menu = tabs.find((t) => t.id === 'apps')?.menu;
  if (!menu) return null;
  return menu
    .filter((m) => !m.divider && m.href)
    .map((m) => ({ id: m.id, label: m.label, href: m.href, ...(m.id === 'apps-build' ? { icon: 'plus' as const } : {}) }));
}

/** The item the page shows: the open app, or Build an app on the apps home and in the builder. */
export function appsHomeSelected(name: string | null): string {
  return name ? `app:${name}` : 'apps-build';
}
