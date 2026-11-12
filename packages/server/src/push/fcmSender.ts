// FCM HTTP v1 driver (docs/design/ANDROID.md phase 3): the Android door beside
// the APNs one, behind the same PushSender seam. It takes the APNs-shaped
// payload the outbox already builds and translates it on the way out, so the
// decisions — who gets a push, what it says, whether it rings — stay in one
// place (pushOutbox.ts + payload.ts) and only the wire format differs.
//
// Auth is a Google service account: a short-lived OAuth access token minted
// from its private key (google-auth-library, already a dependency for Google
// sign-in) and sent as a bearer. Nothing here talks to Firebase's SDKs.
import { JWT } from 'google-auth-library';
import type { ApnsHeaders, ApnsPayload, PushDevice, PushResult, PushSender } from './types.js';

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const FCM_ENDPOINT = 'https://fcm.googleapis.com';

/**
 * Android notification channels, by NotificationKind. The app creates these
 * at boot (packages/web/src/lib/push.ts) — a message naming a channel that
 * does not exist on the device falls back to the system default, so the two
 * lists must agree. Channels are what give the user per-kind mute controls in
 * system settings for free (ANDROID.md phase 3).
 */
export const ANDROID_CHANNELS: Record<number, string> = {
  0: 'mentions',
  1: 'dms',
  2: 'threads',
  3: 'channels',
  4: 'reactions',
  5: 'invites',
};
export const DEFAULT_CHANNEL = 'general';

/** The three fields of a Firebase service-account key this driver uses. */
export interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface FcmSenderOptions {
  serviceAccount?: FcmServiceAccount;
  /** Override the bearer-token source, so a test needs no key. */
  accessToken?: () => Promise<string>;
  /** Override Google's host — tests point this at a local server. */
  endpoint?: string;
  /** Project id when `accessToken` replaces the service account. */
  projectId?: string;
  fetchImpl?: typeof fetch;
  log?: { warn(o: unknown, msg: string): void; error(o: unknown, msg: string): void };
}

/** FCM v1 `messages:send` body — only the fields this driver emits. */
export interface FcmMessage {
  message: {
    token: string;
    notification?: { title: string; body?: string };
    data: Record<string, string>;
    android: {
      priority: 'HIGH' | 'NORMAL';
      ttl?: string;
      collapse_key?: string;
      notification?: {
        channel_id: string;
        sound?: string;
        notification_count?: number;
      };
    };
  };
}

/**
 * APNs payload → FCM message. Pure, so the translation is testable byte for
 * byte without a network.
 *
 * - `aps.alert` becomes the system-tray notification; a subtitle has no slot
 *   on Android, so it leads the body ("#general — standup in 5?").
 * - Every custom key (workspaceId, channelId, messageId, threadRootId,
 *   notificationId, kind) rides in `data`, stringified — FCM data is
 *   string-only — plus the badge, so a tap can route exactly as iOS does.
 * - `kind` picks the notification channel; a payload without one (a badge-only
 *   or muted push) sends no notification at all, only data, at normal
 *   priority: nothing to display, no reason to wake the radio.
 * - `expiration` (unix seconds) becomes a relative `ttl`; `collapseId` maps to
 *   `collapse_key` for the same replace-not-stack semantics.
 */
export function toFcmMessage(
  device: PushDevice,
  payload: ApnsPayload,
  opts: ApnsHeaders,
  now = Date.now(),
): FcmMessage {
  const { aps, ...custom } = payload;
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(custom)) {
    if (value === undefined || value === null) continue;
    data[key] = typeof value === 'string' ? value : String(value);
  }
  if (aps.badge !== undefined) data.badge = String(aps.badge);

  const kindRaw = custom.kind;
  const kind = typeof kindRaw === 'number' ? kindRaw : typeof kindRaw === 'string' ? Number(kindRaw) : NaN;
  const channel = Number.isInteger(kind) ? (ANDROID_CHANNELS[kind] ?? DEFAULT_CHANNEL) : DEFAULT_CHANNEL;

  const android: FcmMessage['message']['android'] = {
    priority: opts.priority === 5 ? 'NORMAL' : 'HIGH',
  };
  if (opts.expiration !== undefined) {
    android.ttl = `${Math.max(0, opts.expiration - Math.floor(now / 1000))}s`;
  }
  if (opts.collapseId) android.collapse_key = opts.collapseId;

  const message: FcmMessage['message'] = { token: device.token, data, android };
  const alert = aps.alert;
  if (alert?.title) {
    const body = [alert.subtitle, alert.body].filter((s): s is string => !!s).join(' — ');
    message.notification = { title: alert.title, ...(body ? { body } : {}) };
    android.notification = {
      channel_id: channel,
      ...(aps.sound ? { sound: 'default' } : {}),
      ...(aps.badge !== undefined ? { notification_count: aps.badge } : {}),
    };
  }
  return { message };
}

