// The directory's tables: everything that has to be found before the organization is known. The Postgres columns of
// the same names, in SQLite: `citext` is COLLATE NOCASE, timestamps are milliseconds since the epoch, token hashes hex.
export const DIRECTORY_MIGRATIONS: string[] = [
  `CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    is_bot INTEGER NOT NULL DEFAULT 0,
    is_agent INTEGER NOT NULL DEFAULT 0,
    sponsor_user_id TEXT,
    agent_username TEXT COLLATE NOCASE,
    agent_key_hash TEXT,
    status_emoji TEXT NOT NULL DEFAULT '',
    status_text TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    notification_prefs TEXT NOT NULL DEFAULT '{}',
    status_suppress_alerts INTEGER NOT NULL DEFAULT 0,
    unfurl_own_links INTEGER NOT NULL DEFAULT 1,
    privacy_mode INTEGER NOT NULL DEFAULT 0,
    email_verified_at INTEGER,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    client_info TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE pending_signups (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX pending_signups_email ON pending_signups(email);
  CREATE TABLE email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX email_tokens_user_purpose ON email_tokens(user_id, purpose);
  CREATE TABLE oauth_identities (
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    hosted_domain TEXT COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (provider, provider_subject)
  );
  CREATE INDEX oauth_identities_user ON oauth_identities(user_id);
  CREATE TABLE app_link_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE agent_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE TABLE memberships (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (user_id, organization_id)
  );
  CREATE INDEX memberships_organization ON memberships(organization_id);`,
];
