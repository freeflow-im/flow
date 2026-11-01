// The browser-tab icon follows what is open: the home page's generic mark, or the spreadsheet, presentation
// document or Markdown icon (client/public/favicon-*.svg, the same marks as the logos in components/Logo.tsx).
import { useEffect } from 'react';
import type { DocKind } from '../../shared/types.ts';

export type FaviconKind = DocKind | 'home';

export const FAVICONS: Record<FaviconKind, string> = {
  home: '/favicon-home.svg',
  sheet: '/favicon-sheet.svg',
  deck: '/favicon-deck.svg',
  doc: '/favicon-doc.svg',
  markdown: '/favicon-markdown.svg',
};

export function setFavicon(kind: FaviconKind): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  if (link.getAttribute('href') !== FAVICONS[kind]) link.href = FAVICONS[kind];
}

/** Show this kind's icon while the component is mounted; the home icon comes back when it unmounts. */
export function useFavicon(kind: FaviconKind): void {
  useEffect(() => {
    setFavicon(kind);
    return () => setFavicon('home');
  }, [kind]);
}
