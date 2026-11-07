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
  CREATE INDEX memberships_organization ON memberships(organization_id);
  CREATE TABLE id_index (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL
  );`,
  `CREATE TABLE organization_slugs (
    slug TEXT PRIMARY KEY COLLATE NOCASE,
    organization_id TEXT NOT NULL
  );`,
  `CREATE TABLE organization_domains (
    organization_id TEXT PRIMARY KEY,
    domain TEXT NOT NULL COLLATE NOCASE
  );
  CREATE INDEX organization_domains_domain ON organization_domains(domain);`,
  // The MCP Docs desktop app's Google sign-in (routes/handoff.ts): a key of the app's, approved in the browser.
  `CREATE TABLE desktop_handoffs (
    key_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );`,
  // The web-to-app sign-in handoff (authHandoff.ts), the server's auth_handoffs; and the server's rate_limit_windows,
  // for the limits on starting and exchanging one.
  `CREATE TABLE auth_handoffs (
    request_hash TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    state TEXT NOT NULL,
    server_origin TEXT NOT NULL,
    client_origin TEXT,
    return_url TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    code_hash TEXT UNIQUE,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE rate_limit_windows (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL
  );`,
  // OAuth for Docs' MCP endpoint on the suite's host (mcpOAuth.ts): the ChatGPT plugin's tables, with the organization the
  // person chose on the consent page on every code, token, connection and device grant.
  `CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE oauth_pending (
    id TEXT PRIMARY KEY,
    params TEXT NOT NULL,
    client_name TEXT NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE oauth_codes (
    hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE oauth_tokens (
    hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    family TEXT NOT NULL,
    resource TEXT,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX oauth_tokens_family ON oauth_tokens(family);
  CREATE TABLE oauth_connections (
    id TEXT PRIMARY KEY,
    family TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    origin TEXT NOT NULL,
    resource TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX oauth_connections_user ON oauth_connections(user_id);
  CREATE TABLE oauth_device (
    hash TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    origin TEXT NOT NULL,
    status TEXT NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    org_id TEXT,
    interval_s INTEGER NOT NULL,
    last_poll_at INTEGER,
    expires_at INTEGER NOT NULL
  );`,
  // The account layer (docs/specs/platform.md §3.1 to §3.3). `users` stays the principals table and `memberships` stays
  // in step with `accounts` until later phase 1 PRs rename the one and retire the other. The accounts themselves are
  // backfilled from `memberships` by DirectoryCore.backfillAccounts, because SQL cannot derive an address's local part.
  `CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL COLLATE NOCASE,
    owner_user_id TEXT,
    policies TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  INSERT INTO organizations (id, slug, owner_user_id, created_at)
    SELECT s.organization_id, MIN(s.slug),
      (SELECT MIN(m.user_id) FROM memberships m WHERE m.organization_id = s.organization_id AND m.role = 'owner'),
      CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM organization_slugs s GROUP BY s.organization_id;
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    address TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'native',
    state TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, organization_id)
  );
  CREATE INDEX accounts_organization ON accounts(organization_id);
  CREATE TABLE addresses (
    address TEXT PRIMARY KEY COLLATE NOCASE,
    account_id TEXT NOT NULL
  );`,
  // Agent accounts (platform.md §3.3): who sponsors the agent in this organization, so the account follows that person's.
  // Per organization because an agent invited into a second organization is sponsored there by whoever brought it in.
  `ALTER TABLE accounts ADD COLUMN sponsor_user_id TEXT;
  UPDATE accounts SET sponsor_user_id = (SELECT u.sponsor_user_id FROM users u WHERE u.id = accounts.user_id AND u.is_agent = 1);
  CREATE INDEX accounts_sponsor ON accounts(sponsor_user_id);`,
];
