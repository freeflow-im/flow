import { useLayoutEffect, useRef } from 'react';

// The file list a tab was last showing: its folder and any search, as the query of the home page's
// address. An open file's links back to the list use it, so going back shows the same search results.
const KEY = 'ui.lastListing';

export function rememberListing(search: string): void {
  try {
    sessionStorage.setItem(KEY, search);
  } catch {
    // Not remembered, that's all.
  }
}

function last(): string {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

/** The lists the home page shows in place of the folder's: Recents and Favorites. */
export const RECENTS_PARAM = 'recents';
export const FAVORITES_PARAM = 'favorites';
export type OtherListName = typeof RECENTS_PARAM | typeof FAVORITES_PARAM;
const LISTS: Record<OtherListName, string> = { recents: 'Recents', favorites: 'Favorites' };
export const listHref = (list: OtherListName): string => `/?${list}=1`;
export const RECENTS_HREF = listHref(RECENTS_PARAM);
export const rememberList = (list: OtherListName): void => rememberListing(`?${list}=1`);
/** The list the file being shown was opened from, when it is one of those: its breadcrumbs then start there. */
export function fromList(): { label: string; href: string } | null {
  const params = new URLSearchParams(last());
  const list = (Object.keys(LISTS) as OtherListName[]).find((l) => params.get(l) === '1');
  return list ? { label: LISTS[list], href: listHref(list) } : null;
}

/**
 * The desktop app: the folder a file was opened from when the window moved to the file's own folder to show it
 * (a scratch pad, in ~/.config/mcp-docs). Its breadcrumbs show that folder, and the way back to a list moves
 * the window back there (HomePage).
 */
export interface ReturnTo {
  /** The folder's absolute path. */
  dir: string;
  /** The folder in it that was shown ('' for the top). */
  folder: string;
}
const RETURN_KEY = 'ui.returnTo';

export function rememberReturn(to: ReturnTo | null): void {
  try {
    if (to) sessionStorage.setItem(RETURN_KEY, JSON.stringify(to));
    else sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // Not remembered: the file's own folder it is.
  }
}

export function returnTo(): ReturnTo | null {
  try {
    const to = JSON.parse(sessionStorage.getItem(RETURN_KEY) ?? 'null') as ReturnTo | null;
    return to && typeof to.dir === 'string' && typeof to.folder === 'string' ? to : null;
  } catch {
    return null;
  }
}

/** The list as it was last shown. */
export const lastListingHref = (): string => `/${last()}`;

/** The list showing a folder ('' or absent is the top), with the search it had if that is the folder last shown. */
export function listingHref(folder?: string): string {
  const search = fromList() ? '' : last();
  if ((new URLSearchParams(search).get('folder') ?? '') === (folder ?? '')) return `/${search}`;
  return folder ? `/?folder=${encodeURIComponent(folder)}` : '/';
}

/** The element the pages scroll in (main.tsx, .app-main). */
const scroller = (): HTMLElement | null => document.querySelector('.app-main');
const scrollKey = (search: string) => `ui.listingScroll${search}`;

/**
 * Keep where a list was scrolled to, per list (its folder, search or Recents), and go back there when
 * the list is shown again: from a file's breadcrumbs or with Back. `search` names the list; `ready` is
 * whether its rows are shown yet, since the position can only be restored once they are.
 */
export function useListingScroll(search: string, ready: boolean): void {
  // Saving waits until the list's own position is restored: a list still loading is short, and the
  // browser clamping the position to it is not the user scrolling.
  const restored = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!ready || restored.current === search) return;
    const el = scroller();
    if (!el) return;
    let top = 0;
    try {
      top = Number(sessionStorage.getItem(scrollKey(search))) || 0;
    } catch {
      // Not remembered: the top.
    }
    el.scrollTop = top;
    restored.current = search;
  }, [search, ready]);
  // A layout effect, so that leaving the list saves its position before its rows are taken away.
  useLayoutEffect(() => {
    const el = scroller();
    if (!el) return;
    const save = () => {
      if (restored.current !== search) return;
      try {
        sessionStorage.setItem(scrollKey(search), String(Math.round(el.scrollTop)));
      } catch {
        // Not remembered, that's all.
      }
    };
    el.addEventListener('scroll', save, { passive: true });
    return () => {
      el.removeEventListener('scroll', save);
      save();
    };
  }, [search]);
}
