// The push seam's vocabulary (docs/design/PUSH_APNS.md §"Server: 2. The sender
// seam"): one small interface, the device fields a sender needs, the APNs
// payload and header shapes, and the result the outbox worker acts on.
//
// Type-only and dependency-free on purpose, so both the seam (./index.ts) and
// the real driver (./apnsSender.ts) can name them without importing each other.

/**
 * The device columns a sender actually needs. Structural on purpose: the
 * `device_tokens` row type lands with the registry (#245), and any row with
 * these fields satisfies this.
 */
export interface PushDevice {
  /** Client-owned opaque connection/identity route; present means no absolute badge. */
  routingId?: string | null;
  /** APNs device token, hex. */
  token: string;
  /** 'ios' today (macOS later). */
  platform: string;
  /** Wins over config.apnsEnv when the row carries one (the registry's always does). */
  environment?: 'sandbox' | 'production';
  /** APNs topic this token registered under; falls back to config.apnsTopic. */
  bundleId?: string;
}

/** The reserved `aps` dictionary. Apple owns these key names — keep them verbatim. */
export interface ApnsAps {
  alert?: { title?: string; subtitle?: string; body?: string };
  sound?: string;
  badge?: number;
  /** Groups a channel's pushes in Notification Center. */
  'thread-id'?: string;
  'content-available'?: 1;
  'mutable-content'?: 1;
}

/** A whole APNs payload: `aps` plus flat custom keys (#248 owns the custom keys). */
export interface ApnsPayload {
  aps: ApnsAps;
  [key: string]: unknown;
}

/** APNs request headers, camelCased; a driver maps them onto `apns-*` on the wire. */
export interface ApnsHeaders {
  pushType: 'alert' | 'background';
  /** 10 = immediate (alert), 5 = power-considerate (background). */
  priority?: 10 | 5;
  /** Overrides the device's bundleId / config.apnsTopic. */
  topic?: string;
  /** Unix seconds to stop retrying; 0 means deliver once or drop. */
  expiration?: number;
  /** Same id replaces rather than stacks — channelId, for a busy channel. */
  collapseId?: string;
}

/**
 * Outcome of one send. `retryable` and `disableDevice` are the two facts the
 * outbox worker (#247) needs from APNs' status codes, so the seam names them
 * rather than making every caller re-read the table in the spec.
 */
export type PushResult =
  | { ok: true; apnsId?: string }
  | { ok: false; status?: number; reason: string; retryable: boolean; disableDevice: boolean };

export interface PushSender {
  send(device: PushDevice, payload: ApnsPayload, opts: ApnsHeaders): Promise<PushResult>;
}
