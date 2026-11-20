// The browser-tab icon follows what is showing. The root's icons (index.html) are the suite mark, because this page is
// also the suite's sign-in (/login, /signup); signed in, it is Chat, so the tab shows Chat's own icon (public/chat-*).
import { useEffect } from 'react';

const ICON_LINKS = 'link[rel="icon"], link[rel="apple-touch-icon"]';
const SUITE_HREF = /^\/(favicon|apple-touch-icon)/;

/** A suite icon's address → Chat's (`/favicon.svg` → `/chat-favicon.svg`), or back. */
export function iconHref(href: string, chat: boolean): string {
  const suite = href.replace(/^\/chat-/, '/');
  return chat ? suite.replace(SUITE_HREF, '/chat-$1') : suite;
}

export function setChatFavicon(chat: boolean, doc: Document = document): void {
  for (const link of doc.querySelectorAll<HTMLLinkElement>(ICON_LINKS)) {
    const href = link.getAttribute('href');
    if (!href) continue;
    const next = iconHref(href, chat);
    if (next !== href) link.setAttribute('href', next);
  }
}

/** Chat's icon while `chat` holds (someone is signed in), the suite mark otherwise. */
export function useChatFavicon(chat: boolean): void {
  useEffect(() => setChatFavicon(chat), [chat]);
}
