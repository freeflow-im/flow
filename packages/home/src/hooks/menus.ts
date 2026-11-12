// The menus the apps in Home's frames send (docs/specs/home.md §2.1, `@flow/suite-bar` lib/menu.ts): the last one from
// each app, kept in this browser per organization so it shows at once next time, before the app's frame has loaded.
import { useCallback, useEffect, useState } from 'react';
import { isMenuMessage, type SuiteMenuItem, type SuiteSelectMessage } from '@flow/suite-bar';
import type { FramedApp } from '../lib/views';

export interface AppMenu {
  items: SuiteMenuItem[];
  selected: string | null;
  /** Whether the app's frame sent it since it loaded (so it can take a click); false for the copy kept from before. */
  live: boolean;
}

const keyOf = (org: string) => `flow.home.menus.${org}`;

function readSaved(org: string | null): Partial<Record<FramedApp, AppMenu>> {
  if (!org) return {};
  try {
    const saved = JSON.parse(localStorage.getItem(keyOf(org)) ?? '{}') as Record<string, { items: SuiteMenuItem[]; selected: string | null }>;
    return Object.fromEntries(Object.entries(saved).map(([app, m]) => [app, { items: m.items, selected: m.selected, live: false }]));
  } catch {
    return {};
  }
}

function save(org: string, menus: Partial<Record<FramedApp, AppMenu>>): void {
  try {
    localStorage.setItem(keyOf(org), JSON.stringify(Object.fromEntries(Object.entries(menus).map(([app, m]) => [app, { items: m.items, selected: m.selected }]))));
  } catch {
    // Not kept: the menu shows once the app sends it.
  }
}

/**
 * The apps' menus, and `select`, which hands a click to the app's frame. `onAddress` hears the address an app says it
 * shows now, so Home's address can follow it.
 */
export function useAppMenus(org: string | null, frames: Partial<Record<FramedApp, HTMLIFrameElement | null>>, onAddress: (app: FramedApp, href: string) => void) {
  const [menus, setMenus] = useState(() => readSaved(org));
  useEffect(() => setMenus(readSaved(org)), [org]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || !isMenuMessage(e.data)) return;
      const app = e.data.app as FramedApp;
      // Only the app's own frame speaks for it.
      if (!frames[app] || e.source !== frames[app]!.contentWindow) return;
      const { items, selected, href } = e.data;
      setMenus((m) => {
        const next = { ...m, [app]: { items, selected, live: true } };
        if (org) save(org, next);
        return next;
      });
      if (href) onAddress(app, href);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [org, frames, onAddress]);

  /** Hands a click on an item to its app; false when the app cannot take it yet (its frame is not loaded). */
  const select = useCallback(
    (app: FramedApp, id: string): boolean => {
      const target = frames[app]?.contentWindow;
      if (!target || !menus[app]?.live) return false;
      target.postMessage({ type: 'flow:select', v: 1, app, id } satisfies SuiteSelectMessage, window.location.origin);
      // Marked at once; the app's next menu says what it actually shows.
      setMenus((m) => (m[app] ? { ...m, [app]: { ...m[app], selected: id } } : m));
      return true;
    },
    [frames, menus],
  );

  return { menus, select };
}