/**
 * FCM's answer → the two facts the outbox acts on. UNREGISTERED (404) is the
 * one that retires a token — the app is gone or the token rotated — the exact
 * analogue of APNs 410. A 400 that names the token is the same thing spelled
 * differently; any other 400 is our payload's fault and no retry will fix it.
 * 429 and 5xx are FCM's own weather.
 */
export function classifyFcmFailure(status: number, bodyText: string): Omit<Extract<PushResult, { ok: false }>, 'ok'> {
  const code = fcmErrorCode(bodyText);
  const reason = code ? `${status} ${code}` : `${status}`;
  if (status === 404 && code === 'UNREGISTERED') return { status, reason, retryable: false, disableDevice: true };
  if (status === 400 && /registration token|not a valid FCM registration token/i.test(bodyText)) {
    return { status, reason, retryable: false, disableDevice: true };
  }
  if (status === 429 || status >= 500) return { status, reason, retryable: true, disableDevice: false };
  return { status, reason, retryable: false, disableDevice: false };
}

/** The `errorCode` FCM puts in `error.details[]`, else the gRPC `status` string. */
function fcmErrorCode(bodyText: string): string | undefined {
  try {
    const j = JSON.parse(bodyText) as {
      error?: { status?: string; details?: Array<{ errorCode?: string }> };
    };
    return j.error?.details?.find((d) => d.errorCode)?.errorCode ?? j.error?.status;
  } catch {
    return undefined;
  }
}

const consoleLog = {
  warn: (o: unknown, msg: string) => console.warn(`[push:fcm] ${msg}`, o),
  error: (o: unknown, msg: string) => console.error(`[push:fcm] ${msg}`, o),
};

export class FcmHttpV1PushSender implements PushSender {
  private readonly accessToken: () => Promise<string>;
  private readonly projectId: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: NonNullable<FcmSenderOptions['log']>;

  constructor(opts: FcmSenderOptions = {}) {
    this.endpoint = (opts.endpoint ?? FCM_ENDPOINT).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? consoleLog;
    if (opts.accessToken) {
      this.accessToken = opts.accessToken;
      this.projectId = opts.projectId ?? opts.serviceAccount?.project_id ?? 'test';
    } else {
      // Fail at construction, not at the first notification: a deploy with a
      // broken key should be obvious while someone is still watching the logs.
      const sa = opts.serviceAccount;
      if (!sa?.project_id || !sa.client_email || !sa.private_key) {
        throw new Error('FCM driver needs a service account with project_id, client_email and private_key');
      }
      const client = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [FCM_SCOPE] });
      this.projectId = sa.project_id;
      this.accessToken = async () => {
        const t = await client.getAccessToken(); // cached by the library until expiry
        if (!t.token) throw new Error('FCM: no access token from the service account');
        return t.token;
      };
    }
  }

  async send(device: PushDevice, payload: ApnsPayload, opts: ApnsHeaders): Promise<PushResult> {
    let bearer: string;
    try {
      bearer = await this.accessToken();
    } catch (err) {
      this.log.error({ err: String(err) }, 'could not mint an FCM access token');
      return { ok: false, reason: `fcm auth: ${String(err)}`, retryable: true, disableDevice: false };
    }
    const res = await this.fetchImpl(`${this.endpoint}/v1/projects/${this.projectId}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(toFcmMessage(device, payload, opts)),
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    const failure = classifyFcmFailure(res.status, text);
    if (res.status === 401 || res.status === 403) {
      this.log.error({ status: res.status, body: text.slice(0, 300) }, 'FCM rejected our credentials');
    } else if (!failure.disableDevice && !failure.retryable) {
      this.log.warn({ status: res.status, body: text.slice(0, 300) }, 'FCM rejected a push permanently');
    }
    return { ok: false, ...failure };
  }
}
