// Drizzle mirror of the SQL schema in migrations/ (phase1.md §2 + phase2.md §1-§6).
import {
  customType,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  unique,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { Recurrence, ScheduledRunStatus, WorkspacePolicies } from '@flow/shared';

const citext = customType<{ data: string }>({ dataType: () => 'text COLLATE NOCASE' });
const bytea = customType<{ data: Buffer; driverData: ArrayBuffer | Uint8Array }>({
  dataType: () => 'blob',
  toDriver: (v) => v,
  fromDriver: (v) => Buffer.from(v as ArrayBuffer),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: citext('email').notNull().unique('uq_1'),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  timezone: text('timezone').notNull().default('UTC'),
  isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false), // bot users of the removed Slack-compatible API (migration 0047); kept for their rows
  isAgent: integer('is_agent', { mode: 'boolean' }).notNull().default(false), // first-class AI agents (AGENTS_DESIGN.md)
  // Agents only (AGENT_MEMBERS.md): the human member responsible for the agent,
  // and the agent's durable credentials (username + argon2 key hash) — nulled
  // on removal so a removed agent can never log back in.
  // The agent's *original* sponsor. Per-workspace sponsorship lives on
  // `workspace_members.sponsorUserId` (#357) — this stays as the identity-level
  // answer to "whose agent is this" outside any workspace.
  sponsorUserId: text('sponsor_user_id').references((): AnySQLiteColumn => users.id),
  // #357: unique *per workspace*, not globally — identity is username + key,
  // and the collision check runs when a membership is created.
  agentUsername: citext('agent_username'),
  agentKeyHash: text('agent_key_hash'),
  statusEmoji: text('status_emoji').notNull().default(''),
  statusText: text('status_text').notNull().default(''),
  // #220: expanded profile. `website` is http/https-only (enforced in
  // PatchMeBody, the only write path); `bio` is plain text, newlines kept.
  website: text('website').notNull().default(''),
  bio: text('bio').notNull().default(''),
  // #434: one-line title shown under the name on Directory and profile cards.
  title: text('title').notNull().default(''),
  // Phase 10: per-user notification prefs ({dm, mention, groupMention,
  // threadReply, reaction, channelInvite, persistentBanners} — absent key =
  // default) and the
  // status-driven "suppress all alerts" flag (DND-family statuses).
  notificationPrefs: text('notification_prefs', { mode: 'json' }).$type<Record<string, boolean>>().notNull().default({}),
  statusSuppressAlerts: integer('status_suppress_alerts', { mode: 'boolean' }).notNull().default(false),
  // Phase 11 §10: don't unfurl links in my own messages.
  unfurlOwnLinks: integer('unfurl_own_links', { mode: 'boolean' }).notNull().default(true),
  // #489: hide my email from every API response and keep me out of the
  // Directory. Written only by the owner of the row (PatchMeBody).
  privacyMode: integer('privacy_mode', { mode: 'boolean' }).notNull().default(false),
  emailVerifiedAt: integer('email_verified_at', { mode: 'timestamp_ms' }),
  // Tombstone: set when a human is removed from their last workspace. The row is
  // kept for message authorship; the service vacates `email` so it frees up.
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

/** Email-first registration: a signup link in flight, no user row yet. */
export const pendingSignups = sqliteTable(
  'pending_signups',
  {
    tokenHash: bytea('token_hash').primaryKey(),
    email: citext('email').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('pending_signups_email_idx').on(t.email)],
);

/** Single-use emailed tokens: verify-email, password-reset, and sign-in links. */
export const emailTokens = sqliteTable(
  'email_tokens',
  {
    tokenHash: bytea('token_hash').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['verify_email', 'password_reset', 'signin'] }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('email_tokens_user_purpose_idx').on(t.userId, t.purpose)],
);

export const sessions = sqliteTable('sessions', {
  tokenHash: bytea('token_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  clientInfo: text('client_info'),
});

/**
 * Phase 16: an external IdP identity linked to a Flow user. `providerSubject`
 * (Google's `sub`) is the durable key; `email` is refreshed on each sign-in and
 * used for display/audit and for the email→user fallback match.
 */
export const oauthIdentities = sqliteTable(
  'oauth_identities',
  {
    provider: text('provider').notNull(),
    providerSubject: text('provider_subject').notNull(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    email: citext('email').notNull(),
    hostedDomain: citext('hosted_domain'), // Google `hd` — Workspace accounts only
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerSubject] }), index('oauth_identities_user_idx').on(t.userId)],
);

