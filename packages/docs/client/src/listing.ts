import { useLayoutEffect, useRef } from 'react';
import { folderTrail } from '../../shared/folders.ts';

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

/** The query of the list last shown in this tab ('' for none or the top of My files). */
export function last(): string {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

/** The lists the home page shows in place of the folder's: Recents, Favorites and (FreeFlow suite) Shared with me. */
export const RECENTS_PARAM = 'recents';
export const FAVORITES_PARAM = 'favorites';
export const SHARED_WITH_ME_PARAM = 'withme';
export type OtherListName = typeof RECENTS_PARAM | typeof FAVORITES_PARAM | typeof SHARED_WITH_ME_PARAM;
const LISTS: Record<OtherListName, string> = { recents: 'Recents', favorites: 'Favorites', withme: 'Shared with me' };
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
/** In the FreeFlow suite, `org` names the organization whose Organization files the folder is in (HomePage's `?org=`). */
export function listingHref(folder?: string, org?: string): string {
  const search = fromList() ? '' : last();
  const was = new URLSearchParams(search);
  if ((was.get('folder') ?? '') === (folder ?? '') && (was.get('org') ?? undefined) === org) return `/${search}`;
  const q = new URLSearchParams();
  if (org) q.set('org', org);
  if (folder) q.set('folder', folder);
  return q.size ? `/?${q}` : '/';
}

/**
 * Whether a file made from the home page at this address goes to Organization files (FreeFlow suite; freeflow-suite.md
 * §2.4): new files are private, unless made inside Organization files' own list (`?org=<id>`, at its top or in a folder
 * of it). Recents, Favorites and Shared with me keep `org` in the address when chosen from there (HomePage's showList),
 * but a file made while one of them is shown is not made in a folder of Organization files, so it is private too. Only
 * the query counts: `/docs/` and `/docs` are the same place.
 */
export function newFileShared(address: string, inOrg: boolean): boolean {
  if (!inOrg) return false;
  const q = new URLSearchParams(new URL(address, 'http://x').search);
  if (!q.get('org')) return false;
  return !(Object.keys(LISTS) as OtherListName[]).some((l) => q.get(l) === '1');
}

/**
 * The crumbs of a file someone else shared with the user (FreeFlow suite): Shared with me, then, when it was opened
 * from a shared folder (`listing` is the list last shown, `?withme=1&in=<folder id>`, see server/access.ts
 * folderObjectId), that folder and the ones below it down to the file's. The owner's folders above what was shared,
 * and the name of their root, are theirs: none of them is named.
 */
export function sharedFileCrumbs(folder: string, listing: string): { name: string; href: string }[] {
  const out = [{ name: LISTS.withme, href: listHref(SHARED_WITH_ME_PARAM) }];
  const q = new URLSearchParams(listing);
  const inside = q.get(SHARED_WITH_ME_PARAM) === '1' ? (q.get('in') ?? '') : '';
  const cut = inside.indexOf('/');
  const rootKey = cut > 0 ? inside.slice(0, cut) : '';
  const top = cut > 0 ? inside.slice(cut + 1) : '';
  if (!top || !(folder === top || folder.startsWith(`${top}/`))) return out;
  for (const f of folderTrail(folder)) {
    if (f.path === top || f.path.startsWith(`${top}/`)) out.push({ name: f.name, href: `/?${new URLSearchParams({ [SHARED_WITH_ME_PARAM]: '1', in: `${rootKey}/${f.path}` })}` });
  }
  return out;
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
