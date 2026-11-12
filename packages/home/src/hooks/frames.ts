// Home's frames (docs/specs/home.md §2): one per app, made the first time the app is opened and kept, hidden, while
// another view shows, so going back to it is instant and it is where it was left. Opening an address in an app already
// loaded shows it as it is when the address is the app's front page; Chat is asked to open the rest in place (it reads
// `open=` links sent to it); the other apps load the address.
import { useCallback, useEffect, useRef, useState } from 'react';
import { homeAddress, isFrontPage, openedIn, viewOf, type FramedApp, type View } from '../lib/views';

export interface FrameState {
  /** Each loaded app's address, and a number that changes when it must load again (the same address asked for twice). */
  frames: Partial<Record<FramedApp, { src: string; load: number }>>;
  view: View;
  /** The last address opened in each app (for the sidebar's selection). */
  last: Partial<Record<FramedApp, string>>;
}

export function useFrames() {
  const origin = window.location.origin;
  const refs = useRef<Partial<Record<FramedApp, HTMLIFrameElement | null>>>({});
  const [state, setState] = useState<FrameState>(() => {
    const href = openedIn(window.location.search);
    const view = href ? viewOf(href, origin) : 'home';
    return view && view !== 'home' && href ? { frames: { [view]: { src: href, load: 0 } }, view, last: { [view]: href } } : { frames: {}, view: 'home', last: {} };
  });

  const current = useRef(state);
  current.current = state;

  /** Shows an address: Home's cards, or an app's page in its frame. False for an address Home does not show. */
  const open = useCallback(
    (href: string, how: { push: boolean; asIs?: boolean } = { push: true }): boolean => {
      const view = viewOf(href, origin);
      if (!view) return false;
      const s = current.current;
      let next: FrameState = { ...s, view };
      if (view !== 'home') {
        const loaded = s.frames[view];
        let frames = s.frames;
        if (!loaded) frames = { ...s.frames, [view]: { src: href, load: 0 } };
        else if (!how.asIs && !isFrontPage(href, origin)) {
          if (view === 'chat') refs.current.chat?.contentWindow?.postMessage({ type: 'flow:open', href }, origin);
          else frames = { ...s.frames, [view]: { src: href, load: loaded.load + 1 } };
        }
        next = { frames, view, last: { ...s.last, [view]: href } };
      }
      current.current = next;
      setState(next);
      if (how.push) {
        const address = homeAddress(view === 'home' ? null : href);
        if (address !== window.location.pathname + window.location.search) window.history.pushState(null, '', address);
      }
      return true;
    },
    [origin],
  );

  /** Shows an app's frame as it is (loading its front page the first time). */
  const show = useCallback((app: FramedApp) => open(current.current.last[app] && current.current.frames[app] ? current.current.last[app]! : `/${app}/`, { push: true, asIs: true }), [open]);

  /** The app says what it shows now (its menu's `href`): Home's address follows, without a new history entry. */
  const follow = useCallback(
    (app: FramedApp, href: string) => {
      const s = current.current;
      if (s.last[app] === href) return;
      const next = { ...s, last: { ...s.last, [app]: href } };
      current.current = next;
      setState(next);
      if (s.view === app) window.history.replaceState(null, '', homeAddress(href));
    },
    [],
  );

  // Back and Forward: what Home's address names now.
  useEffect(() => {
    const onPop = () => void open(openedIn(window.location.search) ?? '/home/', { push: false });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [open]);

  // A link to another app clicked inside a frame comes here (the suite bar's routeLinksToHome).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin) return;
      const data = e.data as { type?: string; href?: unknown };
      if (data?.type === 'flow:open' && typeof data.href === 'string' && !open(data.href)) window.location.assign(data.href);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [open, origin]);

  return { ...state, open, show, follow, refs };
}
