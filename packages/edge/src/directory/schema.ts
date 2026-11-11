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
  // An organization's domains (platform.md §3.2, phase 5.1): its own, verified by a TXT record, and its platform
  // subdomain `<slug>.freeflow.im`, verified from the start. New addresses are made on the primary one. A domain belongs
  // to one organization. `organization_domains` stays: it is the Google auto-join rule, a different thing.
  `CREATE TABLE domains (
    domain TEXT PRIMARY KEY COLLATE NOCASE,
    organization_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    verify_token TEXT,
    verified_at INTEGER,
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX domains_organization ON domains(organization_id);
  INSERT OR IGNORE INTO domains (domain, organization_id, kind, verified_at, is_primary, created_at)
    SELECT lower(slug) || '.freeflow.im', id, 'platform', created_at, 1, created_at FROM organizations;`,
  // A domain's DKIM key (phase 5.2): the selector in use on the domain, and the key pair the platform made, the private key
  // sealed with the data key as mailbox passwords are, since the provider cannot give it back. The public TXT is not secret.
  `ALTER TABLE domains ADD COLUMN dkim_selector TEXT;
  CREATE TABLE domain_keys (
    domain TEXT PRIMARY KEY COLLATE NOCASE,
    selector TEXT NOT NULL,
    public_txt TEXT NOT NULL,
    key_sealed BLOB NOT NULL,
    key_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,
  // Provisioning (platform.md §3.4, phase 5.3): why it stopped (a provider's refusal), when the account's hosted mailbox
  // was made (so "who has none" needs no call to each Mail object), when it was removed (the retention clock), and when
  // a domain was made at the provider (with its platform DNS), so each account's run does not make it again.
  `ALTER TABLE accounts ADD COLUMN status_message TEXT;
  ALTER TABLE accounts ADD COLUMN hosted_at INTEGER;
  ALTER TABLE accounts ADD COLUMN removed_at INTEGER;
  ALTER TABLE domains ADD COLUMN provider_at INTEGER;`,
  // Guest accounts (platform.md §3.3): a guest has no address, so `address` may be NULL (SQLite cannot drop a NOT NULL,
  // hence the rebuild; UNIQUE allows any number of NULLs). `kind_changed_at` starts the retention clock of a mailbox
  // kept when its account became a guest, and `mailbox_address` is that mailbox's address, which provisioning still
  // suspends and deletes by, and which no new account is given until the mailbox is gone.
  `CREATE TABLE accounts_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    address TEXT UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'native',
    state TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    sponsor_user_id TEXT,
    status_message TEXT,
    hosted_at INTEGER,
    removed_at INTEGER,
    kind_changed_at INTEGER,
    mailbox_address TEXT COLLATE NOCASE,
    UNIQUE (user_id, organization_id)
  );
  INSERT INTO accounts_new (id, user_id, organization_id, address, display_name, role, kind, state, created_at, sponsor_user_id, status_message, hosted_at, removed_at)
    SELECT id, user_id, organization_id, address, display_name, role, kind, state, created_at, sponsor_user_id, status_message, hosted_at, removed_at FROM accounts;
  DROP TABLE accounts;
  ALTER TABLE accounts_new RENAME TO accounts;
  CREATE INDEX accounts_organization ON accounts(organization_id);
  CREATE INDEX accounts_sponsor ON accounts(sponsor_user_id);`,
  // Agents as kinds (docs/specs/agents.md §1, §2, phase A): the one organization an agent belongs to and its mode,
  // `personal` or `shared`, on the principal; the personal agent a /mcp delegation acts through, on its connection. The
  // rows are filled by DirectoryCore.backfillAgents, because an existing agent's organization is a choice (its earliest
  // account) and a connection's personal agent is a new principal with a UUIDv7, neither of which SQL can make.
  `ALTER TABLE users ADD COLUMN organization_id TEXT;
  ALTER TABLE users ADD COLUMN mode TEXT;
  CREATE INDEX users_agent_organization ON users(organization_id) WHERE is_agent = 1;
  ALTER TABLE oauth_connections ADD COLUMN agent_id TEXT;
  CREATE INDEX oauth_connections_agent ON oauth_connections(agent_id);`,
];
