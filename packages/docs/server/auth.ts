import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { DB } from './db.ts';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 64 };
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;
export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

export interface User {
  id: string;
  email: string;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +n, r: +r, p: +p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateCredentials(email: unknown, password: unknown): string | null {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Please enter a valid email address.';
  if (email.length > 254) return 'Email address is too long.';
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 200) return 'Password is too long.';
  return null;
}

export class AuthService {
  private db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  /**
   * Create an account that still has to verify its email (see createEmailVerification). An unverified account
   * with this email belongs to nobody yet, so signing up again just replaces its password; a verified one is
   * taken ('exists').
   */
  async register(email: string, password: string): Promise<User | 'exists'> {
    const norm = normalizeEmail(email);
    const existing = this.db.prepare('SELECT id, email, email_verified_at FROM users WHERE email = ?').get(norm) as
      | { id: string; email: string; email_verified_at: string | null }
      | undefined;
    if (existing?.email_verified_at) return 'exists';
    const hash = await hashPassword(password);
    if (existing) {
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
      return { id: existing.id, email: existing.email };
    }
    const user: User = { id: randomUUID(), email: norm };
    this.db
      .prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(user.id, user.email, hash, new Date().toISOString());
    return user;
  }

  /** The user for a correct password; 'unverified' when the password is right but the email isn't verified yet. */
  async login(email: string, password: string): Promise<User | 'unverified' | null> {
    const row = this.db.prepare('SELECT id, email, password_hash, email_verified_at FROM users WHERE email = ?').get(normalizeEmail(email)) as
      | { id: string; email: string; password_hash: string; email_verified_at: string | null }
      | undefined;
    if (!row) {
      // Spend comparable time so response timing doesn't reveal whether the account exists.
      await hashPassword(password);
      return null;
    }
    if (!(await verifyPassword(password, row.password_hash))) return null;
    if (!row.email_verified_at) return 'unverified';
    return { id: row.id, email: row.email };
  }

  // --- Email verification -----------------------------------------------------

  /** A fresh one-time verification token to email; earlier ones for the account stop working. */
  createEmailVerification(userId: string): { token: string; expires: Date } {
    this.db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(userId);
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expires = new Date(now.getTime() + VERIFY_TTL_MS);
    this.db
      .prepare('INSERT INTO email_verifications (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), userId, now.toISOString(), expires.toISOString());
    return { token, expires };
  }

  /** The unverified account with this email, if there is one (for sending the link again). */
  unverifiedUser(email: string): User | null {
    const row = this.db.prepare('SELECT id, email FROM users WHERE email = ? AND email_verified_at IS NULL').get(normalizeEmail(email)) as User | undefined;
    return row ?? null;
  }

  /** Mark the account verified with an emailed token. Uses up the token. */
  verifyEmail(token: string): User | null {
    const row = this.db
      .prepare('SELECT u.id, u.email, v.expires_at FROM email_verifications v JOIN users u ON u.id = v.user_id WHERE v.token_hash = ?')
      .get(sha256(token)) as { id: string; email: string; expires_at: string } | undefined;
    if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;
    this.markVerified(row.id);
    return { id: row.id, email: row.email };
  }

  private markVerified(userId: string): void {
    this.db.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').run(new Date().toISOString(), userId);
    this.db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(userId);
  }

  /**
   * Sign in (or up) with a Google account. The Google account id is the durable key; on first sign-in an
   * existing account with the same verified email is linked, otherwise a new one is created.
   */
  loginWithGoogle(identity: { sub: string; email: string; emailVerified: boolean }): User | 'unverified' {
    const bySub = this.db.prepare('SELECT id, email FROM users WHERE google_sub = ?').get(identity.sub) as User | undefined;
    if (bySub) return bySub;
    // Linking by email is only safe when Google vouches for the address.
    if (!identity.emailVerified) return 'unverified';
    const email = normalizeEmail(identity.email);
    const byEmail = this.db.prepare('SELECT id, email, email_verified_at FROM users WHERE email = ?').get(email) as
      | { id: string; email: string; email_verified_at: string | null }
      | undefined;
    if (byEmail) {
      if (!byEmail.email_verified_at) {
        // Whoever set that password never proved they own the address; the Google user just did. The account
        // becomes theirs: the password stops working and any sessions on it are signed out.
        this.db.prepare("UPDATE users SET password_hash = '' WHERE id = ?").run(byEmail.id);
        this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(byEmail.id);
      }
      this.db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(identity.sub, byEmail.id);
      this.markVerified(byEmail.id);
      return { id: byEmail.id, email: byEmail.email };
    }
    const user: User = { id: randomUUID(), email };
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO users (id, email, password_hash, google_sub, email_verified_at, created_at) VALUES (?, ?, '', ?, ?, ?)")
      .run(user.id, user.email, identity.sub, now, now);
    return user;
  }

  createSession(userId: string): { token: string; expires: Date } {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_TTL_MS);
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), userId, now.toISOString(), expires.toISOString());
    return { token, expires };
  }

  userForSession(token: string | undefined): User | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(sha256(token)) as { id: string; email: string; expires_at: string } | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.destroySession(token);
      return null;
    }
    return { id: row.id, email: row.email };
  }

  destroySession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  purgeExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
    this.db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(new Date().toISOString());
    this.db.prepare('DELETE FROM email_verifications WHERE expires_at < ?').run(new Date().toISOString());
  }

  // --- Password reset ---------------------------------------------------------

  /** Start a reset for the account with this email. Returns the one-time token to email, or null if no account. */
  createPasswordReset(email: string): { user: User; token: string; expires: Date } | null {
    const row = this.db.prepare('SELECT id, email FROM users WHERE email = ?').get(normalizeEmail(email)) as User | undefined;
    if (!row) return null;
    // Any earlier link for this account stops working.
    this.db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.id);
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expires = new Date(now.getTime() + RESET_TTL_MS);
    this.db
      .prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), row.id, now.toISOString(), expires.toISOString());
    return { user: row, token, expires };
  }

  /** The account a reset token belongs to, if the token is valid, unused and not expired. */
  userForResetToken(token: string): User | null {
    const row = this.db
      .prepare('SELECT u.id, u.email, r.expires_at, r.used_at FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?')
      .get(sha256(token)) as { id: string; email: string; expires_at: string; used_at: string | null } | undefined;
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) return null;
    return { id: row.id, email: row.email };
  }

  /**
   * Set a new password with a reset token. Uses up the token and signs the account out everywhere. Opening
   * the emailed link also proves the address, so an unverified account becomes verified.
   */
  async resetPassword(token: string, password: string): Promise<User | null> {
    const user = this.userForResetToken(token);
    if (!user) return null;
    const hash = await hashPassword(password);
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    this.markVerified(user.id);
    this.db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(new Date().toISOString(), sha256(token));
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    return user;
  }
}
