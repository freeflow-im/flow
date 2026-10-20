// The host seam (docs/specs/desktop-electron.md, "Bridge contract").
//
// The web client runs in three hosts: a browser tab, the desktop shell's
// renderer, where the preload exposes `window.flowDesktop`, and the Android
// shell's WebView, which builds the same bridge from a document-start script
// and a Capacitor plugin (hostAndroid.ts). Everything the
// shell can do that a tab cannot — keep a credential in the OS store, open
// the system browser and get a `flow://` link back, know whether the window
// is focused — is reached through `getHost()`. The browser fallback has the
// same shape, so call sites never branch on where they run; they ask the host.
//
// `isDesktop()` exists for the few places whose *product* behaviour differs
// (sign-in goes through the system browser, the "open the desktop app" pitch
// is pointless inside the desktop app), not for capability checks.
import type {
  DesktopBack,
  DesktopBadge,
  DesktopLinks,
  DesktopNotification,
  DesktopNotifications,
  DesktopSecrets,
  DesktopWindow,
  DesktopZoom,
  FlowDesktopBridge,
  NotificationRouting,
} from '@flow/shared';
import { androidBridge } from './hostAndroid';

export interface FlowHost {
  /** A packaged shell — desktop or Android — rather than a browser tab: it
   * signs in through the system browser, keeps credentials out of
   * localStorage, has no "open the app" pitch to make. */
  readonly isDesktop: boolean;
  readonly platform: 'browser' | 'darwin' | 'win32' | 'linux' | 'android';
  /** The Flow server this client is built for, or null when the page's own
   * origin is the server (the browser case). */
  readonly defaultServerOrigin: string | null;
  /** `FLOW_PROFILE` on desktop, null in a browser. */
  readonly profile: string | null;
  /** May this client talk plaintext to a loopback server? The shell says yes
   * when its baked default is one (a development build); a browser decides
   * from its own page origin (see `serverOrigin.ts`). */
  readonly allowsInsecureLoopback: boolean;
  readonly secrets: DesktopSecrets;
  readonly links: DesktopLinks;
  readonly window: DesktopWindow;
  readonly zoom: DesktopZoom;
  readonly notifications: DesktopNotifications;
  readonly badge: DesktopBadge;
  /** The hardware back button; a browser and the desktop report none, so a
   * listener there is never called. */
  readonly back: DesktopBack;
}

/** "Looking at it" (docs/design/NOTIFICATIONS.md): the page is visible, and
 * in the desktop shell the window is also focused — the same app-active gate
 * the macOS `scenePhase` handler applies. A browser tab keeps the visibility
 * rule alone, unchanged. */
export function isLookingAtApp(): boolean {
  if (typeof document === 'undefined' || document.hidden) return false;
  const host = getHost();
  return !host.isDesktop || host.window.isFocused();
}

/** Run `listener` whenever `isLookingAtApp()` may have changed. */
export function onLookingChange(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener);
  const off = getHost().isDesktop ? getHost().window.onFocusChange(() => listener()) : () => {};
  return () => { document.removeEventListener('visibilitychange', listener); off(); };
}

/** The browser's own Notification API: one banner per row (`tag`), click
 * focuses the tab and hands the routing back. `persistent` maps to
 * `requireInteraction`, the web-only "keep banners on screen" preference. */
function browserNotifications(): DesktopNotifications {
  const listeners = new Set<(routing: NotificationRouting) => void>();
  return {
    show: (n: DesktopNotification & { persistent?: boolean }) => {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      try {
        const banner = new Notification(n.subtitle ? `${n.title} · ${n.subtitle}` : n.title, {
          body: n.body,
          tag: n.id,
          requireInteraction: n.persistent === true,
          silent: n.silent,
        });
        banner.onclick = () => {
          window.focus();
          banner.close();
          for (const listener of listeners) listener(n.routing);
        };
      } catch { /* banner is best-effort */ }
    },
    onClick: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    clearDelivered: () => {},
  };
}

/** The Badging API where a browser offers it (an installed PWA); silently
 * nothing elsewhere. */
const browserBadge: DesktopBadge = {
  set: (count) => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    try { void (count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.()); } catch { /* unsupported */ }
  },
};

function browserSecrets(): DesktopSecrets {
  return {
    available: true,
    get: (key) => localStorage.getItem(key),
    set: (key, value) => localStorage.setItem(key, value),
    delete: (key) => localStorage.removeItem(key),
  };
}

function browserLinks(): DesktopLinks {
  return {
    openExternal: (url) => { window.open(url, '_blank', 'noopener'); },
    // A browser tab is never handed a flow:// link; the OS routes those to
    // the installed app.
    onDeepLink: () => () => {},
  };
}

function browserWindow(): DesktopWindow {
  return {
    isFocused: () => typeof document !== 'undefined' && document.hasFocus(),
    onFocusChange: (listener) => {
      const focus = () => listener(true);
      const blur = () => listener(false);
      window.addEventListener('focus', focus);
      window.addEventListener('blur', blur);
      return () => { window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); };
    },
    setTitle: (title) => { if (typeof document !== 'undefined') document.title = title; },
  };
}

const browserZoom: DesktopZoom = { get: () => 0, set: () => {} };

/** No back button here: the listener is kept nowhere and never called. */
const noBack: DesktopBack = { onBack: () => () => {} };

function browserHost(): FlowHost {
  return {
    isDesktop: false,
    platform: 'browser',
    defaultServerOrigin: null,
    profile: null,
    allowsInsecureLoopback: false,
    secrets: browserSecrets(),
    links: browserLinks(),
    window: browserWindow(),
    zoom: browserZoom,
    notifications: browserNotifications(),
    badge: browserBadge,
    back: noBack,
  };
}

function desktopHost(bridge: FlowDesktopBridge): FlowHost {
  const origin = bridge.info.defaultServerOrigin;
  return {
    isDesktop: true,
    platform: bridge.info.platform,
    defaultServerOrigin: origin,
    profile: bridge.info.profile,
    allowsInsecureLoopback: origin.startsWith('http://'),
    secrets: bridge.secrets,
    links: bridge.links,
    window: {
      ...bridge.window,
      // The window title follows the document title in Electron, so the
      // document is what to set; the shell is told too for its own bookkeeping.
      setTitle: (title) => {
        if (typeof document !== 'undefined') document.title = title;
        bridge.window.setTitle(title);
      },
    },
    zoom: bridge.zoom,
    notifications: bridge.notifications,
    badge: bridge.badge,
    back: bridge.back ?? noBack,
  };
}

let current: FlowHost | null = null;

export function getHost(): FlowHost {
  if (current) return current;
  const bridge = typeof window !== 'undefined' ? window.flowDesktop ?? androidBridge() : undefined;
  current = bridge ? desktopHost(bridge) : browserHost();
  return current;
}

export function isDesktop(): boolean {
  return getHost().isDesktop;
}

/** Test seam: install a host, or null to detect again on the next call. */
export function __setHost(host: FlowHost | null): void {
  current = host;
}
