// "Continue with Google": OpenID Connect authorization code flow with PKCE. The server holds the pending
// states (10 minutes) and exchanges the code itself, so the client secret never reaches the browser.
import { createHash, randomBytes } from 'node:crypto';

export interface GoogleOptions {
  clientId: string;
  clientSecret: string;
  /** Tests pass a fake. */
  fetch?: typeof fetch;
}

/** What Google tells us about the person who signed in. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
}

export const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/** A problem the user can act on (the message is shown on the sign-in page). */
export class GoogleLoginError extends Error {}

export function googleFromEnv(env: NodeJS.ProcessEnv = process.env): GoogleOptions | undefined {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** Only same-origin paths may be used as the destination after sign-in. */
export function safeNextPath(next: unknown): string {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/';
}

interface Pending {
  verifier: string;
  redirectUri: string;
  next: string;
  /** Started from the desktop app (MCP Docs) in the system browser: the key the app collects the session with. */
  desktop: string | null;
  expires: number;
}

export class GoogleLogin {
  private readonly opts: GoogleOptions;
  private readonly fetchFn: typeof fetch;
  private readonly pending = new Map<string, Pending>();

  constructor(opts: GoogleOptions) {
    this.opts = opts;
    this.fetchFn = opts.fetch ?? fetch;
  }

  /** The consent URL to send the browser to, and the state the callback must bring back. */
  start(redirectUri: string, next: unknown, desktop: string | null = null): { url: string; state: string } {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    this.pending.set(state, { verifier, redirectUri, next: safeNextPath(next), desktop, expires: now + GOOGLE_STATE_TTL_MS });
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.opts.clientId,
      redirect_uri: redirectUri,
      scope: 'openid email',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return { url: url.href, state };
  }

  /** Finish the flow: check the state, trade the code for tokens and ask Google who signed in. */
  async finish(state: string, code: string): Promise<{ identity: GoogleIdentity; next: string; desktop: string | null }> {
    const st = this.pending.get(state);
    this.pending.delete(state);
    if (!st || st.expires < Date.now()) throw new GoogleLoginError('This sign-in link is invalid or has expired. Try again.');

    const tokenRes = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        redirect_uri: st.redirectUri,
        code_verifier: st.verifier,
      }).toString(),
    });
    if (!tokenRes.ok) {
      const detail = (await tokenRes.text()).slice(0, 300);
      if (tokenRes.status === 400 || tokenRes.status === 401) throw new GoogleLoginError('Google rejected the sign-in. Try again.');
      throw new Error(`Google token endpoint returned ${tokenRes.status}: ${detail}`);
    }
    const tokens = (await tokenRes.json()) as { access_token?: string };
    if (!tokens.access_token) throw new Error('Google token response had no access_token');

    const infoRes = await this.fetchFn(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!infoRes.ok) throw new Error(`Google userinfo returned ${infoRes.status}: ${(await infoRes.text()).slice(0, 300)}`);
    const info = (await infoRes.json()) as { sub?: string; email?: string; email_verified?: boolean | string };
    if (!info.sub || !info.email) throw new Error('Google userinfo had no subject or email');
    return {
      identity: { sub: info.sub, email: info.email, emailVerified: info.email_verified === true || info.email_verified === 'true' },
      next: st.next,
      desktop: st.desktop,
    };
  }
}
