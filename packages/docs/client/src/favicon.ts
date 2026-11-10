// The browser-tab icon follows what is open: the files mark on the home page, or the kind of document open (spreadsheet,
// presentation, document, Markdown, picture, PDF): client/public/favicon-*.svg, the suite's icon set.
import { useEffect } from 'react';
import type { DocKind } from '../../shared/types.ts';
import { appUrl } from './basePath.ts';

export type FaviconKind = DocKind | 'home' | 'image' | 'pdf';

export const FAVICONS: Record<FaviconKind, string> = {
  home: appUrl('/favicon-home.svg'),
  sheet: appUrl('/favicon-sheet.svg'),
  deck: appUrl('/favicon-deck.svg'),
  doc: appUrl('/favicon-doc.svg'),
  markdown: appUrl('/favicon-markdown.svg'),
  image: appUrl('/favicon-image.svg'),
  pdf: appUrl('/favicon-pdf.svg'),
};

/** A stored file's icon: a picture's, a PDF's, else the files mark. */
export const faviconForFile = (type: string | undefined): FaviconKind => (type === 'application/pdf' ? 'pdf' : type?.startsWith('image/') ? 'image' : 'home');

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
