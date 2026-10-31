import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

export function openDb(file: string): DB {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Password reset links: the token is emailed, only its hash is stored. One use, short expiry.
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS sheets (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      file TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sheets_owner ON sheets(owner_id, updated_at);

    -- Cell images uploaded or pasted by a user; the bytes are stored as files (see server/images.ts).
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Stored files (generated PDFs, uploads); the bytes are files on disk (see server/files.ts).
    CREATE TABLE IF NOT EXISTS stored_files (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stored_files_owner ON stored_files(owner_id, created_at);

    -- Agent chat. Each user has one active conversation (ended_at IS NULL); resetting ends it and starts a new one.
    CREATE TABLE IF NOT EXISTS agent_conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      -- JSON: tool calls of the last assistant message that still need results (see server/agent/store.ts).
      pending TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_conversations_user ON agent_conversations(user_id, ended_at);

    -- Messages exactly as sent to the Claude API, append-only.
    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_messages_conv ON agent_messages(conversation_id, id);

    -- Changes to the app's own code requested through the assistant, run by server/agent/worker.ts.
    CREATE TABLE IF NOT EXISTS agent_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      spec TEXT NOT NULL,
      -- queued | starting | coding | verifying | done | failed
      status TEXT NOT NULL,
      pid INTEGER,
      -- JSON array of progress lines
      log TEXT NOT NULL DEFAULT '[]',
      summary TEXT,
      error TEXT,
      -- JSON array of changed file paths
      files TEXT,
      cost_usd REAL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      -- Set once the browser has shown the outcome to the user (and told the assistant).
      acknowledged_at TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_jobs_user ON agent_jobs(user_id, created_at);

    -- Connections to external data sources (server/connectors). credentials is AES-256-GCM ciphertext.
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connector TEXT NOT NULL,
      name TEXT NOT NULL,
      auth_type TEXT NOT NULL,
      credentials TEXT NOT NULL,
      -- JSON object of non-secret field values
      settings TEXT NOT NULL DEFAULT '{}',
      masked TEXT,
      -- connected | error | needs_reauth
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS connections_user ON connections(user_id, created_at);

    CREATE TABLE IF NOT EXISTS agent_usage (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );

    -- What powers each user's assistant (see server/agent/settings.ts). openai_key is encrypted.
    CREATE TABLE IF NOT EXISTS assistant_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      openai_model TEXT NOT NULL,
      openai_key TEXT,
      openai_key_masked TEXT,
      updated_at TEXT NOT NULL
    );

    -- Public links (server/publicLinks.ts). A file deleted by any path loses its link, also if it is restored later.
    CREATE TABLE IF NOT EXISTS public_links (
      token TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      file_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (owner_id, kind, file_id)
    );
    CREATE TRIGGER IF NOT EXISTS public_links_sheet_deleted AFTER DELETE ON sheets BEGIN
      DELETE FROM public_links WHERE kind = 'deck' AND file_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS public_links_file_deleted AFTER DELETE ON stored_files BEGIN
      DELETE FROM public_links WHERE kind = 'file' AND file_id = OLD.id;
    END;
  `);
  migrate(db);
  return db;
}

/** Additive schema changes for databases created by earlier versions. */
function migrate(db: DB): void {
  const cols = new Set((db.prepare('PRAGMA table_info(sheets)').all() as { name: string }[]).map((c) => c.name));
  // Branches: parent_id deliberately has no foreign key, so deleting the original leaves its branches "detached".
  if (!cols.has('parent_id')) db.exec('ALTER TABLE sheets ADD COLUMN parent_id TEXT');
  if (!cols.has('parent_title')) db.exec('ALTER TABLE sheets ADD COLUMN parent_title TEXT');
  if (!cols.has('branched_at')) db.exec('ALTER TABLE sheets ADD COLUMN branched_at TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS sheets_parent ON sheets(parent_id)');
  // Slide decks share the table and storage with spreadsheets; kind tells them apart.
  if (!cols.has('kind')) db.exec("ALTER TABLE sheets ADD COLUMN kind TEXT NOT NULL DEFAULT 'sheet'");
  // A spreadsheet stored as CSV text has format 'csv' (shared/csv.ts); null is the native format of the kind.
  if (!cols.has('format')) db.exec('ALTER TABLE sheets ADD COLUMN format TEXT');
  // Folders (shared/folders.ts): each file is in one, named by its path; '' is the top of the library.
  if (!cols.has('folder')) db.exec("ALTER TABLE sheets ADD COLUMN folder TEXT NOT NULL DEFAULT ''");
  // A conversation is run by one driver: the assistant's own loop (null, 'builtin') or the user's own agent
  // ('claude-agent', server/agent/claudeAgent.ts), whose session it resumes (session_id).
  const convCols = new Set((db.prepare('PRAGMA table_info(agent_conversations)').all() as { name: string }[]).map((c) => c.name));
  if (!convCols.has('driver')) db.exec('ALTER TABLE agent_conversations ADD COLUMN driver TEXT');
  if (!convCols.has('session_id')) db.exec('ALTER TABLE agent_conversations ADD COLUMN session_id TEXT');
  // Each file has its own chat, by its id, and the home page one (scope null: every conversation from before).
  if (!convCols.has('scope')) db.exec('ALTER TABLE agent_conversations ADD COLUMN scope TEXT');
  // The assistant on the user's own Anthropic or OpenRouter key, beside OpenAI's (server/agent/settings.ts).
  const settingsCols = new Set((db.prepare('PRAGMA table_info(assistant_settings)').all() as { name: string }[]).map((c) => c.name));
  for (const col of ['anthropic_model', 'anthropic_key', 'anthropic_key_masked', 'openrouter_model', 'openrouter_key', 'openrouter_key_masked', 'brave_key', 'brave_key_masked']) {
    if (!settingsCols.has(col)) db.exec(`ALTER TABLE assistant_settings ADD COLUMN ${col} TEXT`);
  }
  const fileCols = new Set((db.prepare('PRAGMA table_info(stored_files)').all() as { name: string }[]).map((c) => c.name));
  if (!fileCols.has('folder')) db.exec("ALTER TABLE stored_files ADD COLUMN folder TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (owner_id, path)
    );
  `);

  // Google sign-in: the Google account id linked to the user. Accounts created by Google sign-in have an empty
  // password_hash (no password can match it) until the user sets one through "Forgot your password?".
  const userCols = new Set((db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name));
  if (!userCols.has('google_sub')) db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub)');
  // Email verification: a password sign-up gets a session only once the emailed link is opened. Accounts that
  // predate this are taken as verified. Google sign-ins are verified by Google.
  if (!userCols.has('email_verified_at')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
    db.exec('UPDATE users SET email_verified_at = created_at');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_verifications (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);

  // Agent jobs: the record of a change (who asked, what was committed and merged) and revert links.
  const jobCols = new Set((db.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string }[]).map((c) => c.name));
  const jobAdds: [string, string][] = [
    ['kind', "TEXT NOT NULL DEFAULT 'change'"],
    ['requested_by', 'TEXT'],
    ['branch', 'TEXT'],
    ['commit_sha', 'TEXT'],
    ['pr_number', 'INTEGER'],
    ['pr_url', 'TEXT'],
    ['merged_sha', 'TEXT'],
    // The job's changes as a unified diff, so a revert can apply it in reverse.
    ['patch', 'TEXT'],
    ['reverts_job_id', 'TEXT'],
    ['reverted_by_job_id', 'TEXT'],
    ['sheet_id', 'TEXT'],
  ];
  for (const [name, type] of jobAdds) if (!jobCols.has(name)) db.exec(`ALTER TABLE agent_jobs ADD COLUMN ${name} ${type}`);
}
