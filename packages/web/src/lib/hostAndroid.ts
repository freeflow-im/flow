// The Android shell's side of the host seam (docs/design/ANDROID.md;
// docs/specs/desktop-electron.md, "Bridge contract").
//
// The Electron shell's preload builds `window.flowDesktop` before the page's
// scripts run. A WebView has no preload, so the Android shell does the same
// in two parts: a document-start script, registered for the app's own origin
// only, leaves `window.flowShellBoot` — the info block and a decrypted
// snapshot of the credentials, which is what keeps the web client's token
// reads synchronous — and the Capacitor plugin `FlowShell` takes everything
// after boot: credential writes, opening the system browser, `flow://` links
// the OS handed the app. This module folds the two into the one
// `FlowDesktopBridge` shape, so `host.ts` and every call site behind it are
// unchanged; the web client never depends on Capacitor.
import type { DesktopInfo, FlowDesktopBridge, NotificationRouting } from '@flow/shared';

/** What ShellBoot.java leaves on the window. */
export interface ShellBoot {
  info: Omit<DesktopInfo, 'platform'> & { platform: 'android' };
  secrets: Record<string, string>;
  secretsAvailable: boolean;
  /** The `flow://` link the app was launched with, if any. */
  launchUrl: string | null;
}

/** The slice of the injected Capacitor runtime this adapter touches. */
interface FlowShellPlugin {
  secretSet(o: { key: string; value: string }): Promise<void>;
  secretDelete(o: { key: string }): Promise<void>;
  openExternal(o: { url: string }): Promise<void>;
  addListener(event: 'deepLink', cb: (data: { url: string }) => void): Promise<{ remove(): Promise<void> }> | { remove(): Promise<void> };
}
/** The one push-plugin event this adapter listens to (pushAndroid.ts owns
 * registration): a tap on a notification in the tray. */
interface PushPluginEvents {
  addListener(
    event: 'pushNotificationActionPerformed',
    cb: (action: { notification?: { data?: unknown } }) => void,
  ): Promise<{ remove(): Promise<void> }> | { remove(): Promise<void> };
}
interface CapacitorRuntime {
  Plugins?: { FlowShell?: FlowShellPlugin; PushNotifications?: Partial<PushPluginEvents> };
}

/** FCM data is string-only; a tap carries the routing keys the server's
 * payload builder put there, plus the routing id the device registered with.
 * Anything short of a complete route is not a click the app can act on. */
export function routingFromPushData(data: unknown): NotificationRouting | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const str = (k: string) => (typeof d[k] === 'string' && d[k] ? (d[k] as string) : null);
  const routingId = str('routingId');
  const workspaceId = str('workspaceId');
  const channelId = str('channelId');
  const messageId = str('messageId');
  const notificationId = str('notificationId');
  if (!routingId || !workspaceId || !channelId || !messageId || !notificationId) return null;
  return { routingId, workspaceId, channelId, messageId, threadRootId: str('threadRootId'), notificationId };
}

type ShellWindow = {
  flowShellBoot?: ShellBoot;
  Capacitor?: CapacitorRuntime;
  document?: Document;
};

/** The bridge, or null when this page is not inside the Android shell. */
export function androidBridge(win: ShellWindow | undefined = typeof window === 'undefined' ? undefined : (window as unknown as ShellWindow)): FlowDesktopBridge | null {
  const boot = win?.flowShellBoot;
  const plugin = win?.Capacitor?.Plugins?.FlowShell;
  if (!boot || !plugin || typeof plugin.secretSet !== 'function') return null;
  const doc = typeof document === 'undefined' ? undefined : document;

  // -- secrets: the boot snapshot, mirrored; writes go to the encrypted store.
  const mirror = new Map<string, string>(Object.entries(boot.secrets ?? {}));
  const secrets: FlowDesktopBridge['secrets'] = {
    available: boot.secretsAvailable === true,
    get: (key) => mirror.get(key) ?? null,
    set: (key, value) => { mirror.set(key, value); void plugin.secretSet({ key, value }).catch(() => {}); },
    delete: (key) => { mirror.delete(key); void plugin.secretDelete({ key }).catch(() => {}); },
  };

  // -- links: the launch link is replayed to the first listener, like the
  // desktop's queued links; later ones arrive as plugin events (retained by
  // the shell until a listener is up).
  let launch: string | null = boot.launchUrl ?? null;
  const links: FlowDesktopBridge['links'] = {
    openExternal: (url) => { void plugin.openExternal({ url }).catch(() => {}); },
    onDeepLink: (listener) => {
      const first = launch;
      launch = null;
      if (first) queueMicrotask(() => listener(first));
      const handle = Promise.resolve(plugin.addListener('deepLink', (data) => {
        if (data && typeof data.url === 'string' && data.url !== first) listener(data.url);
      }));
      return () => { void handle.then((h) => h.remove()).catch(() => {}); };
    },
  };

  // -- window: on a phone "focused" is "in the foreground", which is page
  // visibility. The title is the document's; there is no window chrome.
  const win_: FlowDesktopBridge['window'] = {
    isFocused: () => !doc || doc.visibilityState === 'visible',
    onFocusChange: (listener) => {
      if (!doc) return () => {};
      const on = () => listener(doc.visibilityState === 'visible');
      doc.addEventListener('visibilitychange', on);
      return () => doc.removeEventListener('visibilitychange', on);
    },
    setTitle: (title) => { if (doc) doc.title = title; },
  };

  // -- notifications and badge: the OS shows pushes itself (ANDROID.md phase
  // 3), so in-app banners are not the shell's to draw. A tap on one is the
  // bridge's click, as on desktop: the push plugin reports it (retained by
  // Capacitor across a cold start), and a click that arrives before the app
  // registers its listener is kept and replayed, like a deep link. No
  // launcher badge API in a WebView.
  const clickListeners = new Set<(routing: NotificationRouting) => void>();
  const queuedClicks: NotificationRouting[] = [];
  const push = win?.Capacitor?.Plugins?.PushNotifications;
  if (push && typeof push.addListener === 'function') {
    void Promise.resolve(push.addListener('pushNotificationActionPerformed', ({ notification }) => {
      const routing = routingFromPushData(notification?.data);
      if (!routing) return;
      if (clickListeners.size === 0) { queuedClicks.push(routing); return; }
      for (const listener of Array.from(clickListeners)) listener(routing);
    })).catch(() => {});
  }
  const notifications: FlowDesktopBridge['notifications'] = {
    show: () => {},
    onClick: (listener) => {
      clickListeners.add(listener);
      for (const routing of queuedClicks.splice(0)) listener(routing);
      return () => { clickListeners.delete(listener); };
    },
    clearDelivered: () => {},
  };

  return {
    info: { ...boot.info, platform: 'android' },
    secrets,
    links,
    window: win_,
    zoom: { get: () => 0, set: () => {} },
    notifications,
    badge: { set: () => {} },
  };
}
