// Push seam (docs/design/PUSH_APNS.md §"Server: 2. The sender seam") — mirrors
// the email seam in ../email and the blob-store seam in ../storage: one small
// interface, a dev driver, a real driver, chosen by config. The dev driver logs
// each push and drops the payload as a JSON file in .push/ — in exactly the
// format `xcrun simctl push` accepts, so the artifact that proves the payload
// builder is also the artifact that drives a simulator. No Apple account, no
// private log format.
//
// The vocabulary lives in ./types.ts and the target rules in ./target.ts, both
// re-exported here: this module is still the one import site for the rest of
// the server, but the real driver can name a device without importing the
// factory that builds it.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import { ApnsHttp2PushSender } from './apnsSender.js';
import { FcmHttpV1PushSender } from './fcmSender.js';
import { fitPayload } from './payload.js';
import { apnsEnvFor, apnsTopicFor } from './target.js';
import type { ApnsHeaders, ApnsPayload, PushDevice, PushResult, PushSender } from './types.js';

export { apnsEnvFor, apnsTopicFor };
export type { ApnsAps, ApnsHeaders, ApnsPayload, PushDevice, PushResult, PushSender } from './types.js';
export { ApnsHttp2PushSender } from './apnsSender.js';
export { FcmHttpV1PushSender } from './fcmSender.js';

/**
 * Writes each push to `.push/<stamp>-<token prefix>.json` and logs it.
 *
 * The file is the APNs payload plus one key: `Simulator Target Bundle`, which
 * is how `xcrun simctl push <device> <file>` learns which app to deliver to.
 * That single addition is what makes the artifact runnable as-is —
 * `xcrun simctl push booted .push/<file>` — instead of needing a wrapper.
 * simctl strips the key before delivery; the app sees exactly `aps` and the
 * custom keys.
 */
export class DevPushSender implements PushSender {
  constructor(private readonly dir: string) {}

  async send(device: PushDevice, payload: ApnsPayload, opts: ApnsHeaders): Promise<PushResult> {
    await fs.mkdir(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = device.token.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'notoken';
    const file = path.join(this.dir, `${stamp}-${slug}.json`);
    const topic = apnsTopicFor(device, opts);
    await fs.writeFile(file, `${JSON.stringify({ ...payload, 'Simulator Target Bundle': topic }, null, 2)}\n`);
    const title = payload.aps.alert?.title ?? '';
    console.log(
      `[push:dev] token=${slug}… env=${apnsEnvFor(device)} topic=${topic} type=${opts.pushType}` +
        `${title ? ` title="${title}"` : ''} (${file})`,
    );
    return { ok: true };
  }
}

/**
 * One sender per platform behind one seam (ANDROID.md phase 3): the outbox
 * still calls `send` once per device and never asks what kind of phone it
 * is. A platform nobody configured a driver for gets the fallback.
 */
export class PlatformPushSender implements PushSender {
  constructor(
    private readonly byPlatform: Record<string, PushSender>,
    private readonly fallback: PushSender,
  ) {}

  send(device: PushDevice, payload: ApnsPayload, opts: ApnsHeaders): Promise<PushResult> {
    return (this.byPlatform[device.platform] ?? this.fallback).send(device, payload, opts);
  }

  /** Which driver a platform would get — for the boot log and the tests. */
  driverFor(platform: string): PushSender {
    return this.byPlatform[platform] ?? this.fallback;
  }
}

let sender: PushSender | null = null;

export function pushSender(): PushSender {
  if (!sender) {
    // Constructing a real driver validates its credentials and throws if any
    // is missing — deliberately not caught, so a half-configured deploy is
    // loud instead of silently falling back to writing production pushes into
    // a directory nobody reads.
    const dev = new DevPushSender(config.pushOutboxDir);
    const ios = config.pushDriver === 'apns' ? new ApnsHttp2PushSender() : dev;
    const fcm = config.fcmServiceAccount;
    const android = fcm ? new FcmHttpV1PushSender({ serviceAccount: fcm }) : dev;
    sender = new PlatformPushSender({ ios, android }, dev);
  }
  return sender;
}

/** Apply the registration contract before any transport (including test drivers). */
export async function sendPush(driver: PushSender, device: PushDevice, payload: ApnsPayload, opts: ApnsHeaders): Promise<PushResult> {
  if (!device.routingId) return driver.send(device, payload, opts);
  // Multi-server clients own the aggregate badge. Muted/read corrections
  // have nothing to deliver; never let a background path overwrite it.
  if (!payload.aps.alert) return { ok: true };
  const aps = { ...payload.aps };
  delete aps.badge;
  if (aps['thread-id']) {
    aps['thread-id'] = createHash('sha256').update(JSON.stringify([device.routingId, aps['thread-id']])).digest('hex');
  }
  return driver.send(device, fitPayload({ ...payload, aps, routingId: device.routingId }), opts);
}

/** Tests only: inject a fake or reset the singleton. */
export function _setPushSenderForTests(s: PushSender | null): void {
  sender = s;
}
