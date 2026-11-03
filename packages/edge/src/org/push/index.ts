// The push seam, as on the Node server (packages/server/src/push/index.ts): a dev driver and the APNs driver, chosen
// by FLOW_PUSH_DRIVER. A Worker has no disk, so the dev driver logs each push (the line `wrangler dev` shows, which
// test/e2e.mjs reads) and keeps the last few in memory for tests, instead of writing simctl files.
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { ApnsFetchPushSender } from './apnsSender.js';
import { fitPayload } from './payload.js';
import { apnsEnvFor, apnsTopicFor } from './target.js';
import type { ApnsHeaders, ApnsPayload, PushDevice, PushResult, PushSender } from './types.js';

export { apnsEnvFor, apnsTopicFor };
export type { ApnsAps, ApnsHeaders, ApnsPayload, PushDevice, PushResult, PushSender } from './types.js';
export { ApnsFetchPushSender } from './apnsSender.js';

export interface DevPush { device: PushDevice; payload: ApnsPayload; headers: ApnsHeaders; topic: string }

export class DevPushSender implements PushSender {
  /** The most recent pushes, newest last. */
  readonly sent: DevPush[] = [];

  async send(device: PushDevice, payload: ApnsPayload, opts: ApnsHeaders): Promise<PushResult> {
    const topic = apnsTopicFor(device, opts);
    this.sent.push({ device, payload, headers: opts, topic });
    if (this.sent.length > 50) this.sent.shift();
    const slug = device.token.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'notoken';
    const title = payload.aps.alert?.title ?? '';
    console.log(`[push:dev] token=${slug}… env=${apnsEnvFor(device)} topic=${topic} type=${opts.pushType}${title ? ` title="${title}"` : ''} ${JSON.stringify(payload)}`);
    return { ok: true };
  }
}

let sender: PushSender | null = null;

/** The configured driver. The APNs one throws when its credentials are incomplete: loud, rather than pushing nowhere. */
export function pushSender(): PushSender {
  sender ??= config.pushDriver === 'apns' ? new ApnsFetchPushSender() : new DevPushSender();
  return sender;
}

/** Apply the registration contract before any transport (including test drivers). */
export async function sendPush(driver: PushSender, device: PushDevice, payload: ApnsPayload, opts: ApnsHeaders): Promise<PushResult> {
  if (!device.routingId) return driver.send(device, payload, opts);
  // Multi-server clients own the aggregate badge. Muted/read corrections have nothing to deliver; never let a
  // background path overwrite it.
  if (!payload.aps.alert) return { ok: true };
  const aps = { ...payload.aps };
  delete aps.badge;
  if (aps['thread-id']) aps['thread-id'] = createHash('sha256').update(JSON.stringify([device.routingId, aps['thread-id']])).digest('hex');
  return driver.send(device, fitPayload({ ...payload, aps, routingId: device.routingId }), opts);
}

/** Tests only: inject a fake or reset the singleton. */
export function _setPushSenderForTests(s: PushSender | null): void {
  sender = s;
}
