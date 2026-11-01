// The ChatGPT plugin server: streamable HTTP MCP at /mcp, OAuth for account linking, and the images documents
// refer to at /img/<id>. Runs beside the app (not inside it) on its own port, sharing the app's data directory.
//
// Environment: PLUGIN_PUBLIC_URL (the https origin ChatGPT reaches this server on), PLUGIN_PORT (default 3012),
// DATA_DIR (the app's, default ./data), GOOGLE_CLIENT_ID/SECRET (the app's; enables "Continue with Google" on
// the sign-in page, with <PLUGIN_PUBLIC_URL>/oauth/google/callback as the redirect URI). PLUGIN_USER_EMAIL
// switches OAuth off and makes every request act as that account (development only).
import '../../server/env.ts';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AuthService } from '../../server/auth.ts';
import { googleFromEnv, GoogleLogin } from '../../server/googleAuth.ts';
import { mailerFromEnv } from '../../server/mail.ts';
import { FileHub } from './files.ts';
import { createPluginServer } from './http.ts';
import type { McpOptions } from './mcp.ts';
import { OAuthServer } from './oauth.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'));
const port = Number(process.env.PLUGIN_PORT ?? 3012);
const publicUrl = process.env.PLUGIN_PUBLIC_URL?.replace(/\/$/, '') || null;
const devEmail = process.env.PLUGIN_USER_EMAIL;
const production = process.env.NODE_ENV === 'production';

if (production && devEmail) {
  console.error('PLUGIN_USER_EMAIL is set: it switches OAuth off and makes every request act as that account. Refusing to start in production; unset it.');
  process.exit(1);
}
if (!publicUrl) console.warn('PLUGIN_PUBLIC_URL is not set: images in files will not load in ChatGPT, and OAuth needs it.');
mkdirSync(dataDir, { recursive: true });
const hub = await FileHub.open({ dataDir, publicUrl });

let oauth: OAuthServer | null = null;
let devUserId: string | undefined;
if (devEmail) {
  devUserId = hub.userIdForEmail(devEmail) ?? undefined;
  if (!devUserId) {
    console.error(`No account with email ${devEmail} in ${dataDir}/app.db. Sign up in the app first, or unset PLUGIN_USER_EMAIL to use OAuth.`);
    process.exit(1);
  }
  console.warn(`Development mode: no OAuth, every request acts as ${devEmail}.`);
} else {
  if (!publicUrl) {
    console.error('OAuth needs PLUGIN_PUBLIC_URL (the issuer). Set it, or set PLUGIN_USER_EMAIL for development mode.');
    process.exit(1);
  }
  const googleOpts = googleFromEnv();
  oauth = new OAuthServer({
    db: new DatabaseSync(path.join(dataDir, 'plugin.db')),
    issuer: publicUrl,
    resource: `${publicUrl}/mcp`,
    auth: new AuthService(hub.db),
    profile: (id) => hub.profile(id),
    google: googleOpts ? new GoogleLogin(googleOpts) : null,
    sendMail: mailerFromEnv((msg) => console.log(msg)),
  });
  console.log(`OAuth on: sign in with ${googleOpts ? 'Google or ' : ''}password; Google redirect URI ${publicUrl}/oauth/google/callback`);
}

const server = createPluginServer({
  hub,
  oauth,
  devUserId,
  publicUrl,
  webDir: path.join(root, 'plugin', 'dist', 'web'),
  production,
  logBodies: !!process.env.PLUGIN_LOG_BODIES,
  mcp: {
    hostedAssets: !!process.env.PLUGIN_HOSTED_ASSETS,
    helloPage: !!process.env.PLUGIN_HELLO,
    legacyMime: !!process.env.PLUGIN_LEGACY_MIME,
    resourceMeta: process.env.PLUGIN_RESOURCE_META as McpOptions['resourceMeta'],
    level: (process.env.PLUGIN_LEVEL as McpOptions['level'] | undefined) ?? 'full',
  },
});

server.listen(port, production ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`Docs plugin for ChatGPT: http://127.0.0.1:${port}/mcp  (public: ${publicUrl ?? 'unset'}, auth: ${oauth ? 'oauth' : `dev as ${devEmail}`})`);
});
