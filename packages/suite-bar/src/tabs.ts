// The bar's app tabs from the apps' manifests (@flow/shared's APP_MANIFESTS; docs/specs/platform.md §5.6): each app with
// a `tab`, in its shortcut's order (⌘1 to ⌘4). Each app's bar keeps its own badge numbers and its own navigation.
import type { AppManifest, AppTabBadge } from '@flow/shared';
import type { SuiteTab } from './SuiteBar';

export interface SuiteTabOptions {
  /** The active tab's own link (the app's base URL); its manifest path without it. */
  activeHref?: string;
  /** What selecting the active tab does (the app's own router) instead of following it. */
  onSelect?: () => void;
  /** A tab that cannot be followed from here: why, shown on hover. Null to leave it as it is. */
  unavailable?: (tab: { id: string; label: string }) => string | null;
}

/** The tabs for the app `active`, with the numbers each badge source has on this bar (a source left out draws none). */
export function suiteTabsFrom(
  manifests: readonly AppManifest[],
  active: string,
  badges: Partial<Record<Exclude<AppTabBadge, 'none'>, number>> = {},
  options: SuiteTabOptions = {},
): SuiteTab[] {
  return manifests
    .flatMap((m) => (m.tab && m.path ? [{ m, tab: m.tab, path: m.path }] : []))
    .sort((a, b) => a.tab.shortcut.localeCompare(b.tab.shortcut))
    .map(({ m, tab, path }) => {
      const isActive = m.name === active;
      const badge = tab.badge && tab.badge !== 'none' ? badges[tab.badge] : undefined;
      const why = isActive ? null : (options.unavailable?.({ id: m.name, label: tab.label }) ?? null);
      return {
        id: m.name,
        label: tab.label,
        href: isActive ? (options.activeHref ?? path) : path,
        ...(isActive ? { active: true } : {}),
        ...(badge !== undefined ? { badge } : {}),
        ...(why ? { disabled: true, title: why } : {}),
        ...(isActive && options.onSelect ? { onSelect: options.onSelect } : {}),
      };
    });
}
