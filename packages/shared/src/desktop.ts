// The desktop (Electron) client contract (docs/specs/desktop-electron.md).
//
// The desktop app bundles the web client and serves it from a privileged
// custom scheme, so every request it makes carries `Origin: app://flow`. The
// server and the Slack connector accept that origin as a client that is
// neither a browser page (it has no hostile-page threat model) nor a native
// app (it does send an Origin, and Chromium enforces CORS on the answer).
//
// `FlowDesktopBridge` is what the shell's preload exposes to the renderer as
// `window.flowDesktop`. The web client never touches it directly: it goes
// through `packages/web/src/lib/host.ts`, whose browser fallback has the same
// shape. Everything here is typed once so both sides compile against it.

/** The renderer's origin inside the desktop shell. */
export const DESKTOP_ORIGIN = 'app://flow';

/** The URL scheme the desktop app registers on every platform. */
export const DESKTOP_URL_SCHEME = 'flow';

/** The Android shell's page origin (docs/design/ANDROID.md; `hostname` in
 * apps/android/capacitor.config.ts). Capacitor serves the bundled client from
 * a local server at this name: `.localhost` is reserved to loopback (RFC
 * 6761), so nothing on the network can be it. Admitted as a bundled client
 * the way DESKTOP_ORIGIN is. */
export const ANDROID_ORIGIN = 'https://flow.localhost';

/** Origins that are a bundled client — the desktop shell's renderer and the
 * Android shell's WebView — rather than a page some site served: admitted
 * without operator configuration, but they send an Origin and Chromium
 * enforces CORS on the answer, so they still get the headers. */
export function isBundledClientOrigin(origin: string | undefined | null): boolean {
  return origin === DESKTOP_ORIGIN || origin === ANDROID_ORIGIN;
}

/** The desktop platforms, plus the Android shell, which exposes the same
 * bridge (apps/android/README.md). */
export type DesktopPlatform = 'darwin' | 'win32' | 'linux' | 'android';

export interface DesktopInfo {
  platform: DesktopPlatform;
  /** Shell version, shown in About. `0.0.0` in a development run. */
  version: string;
  /** `FLOW_PROFILE`, for the window title and QA fixtures. Null when unset. */
  profile: string | null;
  /** The Flow server baked into this build (`FLOW_SERVER_URL` at build time,
   * overridable at run time in development). */
  defaultServerOrigin: string;
}

/** Credentials live in the OS store (Keychain, DPAPI, libsecret) behind a
 * synchronous in-memory mirror, so the web client's token reads stay
 * synchronous. When the OS store is unavailable, `available` is false and
 * the mirror is memory-only: the session lasts until the app quits and no
 * plaintext token ever lands on disk. */
export interface DesktopSecrets {
  readonly available: boolean;
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface DesktopLinks {
  /** Open an http(s) or mailto URL in the system browser. */
  openExternal(url: string): void;
  /** `flow://…` URLs the OS handed to the app. Links that arrived before the
   * first listener registered are replayed to it. Returns an unsubscribe. */
  onDeepLink(listener: (url: string) => void): () => void;
}

export interface DesktopWindow {
  isFocused(): boolean;
  onFocusChange(listener: (focused: boolean) => void): () => void;
  setTitle(title: string): void;
}

export interface DesktopZoom {
  get(): number;
  set(level: number): void;
}

/** Where a banner leads when clicked — the same keys the macOS app packs
 * into a notification's userInfo (`Banners.swift`). `routingId` is the
 * connection the row belongs to. */
export interface NotificationRouting {
  routingId: string;
  workspaceId: string;
  channelId: string;
  messageId: string;
  threadRootId: string | null;
  /** The notification row, so a click can mark it read. */
  notificationId: string;
}

export interface DesktopNotification {
  /** Notification row id; the shell shows one banner per id. */
  id: string;
  title: string;
  /** The conversation: shown as the macOS subtitle, folded into the title
   * elsewhere. */
  subtitle?: string;
  body: string;
  silent: boolean;
  routing: NotificationRouting;
}

export interface DesktopNotifications {
  show(notification: DesktopNotification): void;
  /** Clicks on banners. A click that arrived before the first listener
   * registered (cold start) is replayed to it. Returns an unsubscribe. */
  onClick(listener: (routing: NotificationRouting) => void): () => void;
  /** Take down every delivered banner for a connection (sign-out). */
  clearDelivered(routingId: string): void;
}

export interface DesktopBadge {
  /** The unread-notifications total across every connection; 0 clears. */
  set(count: number): void;
}

export interface FlowDesktopBridge {
  readonly info: DesktopInfo;
  readonly secrets: DesktopSecrets;
  readonly links: DesktopLinks;
  readonly window: DesktopWindow;
  readonly zoom: DesktopZoom;
  readonly notifications: DesktopNotifications;
  readonly badge: DesktopBadge;
}

declare global {
  interface Window {
    flowDesktop?: FlowDesktopBridge;
  }
}
