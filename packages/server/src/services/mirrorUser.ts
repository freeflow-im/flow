// A user of the suite's directory (the Worker's), known here by the same id, made known here when they are not yet: the
// ChatGPT plugin's sign-in (workspace.ts, handoff) signs people in on this server, whose `users` the directory was
// imported from, so an id that exists here is the same person. One who is new here gets a row with a verified email and
// no usable password, as a provider-first account does (oauthAccounts.ts); an email already here under another id is
// that account (an older one of this server's), and is signed in as it.
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { conflict } from '../lib/errors.js';
import { newToken } from '../lib/tokens.js';

const { users } = schema;

export interface DirectoryUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

/** The id to sign in as, here. */
export async function mirrorUser(user: DirectoryUser): Promise<string> {
  const byId = (await db.select({ id: users.id, deletedAt: users.deletedAt }).from(users).where(eq(users.id, user.id)).limit(1))[0];
  if (byId) {
    if (byId.deletedAt) throw conflict('email_reserved', 'that account has been removed');
    return byId.id;
  }
  const email = user.email.trim().toLowerCase();
  if (!email) throw conflict('email_reserved', 'the account has no email');
  const byEmail = (await db.select({ id: users.id, deletedAt: users.deletedAt, isBot: users.isBot, isAgent: users.isAgent }).from(users).where(eq(users.email, email)).limit(1))[0];
  if (byEmail) {
    if (byEmail.isBot || byEmail.isAgent) throw conflict('email_reserved', 'that email belongs to a bot or agent account');
    if (byEmail.deletedAt) throw conflict('email_reserved', 'that account has been removed');
    return byEmail.id;
  }
  await db.insert(users).values({
    id: user.id,
    email,
    passwordHash: `!directory:${newToken()}`,
    displayName: user.displayName || email.split('@')[0]!,
    avatarUrl: user.avatarUrl,
    emailVerifiedAt: new Date(),
  });
  return user.id;
}