/** One-time web-to-app auth handoff codes (flow://signin deep link). */
export const appLinkCodes = sqliteTable('app_link_codes', {
  codeHash: bytea('code_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

/** Pending client-initiated PKCE operations; separate from unbound legacy codes. */
export const authHandoffs = sqliteTable('auth_handoffs', {
  requestHash: bytea('request_hash').primaryKey(),
  connectionId: text('connection_id').notNull(),
  operationId: text('operation_id').notNull(),
  state: text('state').notNull(),
  serverOrigin: text('server_origin').notNull(),
  clientOrigin: text('client_origin'),
  returnUrl: text('return_url').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  codeHash: bytea('code_hash').unique('uq_2'),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  slug: citext('slug').notNull().unique('uq_3'),
  name: text('name').notNull(),
  sidebarColor: text('sidebar_color').notNull().default('violet'), // preset id (phase 3.5)
  // #336: optional image mark, a `/v1/avatars/<key>` path like users.avatar_url;
  // null = the color/initial mark clients have always drawn.
  avatarUrl: text('avatar_url'),
  // Phase 11 §10: workspace switch, plus optional allowlist mode for regulated
  // deployments (null = allow all domains).
  unfurlEnabled: integer('unfurl_enabled', { mode: 'boolean' }).notNull().default(true),
  unfurlDomainAllowlist: text('unfurl_domain_allowlist', { mode: 'json' }).$type<string[]>(),
  // Phase 16 §5a: null = off; otherwise the email domain whose verified Google
  // users self-enroll on sign-in.
  googleSelfRegisterDomain: citext('google_self_register_domain'),
  // platform.md §3.1: who may invite and sponsor agents, and link sharing; missing keys read as the defaults
  // (WORKSPACE_POLICY_DEFAULTS). Mirrored to the directory through the outbox.
  policies: text('policies', { mode: 'json' }).$type<Partial<WorkspacePolicies>>().notNull().default({}),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});


export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'member'] as const }).notNull().default('member'),
    // Agents only (#357): the human who vouched for this agent *in this
    // workspace* — the inviter. Sponsorship is per-membership because an agent
    // can be sponsored by different people in different workspaces.
    sponsorUserId: text('sponsor_user_id').references(() => users.id, { onDelete: 'set null' }),
    joinedAt: integer('joined_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    // platform.md §3.2: the member's account address, from the directory at join (null until it is known).
    address: text('address'),
    // platform.md §5.2: the member's account id, from the directory at join, for the event log's `actor` (null until known).
    accountId: text('account_id'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index('ix_1').on(t.userId)],
);

export const invites = sqliteTable(
  'invites',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    email: citext('email').notNull(),
    tokenHash: bytea('token_hash').notNull().unique('uq_4'),
    invitedBy: text('invited_by').notNull().references(() => users.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    acceptedAt: integer('accepted_at', { mode: 'timestamp_ms' }),
    // #359: set when the invite was addressed to an existing Flow user from
    // their profile popup rather than emailed to an address. Such an invite is
    // accepted/declined in-app by id; no email is ever sent.
    invitedUserId: text('invited_user_id').references(() => users.id, { onDelete: 'cascade' }),
    // #359: "no thanks" — terminal like acceptedAt, and it frees the pending slot.
    declinedAt: integer('declined_at', { mode: 'timestamp_ms' }),
  },
  // one PENDING invite per email; accepted/declined invites are history, not locks
  (t) => [
    uniqueIndex('invites_pending_unique')
      .on(t.workspaceId, t.email)
      .where(sql`accepted_at IS NULL AND declined_at IS NULL`),
    index('invites_invited_user_idx')
      .on(t.invitedUserId)
      .where(sql`accepted_at IS NULL AND declined_at IS NULL`),
  ],
);

/**
 * Persistent Slack-style join link — at most one live link per workspace
 * (hence the PK on workspace_id: regenerating overwrites, which revokes the
 * previous URL). The token is stored raw, not hashed, because an admin must be
 * able to re-read and re-share the same link indefinitely; see 0025 for the
 * reasoning.
 */
