// An app shown inside Home (docs/specs/home.md §2): Home keeps each app it opened loaded in a frame of its own, so a
// switch back is instant. Inside it, an app draws no suite bar (Home's is above it), and a link to another app opens in
// Home rather than in the frame. Home and the apps are on one origin, so the frame can read its parent's address.

/** The message Home sends a framed app, and a framed app sends Home: open this address. */
export interface SuiteOpenMessage {
  type: 'flow:open';
  href: string;
}

/** The path every app's page lives under, which Home's frames are not: Home itself. */
const HOME_PATH = '/home';

/** Whether this page is an app inside Home's frame (false in Home itself, in a tab of its own, or framed by another site). */
export function isInHome(): boolean {
  try {
    return window.top !== window.self && !!window.top && window.top.location.origin === window.location.origin && window.top.location.pathname.startsWith(HOME_PATH);
  } catch {
    // Another origin's frame: its address cannot be read, and it is not Home.
    return false;
  }
}

/** The app an address belongs to, by its first path segment, for the apps Home shows in a frame; null for anything else. */
export function appOfPath(pathname: string): string | null {
  const first = pathname.split('/')[1] ?? '';
  return ['mail', 'calendar', 'docs', 'chat', 'admin', 'contacts', 'home'].includes(first) ? first : null;
}

export function isOpenMessage(data: unknown): data is SuiteOpenMessage {
  return !!data && typeof data === 'object' && (data as SuiteOpenMessage).type === 'flow:open' && typeof (data as SuiteOpenMessage).href === 'string';
}

/** Asks Home to open an address (another app's page, or Home's own). */
export function openInHome(href: string): void {
  window.top?.postMessage({ type: 'flow:open', href } satisfies SuiteOpenMessage, window.location.origin);
}

/**
 * Inside Home: a click on a link to another app's page goes to Home instead of loading that app in this frame. A click
 * with a modifier (a new tab or window) is the browser's, as everywhere. Returns the uninstall.
 */
export function routeLinksToHome(ownApp: string): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || (a.target && a.target !== '_self')) return;
    const url = new URL(a.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    const app = appOfPath(url.pathname);
    if (!app || app === ownApp) return;
    e.preventDefault();
    openInHome(url.pathname + url.search + url.hash);
  };
  document.addEventListener('click', onClick);
  return () => document.removeEventListener('click', onClick);
}

/** Inside Home: what Home asks this app to open (Chat switches channel in place). Only Home's own messages count. */
export function onOpenFromHome(handler: (href: string) => void): () => void {
  const onMessage = (e: MessageEvent) => {
    if (e.origin !== window.location.origin || e.source !== window.top || !isOpenMessage(e.data)) return;
    handler(e.data.href);
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
