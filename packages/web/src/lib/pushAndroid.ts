// Push registration in the Android shell (docs/design/ANDROID.md phase 3).
//
// The shell ships Capacitor's PushNotifications plugin (FCM underneath); this
// module reaches it through the runtime object Capacitor injects, the way
// hostAndroid.ts reaches the shell's own plugin, so the web client depends on
// nothing native. Two jobs: create the per-kind notification channels the
// server's FCM driver names (one list, @flow/shared), and register this
// device's token with a Flow connection at sign-in — forgetting it at
// sign-out, while the session can still authorize the request. A tap on a
// notification is not this module's: it reaches the app through the host
// seam (`host.notifications.onClick`, wired in hostAndroid.ts), the same path
// a desktop banner click takes.
//
// Registration is per connection, like the macOS SyncEngine's: the routing
// id is the connection id, which is what the main pane compares a click's
// routing against; `badgeMode: 'omit'` because a multi-server client owns
// its own badge. Only Flow connections register — a Slack team has no push.
import { ANDROID_NOTIFICATION_CHANNELS, type AndroidNotificationChannel } from '@flow/shared';
import type { ConnectionRuntime } from './connectionRuntime';

const TOKEN_KEY = 'pushToken';

interface ListenerHandle {
  remove(): Promise<void> | void;
}

/** The slice of Capacitor's PushNotifications plugin this module uses. */
export interface PushPlugin {
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  createChannel(channel: AndroidNotificationChannel): Promise<void>;
  addListener(event: 'registration', cb: (token: { value: string }) => void): Promise<ListenerHandle> | ListenerHandle;
}

interface CapacitorRuntime {
  Plugins?: { PushNotifications?: Partial<PushPlugin> };
}

/** The plugin proxy, or `null` outside the shell (or in a shell without it). */
export function pushPlugin(win: { Capacitor?: CapacitorRuntime } | undefined = typeof window === 'undefined' ? undefined : (window as unknown as { Capacitor?: CapacitorRuntime })): PushPlugin | null {
  const p = win?.Capacitor?.Plugins?.PushNotifications;
  return p && typeof p.register === 'function' && typeof p.addListener === 'function' ? (p as PushPlugin) : null;
}

/** The slice of a connection this module touches, so a test can fake it. */
export type PushRuntime = Pick<ConnectionRuntime, 'connectionId' | 'provider' | 'read' | 'write'> & {
  api<T>(method: string, path: string, body?: unknown): Promise<T>;
};

/**
 * Ask for permission, create the channels, register with FCM, and hand the
 * token to this connection's server. Called after sign-in; re-registering on
 * every launch is deliberate, as it is on iOS — tokens rotate silently.
 * Silent on failure: a device that fails to register still gets everything
 * over the socket. Returns the teardown. A no-op outside the shell.
 */
export async function enablePush(runtime: PushRuntime, plugin: PushPlugin | null = pushPlugin()): Promise<() => void> {
  if (!plugin || runtime.provider !== 'flow') return () => {};
  await Promise.all(ANDROID_NOTIFICATION_CHANNELS.map((c) => plugin.createChannel(c).catch(() => {})));
  const perm = await plugin.requestPermissions().catch(() => ({ receive: 'denied' }));
  if (perm.receive !== 'granted') return () => {};
  const registration = await plugin.addListener('registration', ({ value }) => {
    runtime.write(TOKEN_KEY, value);
    void runtime
      .api('POST', '/v1/me/devices', { token: value, platform: 'android', routingId: runtime.connectionId, badgeMode: 'omit' })
      .catch((err: unknown) => console.warn(`push registration failed: ${(err as Error).message}`));
  });
  await plugin.register().catch(() => {});
  return () => { void registration.remove(); };
}

/** Sign-out: the server forgets this device, then so do we. Must run while
 * the session is still valid. Idempotent; nothing stored means nothing to do. */
export async function disablePush(runtime: PushRuntime, timeoutMs = 4000): Promise<void> {
  const token = runtime.read(TOKEN_KEY);
  if (!token) return;
  runtime.write(TOKEN_KEY, null);
  const request = runtime
    .api('DELETE', `/v1/me/devices/${encodeURIComponent(token)}?routingId=${encodeURIComponent(runtime.connectionId)}`)
    .catch(() => {});
  // Sign-out must not wait on a server that never answers.
  await Promise.race([request, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}