export const workspaceJoinLinks = sqliteTable('workspace_join_links', {
  workspaceId: text('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique('uq_5'),
  createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});


export const channels = sqliteTable(
  'channels',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    name: citext('name'), // null for dm/group_dm
    kind: text('kind', { enum: ['standard', 'dm', 'group_dm'] as const }).notNull().default('standard'),
    dmKey: text('dm_key'), // sorted member ids joined with ':'
    topic: text('topic'),
    isPrivate: integer('is_private', { mode: 'boolean' }).notNull().default(false),
    createdBy: text('created_by').notNull().references(() => users.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
    // Sub-channels (#118) — one level deep, enforced in the service.
    parentId: text('parent_id').references((): AnySQLiteColumn => channels.id, { onDelete: 'set null' }),
    // Channel emoji (#396) — one persistent glyph drawn after the name in the
    // sidebar. Null = none. Unlike the activity indicator it shares that slot
    // with, this is a column: it outlives the process that set it.
    emoji: text('emoji'),
  },
  (t) => [
    uniqueIndex('ui_1').on(t.workspaceId, t.name),
    uniqueIndex('chan_dm_key').on(t.workspaceId, t.dmKey).where(sql`dm_key IS NOT NULL`),
  ],
);

export const channelMembers = sqliteTable(
  'channel_members',
  {
    channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: integer('joined_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    lastReadMsgId: text('last_read_msg_id'),
    notifyLevel: integer('notify_level').notNull().default(1), // 0=mute 1=mentions 2=all
  },
  (t) => [primaryKey({ columns: [t.channelId, t.userId] }), index('ix_2').on(t.userId)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id),
    threadRootId: text('thread_root_id').references((): AnySQLiteColumn => messages.id, { onDelete: 'cascade' }),
    clientMsgId: text('client_msg_id').notNull(),
    body: bytea('body').notNull(),
    bodyNonce: bytea('body_nonce').notNull(),
    encKeyId: text('enc_key_id').notNull(),
    encScheme: integer('enc_scheme').notNull().default(1),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    editedAt: integer('edited_at', { mode: 'timestamp_ms' }),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    replyCount: integer('reply_count').notNull().default(0),
    lastReplyAt: integer('last_reply_at', { mode: 'timestamp_ms' }),
    // Non-null marks a channel event line (join/leave); null = a user message.
    // Excluded from unread counts and never notifies.
    systemKind: text('system_kind'),
    // #419: posted by a scheduled message rather than typed. Nothing else about
    // the row differs — clients draw a badge off this.
    scheduled: integer('scheduled', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    uniqueIndex('ui_2').on(t.channelId, t.clientMsgId),
    index('msg_channel_top').on(t.channelId, t.id).where(sql`thread_root_id IS NULL`),
    index('msg_thread').on(t.threadRootId, t.id).where(sql`thread_root_id IS NOT NULL`),
  ],
);

export const messagePins = sqliteTable(
  'message_pins',
  {
    messageId: text('message_id').primaryKey().references(() => messages.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    pinnedBy: text('pinned_by').references(() => users.id, { onDelete: 'set null' }),
    pinnedAt: integer('pinned_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index('message_pins_channel_idx').on(t.channelId, t.pinnedAt)],
);

export const reactions = sqliteTable(
  'reactions',
  {
    messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(), // unicode emoji, no shortcodes
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] }), index('reactions_message_idx').on(t.messageId)],
);

export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  storageKey: text('storage_key').notNull(),
  encKeyId: text('enc_key_id'), // NULL = plaintext blob (R2 era; legacy rows decrypt via keyring)
  status: text('status').notNull().default('ready'), // 'pending' until a presigned upload is confirmed
  width: integer('width'),
  height: integer('height'),
  thumbKey: text('thumb_key'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
});

/** Custom emoji (#175): a workspace-scoped image usable as a reaction. The
 * `shortcode` is stored bare; reaction rows store the `:shortcode:` form. The
 * image is an ordinary `files` row, so uploads reuse the presign flow. */
export const workspaceEmoji = sqliteTable(
  'workspace_emoji',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    shortcode: text('shortcode').notNull(),
    fileId: text('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('workspace_emoji_code_idx').on(t.workspaceId, t.shortcode)],
);

export const messageFiles = sqliteTable(
  'message_files',
  {
    messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    // Cascade (migration 0031): workspace deletion reaches files down two FK
    // paths at once (workspaces→files, workspaces→…→messages→message_files);
    // without ON DELETE CASCADE here the files leg can fire first and trip
    // this constraint mid-cascade (23503), 500ing the whole delete.
    fileId: text('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.fileId] }), index('message_files_file_idx').on(t.fileId)],
);

/** Phase 13: per-channel shared artifacts (superseding phase-9 per-user
 * bookmarks). Everyone in the channel sees the same artifacts; privacy comes
 * from using a private channel. The backing file is mutable — an agent
 * "updates" an artifact by re-pointing it at a freshly uploaded file. owns_file
 * marks artifacts whose file was uploaded for them (agent-generated), so
 * deleting the artifact can reap the file (guarded). */
export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    // 'file' rows carry fileId (url null); 'link' rows carry url (fileId null) —
    // enforced by the artifacts_kind_shape CHECK in migration 0020.
    kind: text('kind').notNull().default('file'),
    fileId: text('file_id').references(() => files.id, { onDelete: 'cascade' }),
    url: text('url'),
    ownsFile: integer('owns_file', { mode: 'boolean' }).notNull().default(false),
    requesterUserId: text('requester_user_id').references(() => users.id, { onDelete: 'set null' }),
    sourceThreadRootId: text('source_thread_root_id').references(() => messages.id, { onDelete: 'set null' }),
    operationId: text('operation_id'),
    name: text('name').notNull(),
    // Mini apps (MINI_APPS.md): a link artifact marked as an app owns a secret
    // used to HMAC short-lived member identity tokens. Encrypted at rest with
    // the message-body envelope; all four columns are NULL together, and a
    // non-null app_secret is what `isApp` means.
    appSecret: bytea('app_secret'),
    appSecretNonce: bytea('app_secret_nonce'),
    appEncKeyId: text('app_enc_key_id'),
    appEncScheme: integer('app_enc_scheme'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index('artifacts_channel_idx').on(t.channelId, t.createdAt),
    uniqueIndex('artifacts_delivery_operation').on(t.channelId, t.createdBy, t.operationId),
    // pins of a shared file are idempotent per channel; owned artifacts are always distinct
    uniqueIndex('artifacts_channel_file_pin').on(t.channelId, t.fileId).where(sql`owns_file = false`),
    // link pins are idempotent per channel too (the url is mutable via co-browsing)
    uniqueIndex('artifacts_channel_link_pin').on(t.channelId, t.url).where(sql`kind = 'link'`),
  ],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    // 0=mention 1=dm 2=thread_reply 3=channel activity 4=reaction 5=channel invite
    kind: integer('kind').notNull(),
    // phase 10: for kind 0 — 'mention' | 'here' | 'channel'; NULL otherwise
    subkind: text('subkind'),
    // issue #63: who caused it — message author (kinds 0-3), reactor (kind 4)
    // or the inviter (kind 5, #303).
    // Nullable only for rows written before the column existed.
    actorId: text('actor_id').references(() => users.id, { onDelete: 'cascade' }),
    reactionEmoji: text('reaction_emoji'), // kind 4 only
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    readAt: integer('read_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.readAt, t.id),
    index('notifications_unread_channel_idx').on(t.userId, t.channelId).where(sql`read_at IS NULL`),
    uniqueIndex('notifications_reaction_uniq')
      .on(t.userId, t.messageId, t.actorId, t.reactionEmoji)
      .where(sql`kind = 4`),
  ],
);

// ---- First-class AI agents (AGENTS_DESIGN.md) -------------------

/**
 * Invite-code agent onboarding (AGENT_MEMBERS.md): a member generates a
 * one-time code inside Flow; the agent redeems it (`npx flow-agent-bridge
 * <code>`) and joins immediately — no approval. The code carries the sponsor +
 * workspace; agent_user_id records what it created (single-use via redeemed_at).
 */
export const agentInvites = sqliteTable(
  'agent_invites',
  {
    id: text('id').primaryKey(),
    codeHash: bytea('code_hash').notNull().unique('uq_6'), // sha-256 of the raw flow-XXXX-XXXX code
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    sponsorUserId: text('sponsor_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    agentUserId: text('agent_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    redeemedAt: integer('redeemed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('agent_invites_sponsor_idx').on(t.sponsorUserId).where(sql`redeemed_at IS NULL`)],
);

/** Agent bearer tokens: non-expiring sibling of `sessions`; revoked_at is the kill switch. */
export const agentTokens = sqliteTable(
  'agent_tokens',
  {
    id: text('id').primaryKey(),
    tokenHash: bytea('token_hash').notNull().unique('uq_7'),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('agent_tokens_user_idx').on(t.userId)],
);

// ---- Phase 11: URL unfurling (docs/specs/phase11.md) ----------------

/** §7 cache, keyed by sha256 of the normalized URL. Holds negative entries
 * (`ok=false`) so a dead link isn't refetched on every mention. */
export const unfurlCache = sqliteTable(
  'unfurl_cache',
  {
    urlHash: text('url_hash').primaryKey(),
    normalizedUrl: text('normalized_url').notNull(),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    failureReason: text('failure_reason'),
    data: text('data', { mode: 'json' }),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('unfurl_cache_expires_idx').on(t.expiresAt)],
);

/** §1 attachment of cache entries to messages, plus the §10 per-unfurl
 * tombstone. channelId is denormalized for the 6h suppression lookup. */
export const messageUnfurls = sqliteTable(
  'message_unfurls',
  {
    messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    urlHash: text('url_hash').notNull(),
    channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.urlHash] }),
    index('message_unfurls_suppression_idx').on(t.channelId, t.urlHash, t.createdAt),
  ],
);

/** §10 operator-maintained denylist: blocks the host and any subdomain. */
export const unfurlDomainDenylist = sqliteTable('unfurl_domain_denylist', {
  domain: text('domain').primaryKey(),
  note: text('note'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

/**
 * Scheduled messages (#419) — a pending message with a recurrence rule. The
 * body carries the same envelope encryption as `messages`; firing a row means
 * calling the ordinary send path as `authorUserId`, so the result is an
 * ordinary message with `scheduled = true`.
 */
export const scheduledMessages = sqliteTable(
  'scheduled_messages',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    authorUserId: text('author_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    body: bytea('body').notNull(),
    bodyNonce: bytea('body_nonce').notNull(),
    encKeyId: text('enc_key_id').notNull(),
    encScheme: integer('enc_scheme').notNull().default(1),
    recurrence: text('recurrence', { mode: 'json' }).$type<Recurrence>().notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    // Null once a one-shot has fired — the row stays for its run history.
    nextRunAt: integer('next_run_at', { mode: 'timestamp_ms' }),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
    lastRunStatus: text('last_run_status').$type<ScheduledRunStatus>(),
    lastMessageId: text('last_message_id').references(() => messages.id, { onDelete: 'set null' }),
    lastError: text('last_error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index('scheduled_messages_due_idx').on(t.nextRunAt).where(sql`enabled AND next_run_at IS NOT NULL`),
    index('scheduled_messages_workspace_idx').on(t.workspaceId, t.createdAt),
    index('scheduled_messages_author_idx').on(t.authorUserId),
  ],
);

/** Phase 18 M1: fixed-window rate-limit counters shared across replicas —
 * only the per-user limiter keys live here (see lib/rateLimitDb.ts). */
export const rateLimitWindows = sqliteTable('rate_limit_windows', {
  key: text('key').primaryKey(),
  windowStart: integer('window_start', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  count: integer('count').notNull().default(1),
});

/**
 * APNs device tokens (#245, PUSH_APNS.md). Registered on every cold start —
 * tokens rotate silently on restore-from-backup or reinstall, so "register
 * every launch" is the cheapest correctness policy.
 *
 * `token` is unique globally rather than per user: a phone handed to someone
 * else re-registers under the new account and the upsert rebinds `userId`,
 * so the previous owner's pushes stop arriving on a phone that is not theirs.
 */
export const deviceTokens = sqliteTable(
  'device_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique('uq_8'), // APNs device token, hex
    routingId: text('routing_id'), // null is the legacy absolute-badge contract
    platform: text('platform').notNull(), // 'ios' (macOS later)
    // Narrowed at the type level so the sender seam's PushDevice takes a row
    // straight through with no adapter — the API's zod schema is what enforces
    // it at the boundary (#247).
    environment: text('environment').$type<'sandbox' | 'production'>().notNull(),
    bundleId: text('bundle_id').notNull(), // APNs topic
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    /** Set when APNs answers 410 Unregistered — kept, not deleted, so a
     * re-register can revive the row instead of racing the sender. */
    disabledAt: integer('disabled_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('device_tokens_user_idx').on(t.userId).where(sql`disabled_at IS NULL`)],
);

/**
 * APNs delivery outbox (#247, PUSH_APNS.md § "Delivery: outbox, not
 * fire-and-forget"). Same shape as `pendingAppEvents` — same reason: push is
 * not loss-tolerant the way WS publish is, because a phone with no socket has
 * nothing to backfill from, so rows land in the notification's own transaction
 * and an in-process worker drains them at least once.
 *
 * One row per *notification*, not per device: the worker resolves the user's
 * live devices at send time (they change between commit and delivery) and
 * computes the badge count once per row rather than once per phone.
 */
export const pendingPush = sqliteTable(
  'pending_push',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    notificationId: text('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    deliveredAt: integer('delivered_at', { mode: 'timestamp_ms' }),
    failedAt: integer('failed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('pending_push_due').on(t.nextAttemptAt).where(sql`delivered_at IS NULL AND failed_at IS NULL`),
    index('pending_push_user_idx').on(t.userId, t.id),
  ],
);

/**
 * DM huddle invites (#436, migration 0042) — the ring and its outcome.
 * Channel huddles are ambient and leave no rows at all; a DM huddle rings, and
 * a ring nobody answered has to still be there tomorrow, which no in-memory
 * roster can promise. `huddleInvites` is the call, `huddleInviteTargets` is
 * one row per person rung (a 1:1 call is the one-target case).
 */
export const huddleInvites = sqliteTable(
  'huddle_invites',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    startedBy: text('started_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** 'ringing' | 'active' | 'ended' | 'declined' | 'missed' | 'cancelled' */
    status: text('status').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
    /** The first accept — the moment the call became real. Null = unanswered. */
    answeredAt: integer('answered_at', { mode: 'timestamp_ms' }),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
    durationSeconds: integer('duration_seconds'),
    /** The transcript line posted into the DM ("Call ended · 4 min"). */
    systemMessageId: text('system_message_id').references(() => messages.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('huddle_invites_channel_idx').on(t.channelId, t.startedAt),
    index('huddle_invites_ringing_idx').on(t.status).where(sql`status IN ('ringing', 'active')`),
  ],
);

export const huddleInviteTargets = sqliteTable(
  'huddle_invite_targets',
  {
    inviteId: text('invite_id').notNull().references(() => huddleInvites.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** 'ringing' | 'accepted' | 'declined' | 'missed' | 'unavailable' */
    status: text('status').notNull(),
    respondedAt: integer('responded_at', { mode: 'timestamp_ms' }),
  },
  (t) => [primaryKey({ columns: [t.inviteId, t.userId] }), index('huddle_invite_targets_user_idx').on(t.userId)],
);

/**
 * Images pasted into a community email (#492, migration 0044).
 *
 * The row is a capability, not a copy: the bytes stay in `files`, uploaded
 * through the ordinary presign flow, and this table's `token` is what lets an
 * unauthenticated mail client fetch them. It doubles as the sweeper's proof
 * that an image nobody attached to a message is still load-bearing.
 */
export const workspaceEmailImages = sqliteTable(
  'workspace_email_images',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    fileId: text('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique('uq_9'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index('workspace_email_images_file_idx').on(t.fileId)],
);

/**
 * The share index (platform.md §4.5, phase 3.3): one row per grant an app object reports, so "shared with me" and the
 * bus's visibility are answered here without a fan-out over every app object. `ref` is the object's formatted reference
 * (`<org>/docs/<kind>/<id>`), `principal` a grant principal, `granted_by` the granter's account, `kind` the kind of file
 * (a document's kind, `file`, `folder`) and `at` epoch milliseconds.
 */
export const shares = sqliteTable(
  'shares',
  {
    ref: text('ref').notNull(),
    principal: text('principal').notNull(),
    role: text('role').notNull(),
    grantedBy: text('granted_by').notNull(),
    title: text('title').notNull().default(''),
    kind: text('kind').notNull().default(''),
    at: integer('at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.ref, t.principal] }), index('shares_principal_idx').on(t.principal)],
);
