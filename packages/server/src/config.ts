import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load the repo-root .env (Cloudflare credentials etc.) if present. Real env
// vars take precedence — loadEnvFile never overrides existing process.env.
const rootEnv = path.resolve(pkgRoot, '..', '..', '.env');
if (fs.existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export const config = {
  get serverDisplayName(): string { return process.env.FLOW_SERVER_NAME ?? 'Flow'; },
  /** The Slack connector this deployment offers, advertised to clients that
   * cannot be built with it baked in (the native apps). The web build reads
   * the same value at build time as VITE_SLACK_CONNECTOR_ORIGIN. */
  get slackConnectorOrigin(): string | null {
    const raw = (process.env.SLACK_CONNECTOR_ORIGIN ?? process.env.VITE_SLACK_CONNECTOR_ORIGIN ?? '').trim();
    return raw.startsWith('https://') ? raw.replace(/\/+$/, '') : null;
  },
  get allowedWebOrigins(): string[] {
    return (process.env.FLOW_ALLOWED_WEB_ORIGINS ?? '').split(',').map(v => v.trim()).filter(Boolean);
  },
  get handoffReturnUrls(): string[] {
    return (process.env.FLOW_HANDOFF_RETURN_URLS ?? '').split(',').map(v => v.trim()).filter(Boolean);
  },
  get registrationEnabled(): boolean { return process.env.FLOW_REGISTRATION_ENABLED !== '0'; },
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://flow:flow_dev@localhost:5442/flow',
  natsUrl: process.env.NATS_URL ?? 'nats://127.0.0.1:4222',
  /** Subject namespace for this deployment on a shared NATS (see bus.ts).
   * Empty by default: every subject stays exactly as it has always been.
   * One NATS token — letters, digits, `-` and `_`; anything else is dropped
   * rather than allowed to inject a wildcard or a subject separator. */
  get busPrefix(): string {
    return (process.env.FLOW_BUS_PREFIX ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  },
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1', // local server only in phase 1
  /** Sealed data-key file for local dev (KMS stand-in). Auto-created on first boot, chmod 600. */
  get dataKeyFile(): string {
    return process.env.FLOW_DATA_KEY_FILE ?? path.join(pkgRoot, '.keys', 'data.key.json');
  },
  /** Raw base64 data key override (tests/CI). Takes precedence over the file. */
  get dataKeyInline(): string | undefined {
    return process.env.FLOW_DATA_KEY;
  },
  inviteUrlBase: process.env.INVITE_URL_BASE ?? 'flow://invite/',
  sessionTtlDays: 30,
  inviteTtlDays: 7,
  // ---- email (verification + password reset) -------------------
  /** 'dev' logs + writes emails to emailOutboxDir; 'cloudflare' sends for real (deploy). */
  get emailDriver(): 'dev' | 'cloudflare' {
    return process.env.FLOW_EMAIL_DRIVER === 'cloudflare' ? 'cloudflare' : 'dev';
  },
  get emailFrom(): string {
    return process.env.FLOW_EMAIL_FROM ?? 'noreply@mail.freeflow.im';
  },
  /**
   * Display name paired with `emailFrom` on community broadcasts (#493), so an
   * announcement arrives from "Free Flow" rather than a naked noreply address.
   * Auth mail keeps the bare address — a verification link is transactional and
   * a friendly name there just invites spoofing complaints.
   */
  get emailFromName(): string {
    return process.env.FLOW_EMAIL_FROM_NAME ?? 'Free Flow';
  },
  get cloudflareAccountId(): string | undefined {
    return process.env.CLOUDFLARE_ACCOUNT_ID;
  },
  get cloudflareApiToken(): string | undefined {
    return process.env.CLOUDFLARE_API_KEY;
  },
  /** Dev driver drops each sent email here as a JSON file (gitignored). */
  get emailOutboxDir(): string {
    return process.env.FLOW_EMAIL_OUTBOX ?? path.join(pkgRoot, '.emails');
  },
  // ---- push (APNs) ---------------------------------------------
  /** 'dev' logs + writes each push to pushOutboxDir; 'apns' talks to Apple (#250). */
  get pushDriver(): 'dev' | 'apns' {
    return process.env.FLOW_PUSH_DRIVER === 'apns' ? 'apns' : 'dev';
  },
  /** base64 of the .p8 APNs Auth Key. */
  get apnsKey(): string | undefined {
    return process.env.FLOW_APNS_KEY;
  },
  /** 10-char key id that names the .p8 above. */
  get apnsKeyId(): string | undefined {
    return process.env.FLOW_APNS_KEY_ID;
  },
  get apnsTeamId(): string | undefined {
    return process.env.FLOW_APNS_TEAM_ID;
  },
  /** APNs topic — the app's bundle id. A device's own bundleId wins over this. */
  get apnsTopic(): string {
    return process.env.FLOW_APNS_TOPIC ?? 'im.freeflow.app';
  },
  /** Fallback APNs environment; the per-device `environment` column wins over it. */
  get apnsEnv(): 'sandbox' | 'production' {
    return process.env.FLOW_APNS_ENV === 'production' ? 'production' : 'sandbox';
  },
  // ---- push (FCM, Android — docs/design/ANDROID.md phase 3) -----
  /**
   * The Firebase service-account key that lets this server send to Android
   * devices: a path to the JSON file, the JSON itself, or its base64. Set =
   * android rows go through the FCM driver; unset = the dev driver, like an
   * unset FLOW_PUSH_DRIVER for iOS. Parsed at boot and fails loudly if it is
   * not a service-account key, for the same reason the APNs driver does.
   */
  get fcmServiceAccount(): { project_id: string; client_email: string; private_key: string } | undefined {
    const raw = process.env.FLOW_FCM_SERVICE_ACCOUNT;
    if (!raw) return undefined;
    const trimmed = raw.trim();
    const text = trimmed.startsWith('{')
      ? trimmed
      : fs.existsSync(trimmed)
        ? fs.readFileSync(trimmed, 'utf8')
        : Buffer.from(trimmed, 'base64').toString('utf8');
    const j = JSON.parse(text) as { project_id?: string; client_email?: string; private_key?: string };
    if (!j.project_id || !j.client_email || !j.private_key) {
      throw new Error('FLOW_FCM_SERVICE_ACCOUNT is not a Firebase service-account key');
    }
    return { project_id: j.project_id, client_email: j.client_email, private_key: j.private_key };
  },
  /** Dev driver drops each push here as a simctl-ready JSON file (gitignored). */
  get pushOutboxDir(): string {
    return process.env.FLOW_PUSH_OUTBOX ?? path.join(pkgRoot, '.push');
  },
  /**
   * Does the message text ride along in the push? (PUSH_APNS.md § "Open
   * questions for the operator", 1.) Bodies are AES-GCM encrypted at rest, so
   * including it hands the plaintext to Apple in transit — the spec's option
   * (a), best UX, and what the operator ruled on 2026-09-01 (decision log).
   * `FLOW_PUSH_BODY_PREVIEW=0` is option (b): the title still says who, and
   * nothing the user wrote leaves the server. One switch on purpose, so a
   * workspace that cares costs an env var rather than a rewrite.
   */
  get pushBodyPreview(): boolean {
    const v = process.env.FLOW_PUSH_BODY_PREVIEW;
    return !(v === '0' || v === 'false');
  },
  /** Base URL the web client is served from — used in emailed links. */
  get webUrlBase(): string {
    return process.env.FLOW_WEB_URL ?? 'http://127.0.0.1:8787';
  },
  /**
   * Hostnames retired in favour of `webUrlBase`. A request arriving on one of
   * these 302s to the same path on the canonical host — the retirement window
   * after a re-domain (phase17 §13), when the old hostname still resolves to
   * this service and we want browsers and installed clients to migrate
   * themselves before the DNS records are dropped.
   *
   * Comma-separated; empty (the default) disables the hook entirely, so this
   * costs a self-hosted deployment nothing. Doing it here rather than at the
   * CDN keeps the old hostname on DNS-only, which is what lets the platform
   * keep renewing its own certificate for it.
   */
  get redirectFromHosts(): readonly string[] {
    return (process.env.FLOW_REDIRECT_FROM_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  },
  /**
   * Phase 11 §3: consult robots.txt before unfurling?
   *
   * DEFAULT OFF, by operator ruling 2026-07-22 (see decision_log.md). The spec
   * says to honor robots, but every large social site blanket-disallows
   * unknown agents (`User-agent: *` / `Disallow: /`), so Instagram, X and
   * Facebook links — the ones users most want previewed — would never unfurl.
   * The ruling is that a link a user explicitly pasted is not crawling.
   *
   * Set FLOW_UNFURL_RESPECT_ROBOTS=1 to restore spec behaviour; that is the
   * lever to pull if our egress IP starts getting blocked or rate-limited.
   */
  get unfurlRespectRobots(): boolean {
    return process.env.FLOW_UNFURL_RESPECT_ROBOTS === '1';
  },
  // ---- Google Sign-In (phase 16) -------------------------------
  /** OAuth 2.0 **Web** client id — also the `aud` we require on ID tokens. One
   * client serves web today and is what native will target (phase16 §9). */
  get googleClientId(): string | undefined {
    return process.env.GOOGLE_CLIENT_ID || undefined;
  },
  /** Only needed if we ever adopt the auth-code flow (phase16 §8). Unused by
   * the ID-token flow — kept so adding it later isn't a redesign. */
  get googleClientSecret(): string | undefined {
    return process.env.GOOGLE_CLIENT_SECRET || undefined;
  },
  /** Google sign-in is available. When false the endpoint 503s and clients hide the button. */
  get googleEnabled(): boolean {
    return !!process.env.GOOGLE_CLIENT_ID;
  },
  /**
   * Phase 16 §7 `hd` hardening: require the setter's Google account to be a
   * Workspace account on the domain before they can open a workspace to it.
   * This blocks a personal Gmail that merely *spells* a corporate address.
   * Set FLOW_GOOGLE_REQUIRE_HD=0 for orgs on a custom domain without Google
   * Workspace (the consumer denylist still applies either way).
   */
  get googleRequireHostedDomain(): boolean {
    return process.env.FLOW_GOOGLE_REQUIRE_HD !== '0';
  },
  // ---- Sign in with Apple --------------------------------------
  /** The iOS app's bundle id — the `aud` we require on Apple identity tokens
   * from the native flow (Apple uses the bundle id as the client id there). */
  get appleBundleId(): string | undefined {
    return process.env.APPLE_BUNDLE_ID || undefined;
  },
  /** Sign in with Apple is available. When false the endpoint 503s and clients hide the button. */
  get appleEnabled(): boolean {
    return !!process.env.APPLE_BUNDLE_ID;
  },
  verifyTokenTtlHours: 48,
  resetTokenTtlMinutes: 60,
  signinTokenTtlMinutes: 15, // passwordless sign-in link — short-lived by design
  /** Local blob-store directory (phase2.md §3); object storage swaps in behind the same interface in phase 3. */
  get fileDir(): string {
    return process.env.FLOW_FILE_DIR ?? path.join(pkgRoot, '.files');
  },
  // ---- blob storage driver -------------------------------------
  /** 'local' stores under fileDir; 'r2' stores in Cloudflare R2 (S3 API) and enables presigned direct upload/download. */
  get blobDriver(): 'local' | 'r2' {
    return process.env.FLOW_BLOB_DRIVER === 'r2' ? 'r2' : 'local';
  },
  get r2Bucket(): string {
    return process.env.FLOW_R2_BUCKET ?? 'flow-files';
  },
  get r2Endpoint(): string | undefined {
    return process.env.CLOUDFLARE_S3_ENDPOINT;
  },
  get r2AccessKeyId(): string | undefined {
    return process.env.CLOUDFLARE_ACCESS_KEY_ID;
  },
  get r2SecretAccessKey(): string | undefined {
    return process.env.CLOUDFLARE_SECRET_ACCESS_KEY;
  },
  presignPutTtlSeconds: 15 * 60, // client has this long to finish a direct upload
  presignGetTtlSeconds: 5 * 60, // downloads: minted per-request after the access check
  /** Cap for the presigned direct-upload path (R2 streams, server never buffers).
   * Raised from 20 MB once blobs moved off the box (2026-07-21 ruling: video sharing). */
  get maxFileBytes(): number {
    return Number(process.env.FLOW_MAX_FILE_MB ?? 500) * 1024 * 1024;
  },
  /** Cap for server-buffered uploads (legacy multipart, Slack-compat files.upload,
   * avatars): these paths hold the whole file in memory, so they keep the old limit. */
  maxServerUploadBytes: 20 * 1024 * 1024,
  /** Images larger than this get no thumbnail/dimensions — complete-time sidecar
   * generation would pull the whole object into server memory. */
  thumbSourceMaxBytes: 32 * 1024 * 1024,
  /** TTL for GET /v1/files/:id/url (in-place streaming, e.g. <video src>): longer
   * than the 302 TTL so playback/seeking keeps working through a long video. */
  streamUrlTtlSeconds: 60 * 60,
  maxFilesPerMessage: 10,
  thumbMaxPx: 512,
  avatarPx: 512,
  orphanFileTtlHours: 24, // unattached files older than this are swept (decision log ruling 5)
  // ---- voice huddle (Phase 1, LiveKit Cloud) ---------------------
  get livekitApiKey(): string | undefined {
    return process.env.LIVEKIT_API_KEY || undefined;
  },
  get livekitApiSecret(): string | undefined {
    return process.env.LIVEKIT_API_SECRET || undefined;
  },
  /** Project URL, e.g. https://<project>.livekit.cloud. */
  get livekitUrl(): string | undefined {
    return process.env.LIVEKIT_URL || undefined;
  },
  /** Huddles are available. When false, join/leave 503 and clients hide the affordance. */
  get livekitEnabled(): boolean {
    return !!(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET && process.env.LIVEKIT_URL);
  },
  /** No token-refresh path exists yet (decision log 2026-08-20), so this errs long. */
  livekitTokenTtl: '24h',
} as const;
