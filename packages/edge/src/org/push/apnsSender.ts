// The real APNs driver on Workers: the Node server's (packages/server/src/push/apnsSender.ts) status mapping, over
// `fetch` instead of a pooled `node:http2` session.
//
// APNs speaks only HTTP/2. workerd itself has no HTTP/2 client, so this cannot reach Apple from `wrangler dev`
// (locally the request fails with "Network connection lost", which is a retryable transport failure here); in
// production a Worker's subrequest goes out through Cloudflare's proxy stack, which negotiates HTTP/2 with the origin
// (cloudflare/workerd#4841). The connection pooling the Node driver does by hand is that stack's job here.
import { config } from '../config.js';
import { apnsCredentials, apnsProviderToken, resetApnsProviderToken } from './apnsAuth.js';
import { apnsEnvFor, apnsTopicFor } from './target.js';
import type { ApnsHeaders, ApnsPayload, PushDevice, PushResult, PushSender } from './types.js';

/** Apple's two front doors. Sandbox serves development builds only. */
export const APNS_ORIGINS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

export type ApnsOrigins = Record<'production' | 'sandbox', string>;

/** A request that neither completed nor failed inside this is a transient. */
const REQUEST_TIMEOUT_MS = 10_000;

/** The token is dead: the app was deleted or the token rotated. The device is disabled, never retried. */
const DEAD_TOKEN_REASONS = new Set(['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic']);

/** A request we built wrong: logged and dropped, since every retry would rebuild it the same. */
const OUR_BUG_REASONS = new Set([
  'BadCollapseId', 'PayloadTooLarge', 'BadMessageId', 'BadPriority', 'BadTopic', 'MissingTopic', 'TopicDisallowed',
  'BadExpirationDate', 'BadPushType', 'MissingDeviceToken', 'IdleTimeout',
]);

export interface ApnsSenderOptions {
  /** Override Apple's hosts (tests). */
  origins?: ApnsOrigins;
  /** Override the provider-token signer, so a test needs no .p8. */
  signer?: () => Promise<string>;
  /** The transport; the global fetch by default. */
  fetch?: typeof fetch;
  log?: { warn(o: unknown, msg: string): void; error(o: unknown, msg: string): void };
}

const consoleLog = {
  warn: (o: unknown, msg: string) => console.warn(`[push:apns] ${msg}`, JSON.stringify(o)),
  error: (o: unknown, msg: string) => console.error(`[push:apns] ${msg}`, JSON.stringify(o)),
};

export class ApnsFetchPushSender implements PushSender {
  private readonly origins: ApnsOrigins;
  private readonly signer: () => Promise<string>;
  private readonly fetcher: typeof fetch;
  private readonly log: NonNullable<ApnsSenderOptions['log']>;

  constructor(opts: ApnsSenderOptions = {}) {
    this.origins = opts.origins ?? APNS_ORIGINS;
    this.signer = opts.signer ?? (() => apnsProviderToken());
    this.fetcher = opts.fetch ?? ((input, init) => fetch(input, init));
    this.log = opts.log ?? consoleLog;
    // Fail at construction, not at the first notification.
    if (!opts.signer) apnsCredentials();
  }

  async send(device: PushDevice, payload: ApnsPayload, opts: ApnsHeaders): Promise<PushResult> {
    // The per-device column wins over FLOW_APNS_ENV: a TestFlight build (production APNs) and a development build
    // (sandbox) can be registered at once.
    const env = apnsEnvFor(device);
    const topic = apnsTopicFor(device, opts);
    const headers: Record<string, string> = {
      authorization: `bearer ${await this.signer()}`,
      'content-type': 'application/json',
      'apns-topic': topic,
      'apns-push-type': opts.pushType,
      'apns-priority': String(opts.priority ?? (opts.pushType === 'background' ? 5 : 10)),
    };
    if (opts.expiration !== undefined) headers['apns-expiration'] = String(opts.expiration);
    if (opts.collapseId) headers['apns-collapse-id'] = opts.collapseId;

    let status: number;
    let apnsId: string | null;
    let text: string;
    try {
      const res = await this.fetcher(`${this.origins[env]}/3/device/${device.token}`, {
        method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      apnsId = res.headers.get('apns-id');
      text = await res.text();
    } catch (err) {
      // A dropped connection, a DNS blip, a timeout: always transient.
      return { ok: false, reason: `transport: ${String(err)}`, retryable: true, disableDevice: false };
    }

    if (status === 200) return apnsId ? { ok: true, apnsId } : { ok: true };

    let parsed: string | undefined;
    try { parsed = (JSON.parse(text) as { reason?: string }).reason; } catch { /* kept raw below */ }
    const reason = parsed ?? (text || `HTTP ${status}`);
    const fail = (retryable: boolean, disableDevice: boolean): PushResult => ({ ok: false, status, reason, retryable, disableDevice });

    if (status === 410 || DEAD_TOKEN_REASONS.has(reason)) return fail(false, true);
    if (status === 403) {
      // Our JWT aged past Apple's window (clock skew): re-sign and retry.
      if (reason === 'ExpiredProviderToken') {
        resetApnsProviderToken();
        return fail(true, false);
      }
      // The key, key id or team id is wrong: every device fails the same, so retrying is noise. An operator alarm.
      this.log.error({ reason, keyId: config.apnsKeyId, teamId: config.apnsTeamId, topic, env }, 'APNs rejected the provider token: check FLOW_APNS_KEY / _KEY_ID / _TEAM_ID');
      return fail(false, false);
    }
    if (status === 429 || status >= 500) return fail(true, false);
    if (OUR_BUG_REASONS.has(reason)) {
      this.log.warn({ reason, status, topic, payload }, 'APNs rejected a request we built wrong');
      return fail(false, false);
    }
    this.log.warn({ reason, status, topic, env }, 'APNs returned an unhandled status');
    return fail(false, false);
  }
}
