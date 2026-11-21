// The browser-tab icon follows what is showing. The root's icons (index.html) are the suite mark, because this page is
// also the suite's sign-in (/login, /signup); signed in, it is Chat, so the tab shows Chat's own icon (public/chat-*).
// While something is waiting for you (the same unread count as the rail and dock badges), Chat's icon carries a small
// red dot in its top-right corner, the browser-tab stand-in for the app badge the native clients show.
import { useEffect } from 'react';
import chatSvg from '../../public/chat-favicon.svg?raw';

const ICON_LINKS = 'link[rel="icon"], link[rel="apple-touch-icon"]';
const SUITE_HREF = /^\/(favicon|apple-touch-icon)/;
/** Where a dotted link keeps the address it had, to go back to when nothing is waiting. */
const PLAIN = 'data-plain-href';
const PLAIN_TYPE = 'data-plain-type';

/** A suite icon's address → Chat's (`/favicon.svg` → `/chat-favicon.svg`), or back. */
export function iconHref(href: string, chat: boolean): string {
  const suite = href.replace(/^\/chat-/, '/');
  return chat ? suite.replace(SUITE_HREF, '/chat-$1') : suite;
}

function plainHref(link: HTMLLinkElement): string | null {
  return link.getAttribute(PLAIN) ?? link.getAttribute('href');
}

export function setChatFavicon(chat: boolean, doc: Document = document): void {
  for (const link of doc.querySelectorAll<HTMLLinkElement>(ICON_LINKS)) {
    const href = plainHref(link);
    if (!href) continue;
    const next = iconHref(href, chat);
    if (next === href) continue;
    if (link.hasAttribute(PLAIN)) link.setAttribute(PLAIN, next);
    else link.setAttribute('href', next);
  }
}

/** The alert dot: red, ringed in white so it reads on a dark tab strip and over the icon's purple alike. */
export const DOT = '<circle cx="24.5" cy="7.5" r="6.5" fill="#E5484D" stroke="#fff" stroke-width="2"/>';

/** An icon's SVG source with the dot drawn over it. */
export function withDot(svg: string): string {
  return svg.replace(/<\/svg>\s*$/, `${DOT}</svg>`);
}

/** Chat's icon with the dot, as an address a `<link rel="icon">` takes. */
export const DOTTED_ICON = `data:image/svg+xml,${encodeURIComponent(withDot(chatSvg))}`;

/**
 * The dot on or off. Only the tab icons change (`rel="icon"`; a home-screen icon is not a live signal), and only
 * Chat's: on the sign-in screen's suite mark there is nothing to be waiting. Every one of them points at the dotted
 * SVG — browsers pick one icon link and may prefer a PNG — and goes back to its own address when the dot clears.
 */
export function setFaviconDot(dot: boolean, doc: Document = document): void {
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
    const plain = plainHref(link);
    if (!plain) continue;
    if (dot && plain.startsWith('/chat-')) {
      if (!link.hasAttribute(PLAIN)) link.setAttribute(PLAIN_TYPE, link.getAttribute('type') ?? '');
      link.setAttribute(PLAIN, plain);
      link.setAttribute('href', DOTTED_ICON);
      link.setAttribute('type', 'image/svg+xml');
    } else if (link.hasAttribute(PLAIN)) {
      link.setAttribute('href', plain);
      const type = link.getAttribute(PLAIN_TYPE);
      if (type) link.setAttribute('type', type);
      else link.removeAttribute('type');
      link.removeAttribute(PLAIN);
      link.removeAttribute(PLAIN_TYPE);
    }
  }
}

/** Chat's icon while `chat` holds (someone is signed in), the suite mark otherwise. */
export function useChatFavicon(chat: boolean): void {
  useEffect(() => setChatFavicon(chat), [chat]);
}

/** The dot while `unread` is above zero; cleared when it drops to zero or the caller goes away. */
export function useFaviconDot(unread: number): void {
  const dot = unread > 0;
  useEffect(() => {
    setFaviconDot(dot);
    return () => setFaviconDot(false);
  }, [dot]);
}
