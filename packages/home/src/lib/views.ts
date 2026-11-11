// What Home's main area shows (docs/specs/home.md §2): Home's own cards, or one app in a frame. Each address an app owns
// opens in that app's frame; Home's address names it (`/home/?open=<address>`), so reload and Back come back to it.
import { appOfPath } from '@flow/suite-bar';

/** The apps Home opens in a frame. Anything else (another site) is followed as a link. */
export const FRAMED_APPS = ['mail', 'calendar', 'docs', 'chat', 'admin', 'contacts'] as const;
export type FramedApp = (typeof FRAMED_APPS)[number];
export type View = 'home' | FramedApp;

/** The view an address opens in Home: `home`, an app's frame, or null for an address Home does not show. */
export function viewOf(href: string, origin: string): View | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const app = appOfPath(url.pathname);
  return app === 'home' ? 'home' : app && (FRAMED_APPS as readonly string[]).includes(app) ? (app as FramedApp) : null;
}

/** Whether an address is the app's own front page (`/mail/`, `/chat`), with nothing chosen in it. */
export function isFrontPage(href: string, origin: string): boolean {
  const url = new URL(href, origin);
  return /^\/[a-z]+\/?$/.test(url.pathname) && !url.search && !url.hash;
}

/** Home's own address for what it shows: `/home/`, or `/home/?open=<the app's address>`. */
export function homeAddress(href: string | null): string {
  return href ? `/home/?open=${encodeURIComponent(href)}` : '/home/';
}

/** What Home's address asks it to show: an app's address, or null for Home's cards. */
export function openedIn(search: string): string | null {
  const open = new URLSearchParams(search).get('open');
  return open && open.startsWith('/') && !open.startsWith('//') ? open : null;
}

/** The chat channel an address opens (`/chat/?open=channel:<id>`), to mark it in the sidebar. */
export function channelOf(href: string, origin: string): string | null {
  const open = new URL(href, origin).searchParams.get('open');
  return open?.startsWith('channel:') ? open.slice('channel:'.length) : null;
}
