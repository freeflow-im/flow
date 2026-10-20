import { z } from 'zod';

// ---- auth ------------------------------------------------------
/** Email-first: registration takes only an email; name + password are set on
 * the emailed link's "finish your account" form. The autoVerify escape hatch
 * (dev email driver only — QA scripts, dev macOS) registers in one shot and
 * must carry password + displayName. */
export const RegisterBody = z
  .object({
    email: z.string().email().max(320),
    password: z.string().min(8).max(256).optional(),
    displayName: z.string().min(1).max(80).optional(),
    autoVerify: z.boolean().optional(),
  })
  .refine((b) => !b.autoVerify || (b.password !== undefined && b.displayName !== undefined), {
    message: 'autoVerify requires password and displayName',
  });
export type RegisterBody = z.infer<typeof RegisterBody>;

export const CompleteSignupBody = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(8).max(256),
  displayName: z.string().min(1).max(80),
});
export type CompleteSignupBody = z.infer<typeof CompleteSignupBody>;

export const ForgotPasswordBody = z.object({
  email: z.string().email().max(320),
});
export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBody>;

export const ResetPasswordBody = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(8).max(256),
});
export type ResetPasswordBody = z.infer<typeof ResetPasswordBody>;

export const LoginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
});
export type LoginBody = z.infer<typeof LoginBody>;

/** Passwordless sign-in: request a one-time link emailed to an existing account. */
export const SigninLinkBody = z.object({
  email: z.string().email().max(320),
});
export type SigninLinkBody = z.infer<typeof SigninLinkBody>;

/** Sign-in-link redeem: the emailed token, exchanged for a session. */
export const ConsumeSigninLinkBody = z.object({
  token: z.string().min(1).max(512),
});
export type ConsumeSigninLinkBody = z.infer<typeof ConsumeSigninLinkBody>;

export const AppLinkExchangeBody = z.object({
  code: z.string().min(1).max(512),
});
export type AppLinkExchangeBody = z.infer<typeof AppLinkExchangeBody>;

/** POST /v1/auth/google — a Google ID token (a signed JWT from Google Identity
 * Services). Sign-in and registration are the same operation with Google. */
export const GoogleAuthBody = z.object({
  idToken: z.string().min(1).max(4096),
});
export type GoogleAuthBody = z.infer<typeof GoogleAuthBody>;

/** POST /v1/auth/apple — an Apple identity token (a signed JWT from Sign in
 * with Apple). `name` rides alongside because Apple delivers the user's name
 * to the client exactly once, on first authorization — it is never in the
 * token, so the client must forward it or it is lost. Used only when the
 * sign-in creates a new account. */
export const AppleAuthBody = z.object({
  identityToken: z.string().min(1).max(8192),
  name: z.string().trim().min(1).max(200).optional(),
});
export type AppleAuthBody = z.infer<typeof AppleAuthBody>;

/**
 * Domains that may never be opened up by the workspace self-register toggle
 * (phase16 §5a/§7): "anyone with a gmail" is the whole internet. This list is
 * mandatory — without it the toggle is an open-registration hole.
 */
export const CONSUMER_EMAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'qq.com',
  '163.com',
];

/** Lowercased domain part of an email address, or null if it has no `@`. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/** A domain that may be used for Google domain self-registration. */
export function isSelfRegisterableDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  return d.length > 0 && d.includes('.') && !CONSUMER_EMAIL_DOMAINS.includes(d);
}

// ---- workspaces ------------------------------------------------
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** An email domain the workspace opens to Google self-registration (phase16 §5a).
 * Clients only ever offer the creator's *own* verified domain — it is not
 * free-text — and the server re-checks that plus the consumer denylist. */
const SelfRegisterDomain = z.string().min(3).max(253).toLowerCase();

export const CreateWorkspaceBody = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().regex(SLUG_RE, 'slug must be lowercase alphanumeric with dashes, 3-40 chars'),
  googleSelfRegisterDomain: SelfRegisterDomain.nullable().optional(),
});
export type CreateWorkspaceBody = z.infer<typeof CreateWorkspaceBody>;

/**
 * One address (`email`, the legacy shape older macOS/iOS clients still send) or
 * many (`emails`, issue #577). Batch addresses are deliberately NOT validated
 * as emails here: a typo in address 4 must come back as that address's
 * `invalid_email` result, not a 400 that throws away the other nine.
 */
export const CreateInviteBody = z
  .object({
    email: z.string().email().max(320).optional(),
    emails: z.array(z.string().min(1).max(320)).min(1).max(100).optional(),
  })
  .refine((b) => b.email !== undefined || b.emails !== undefined, {
    message: 'email or emails is required',
  });
export type CreateInviteBody = z.infer<typeof CreateInviteBody>;

/** PATCH /v1/workspaces/:id — owner/admin only (phase 3.5: workspace branding). */
export const UpdateWorkspaceBody = z
  .object({
    sidebarColor: z.string().min(1).max(32).optional(),
    // phase 11 §10: workspace-wide unfurl switch, and optional allowlist mode
    // (null clears it back to "allow all domains").
    unfurlEnabled: z.boolean().optional(),
    unfurlDomainAllowlist: z.array(z.string().min(1).max(253)).max(200).nullable().optional(),
    // phase 16 §5a: open the workspace to everyone on an email domain who signs
    // in with Google. null turns it off.
    googleSelfRegisterDomain: SelfRegisterDomain.nullable().optional(),
  })
  .refine(
    (b) =>
      b.sidebarColor !== undefined ||
      b.unfurlEnabled !== undefined ||
      b.unfurlDomainAllowlist !== undefined ||
      b.googleSelfRegisterDomain !== undefined,
    'nothing to update',
  );
export type UpdateWorkspaceBody = z.infer<typeof UpdateWorkspaceBody>;

/**
 * POST /v1/invites/accept — the emailed link carries `token`; an in-app
 * workspace invitation (#359, addressed to a known user) carries `inviteId`
 * instead, because its raw token was never handed to anyone. Same table, same
 * accept path — only the way the row is addressed differs.
 */
export const AcceptInviteBody = z
  .object({
    token: z.string().min(16).max(128).optional(),
    inviteId: z.string().uuid().optional(),
  })
  .refine((b) => (b.token === undefined) !== (b.inviteId === undefined), 'pass exactly one of token or inviteId');
export type AcceptInviteBody = z.infer<typeof AcceptInviteBody>;

/** POST /v1/invites/decline — in-app workspace invitations only (#359). */
export const DeclineInviteBody = z.object({
  inviteId: z.string().uuid(),
});
export type DeclineInviteBody = z.infer<typeof DeclineInviteBody>;

/**
 * POST /v1/agents/:agentUserId/workspace-invites (#357) and
 * POST /v1/users/:userId/workspace-invites (#359) — "bring this member into
 * that workspace of mine". Same body either way; agents join immediately,
 * people get an invitation.
 */
export const WorkspaceInviteBody = z.object({
  workspaceId: z.string().uuid(),
});
export type WorkspaceInviteBody = z.infer<typeof WorkspaceInviteBody>;

/** POST /v1/join-links/redeem — the persistent workspace join link (issue #85).
 * The slug is carried for a readable URL; the token alone identifies the link. */
export const RedeemJoinLinkBody = z.object({
  token: z.string().min(16).max(128),
});
export type RedeemJoinLinkBody = z.infer<typeof RedeemJoinLinkBody>;

/**
 * PATCH /v1/workspaces/:id/members/:userId/role — owner/admin manage users
 * (admin panel). Only 'admin' and 'member' are assignable; 'owner' is fixed.
 */
export const SetMemberRoleBody = z.object({
  role: z.enum(['admin', 'member']),
});
export type SetMemberRoleBody = z.infer<typeof SetMemberRoleBody>;

// ---- channels --------------------------------------------------
export const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,79}$/;

export const CreateChannelBody = z.object({
  name: z.string().regex(CHANNEL_NAME_RE, 'channel name must be lowercase [a-z0-9-_], max 80 chars'),
  topic: z.string().max(250).optional(),
  isPrivate: z.boolean().optional(),
  /** Nest under an existing channel or DM you're a member of, one level (#118). */
  parentId: z.string().uuid().optional(),
});
export type CreateChannelBody = z.infer<typeof CreateChannelBody>;

/** PATCH /v1/channels/:id — rename and/or set topic (standard channels only;
 * any channel member, see decision_log 2026-07-19). Empty topic clears it. */
export const UpdateChannelBody = z
  .object({
    name: z.string().regex(CHANNEL_NAME_RE, 'channel name must be lowercase [a-z0-9-_], max 80 chars').optional(),
    topic: z.string().max(250).optional(),
  })
  .refine((b) => b.name !== undefined || b.topic !== undefined, 'nothing to update');
export type UpdateChannelBody = z.infer<typeof UpdateChannelBody>;

/** POST /v1/workspaces/:id/dms — the caller is implicitly included; 1 other user = dm, more = group_dm. */
export const CreateDmBody = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(8), // + caller → max 9 members, Slack's group-DM cap
});
export type CreateDmBody = z.infer<typeof CreateDmBody>;

export const AddChannelMemberBody = z.object({
  userId: z.string().uuid(),
});
export type AddChannelMemberBody = z.infer<typeof AddChannelMemberBody>;

/**
 * PUT /v1/channels/:id/indicator (#137) — an agent turning its "working here"
 * spinner on or off. `ttlSeconds` bounds how long a set survives without a
 * refresh; the cap is deliberately short, since the whole point is that a
 * crashed run can't leave a channel spinning forever.
 */
export const SetChannelIndicatorBody = z.object({
  state: z.union([z.literal('busy'), z.literal('none')]),
  ttlSeconds: z.number().int().min(5).max(600).optional(),
});
export type SetChannelIndicatorBody = z.infer<typeof SetChannelIndicatorBody>;

/**
 * One emoji, as a channel's decoration is allowed to be (#396).
 *
 * `\p{RGI_Emoji}` is the Unicode "recommended for general interchange" set, so
 * ZWJ sequences (👩🏽‍🚀) and skin-tone modifiers count as the single grapheme they
 * render as, while two emoji, an emoji plus text, or plain text do not. Asking
 * the runtime rather than hand-rolling a code-point range means the rule tracks
 * whatever Unicode version is actually rendering the glyph.
 */
const SINGLE_EMOJI_RE = /^\p{RGI_Emoji}$/v;

export function isSingleEmoji(value: string): boolean {
  return SINGLE_EMOJI_RE.test(value);
}

/**
 * PUT /v1/channels/:id/emoji (#396) — the persistent glyph after a channel's
 * name. Null, absent or empty all mean "clear it"; anything else must be one
 * emoji. Note this is not the transient activity spinner (SetChannelIndicatorBody).
 */
export const SetChannelEmojiBody = z.object({
  emoji: z
    .string()
    .max(64) // a ZWJ sequence is long; arbitrary text is not welcome at any length
    .nullable()
    .optional()
    .refine((v) => v === undefined || v === null || v === '' || isSingleEmoji(v), {
      message: 'must be a single emoji (or empty to clear)',
    }),
});
export type SetChannelEmojiBody = z.infer<typeof SetChannelEmojiBody>;

export const SetNotifyLevelBody = z.object({
  level: z.union([z.literal(0), z.literal(1), z.literal(2)]), // 0=mute 1=mentions 2=all
});
export type SetNotifyLevelBody = z.infer<typeof SetNotifyLevelBody>;

/**
 * Answering or refusing a DM huddle ring (#436). `sessionId` is the WS session
 * of the device doing it (from the `hello` frame) — it rides along so this
 * device stays quiet while the user's *other* devices can say "Answered on
 * another device" rather than just blinking the overlay away. Optional: an
 * older client that omits it simply gets the plain dismissal everywhere.
 */
export const HuddleInviteReplyBody = z.object({
  sessionId: z.string().optional(),
});
export type HuddleInviteReplyBody = z.infer<typeof HuddleInviteReplyBody>;

// ---- messages --------------------------------------------------
/** Group-mention tokens stored in bodies (Slack-style). */
export const GROUP_MENTION_RE = /<!(channel|here|everyone)>/g;
/** User-mention tokens stored in bodies: <@uuid>. */
export const USER_MENTION_RE = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/g;

export const SendMessageBody = z.object({
  clientMsgId: z.string().uuid(),
  body: z.string().min(1).max(12000),
  threadRootId: z.string().uuid().optional(),
  /** Uploaded-file attachments (phase2 §3): upload first, then reference. */
  fileIds: z.array(z.string().uuid()).max(10).optional(),
  /** Resolved @-mention user ids (phase2 §4): client resolves names, server validates membership. */
  mentions: z.array(z.string().uuid()).max(50).optional(),
  /**
   * Rewrite `@Display Name` in the body to `<@userId>` before storing (#415),
   * so an API-posted message pings like a composer-typed one. Defaults to true
   * for agent/bot tokens and false for a client session — the composer already
   * resolves its own mentions. Set false to store the body verbatim.
   */
  expandMentions: z.boolean().optional(),
});
export type SendMessageBody = z.infer<typeof SendMessageBody>;

export const EditMessageBody = z.object({
  body: z.string().min(1).max(12000),
});
export type EditMessageBody = z.infer<typeof EditMessageBody>;

export const MarkReadBody = z.object({
  lastReadMsgId: z.string().uuid(),
  /**
   * "I'm looking at this thread" (issue #63): marks the thread's notifications
   * read without touching the channel's own read cursor, which only tracks
   * top-level messages. Absent = a plain channel read.
   */
  threadRootId: z.string().uuid().optional(),
});
export type MarkReadBody = z.infer<typeof MarkReadBody>;

export const ListMessagesQuery = z.object({
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListMessagesQuery = z.infer<typeof ListMessagesQuery>;

export const ListChannelFilesQuery = z.object({
  sort: z.enum(['newest', 'oldest', 'name', 'size']).default('newest'),
  before: z.string().optional(), // opaque cursor from the previous page
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListChannelFilesQuery = z.infer<typeof ListChannelFilesQuery>;

export const ListThreadQuery = z.object({
  after: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListThreadQuery = z.infer<typeof ListThreadQuery>;

// ---- reactions -------------------------------------------------
/** Bare custom-emoji shortcode, no colons (#175). Lowercase so `:Tada:` and
 * `:tada:` can't be two different reactions on the same message. */
export const CUSTOM_EMOJI_CODE_RE = /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/;

/** `:shortcode:` as it appears in a reaction row and on the wire. */
export const CUSTOM_EMOJI_RE = /^:[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]:$/;

export function isCustomEmoji(s: string): boolean {
  return CUSTOM_EMOJI_RE.test(s);
}

/** Strips the colons from a `:shortcode:`; returns null for anything else. */
export function customEmojiCode(s: string): string | null {
  return isCustomEmoji(s) ? s.slice(1, -1) : null;
}

/**
 * A reaction identifier: either a single RGI emoji (incl. ZWJ sequences, skin
 * tones, keycaps) or a workspace custom emoji as `:shortcode:` (#175).
 *
 * This is a URL path segment on the reaction routes, which is why the shortcode
 * charset is deliberately narrow — `[a-z0-9_-]` needs no escaping, so it
 * survives the round-trip through the path with or without percent-encoding.
 * Shape only: that a custom shortcode actually *exists* in the workspace is
 * checked when the reaction is added (see services/reactions.ts).
 */
export const EmojiParam = z
  .string()
  .min(1)
  .max(34) // ':' + 32 + ':'
  .refine((s) => /^\p{RGI_Emoji}$/v.test(s) || CUSTOM_EMOJI_RE.test(s), 'must be a single unicode emoji or a :shortcode:');

/** POST /v1/workspaces/:id/emoji — register an already-uploaded image. */
export const CreateWorkspaceEmojiBody = z.object({
  shortcode: z
    .string()
    .trim()
    .toLowerCase()
    .refine((s) => CUSTOM_EMOJI_CODE_RE.test(s), 'letters, digits, - and _ only; 2–32 characters'),
  fileId: z.string().uuid(),
});
export type CreateWorkspaceEmojiBody = z.infer<typeof CreateWorkspaceEmojiBody>;

// ---- notifications ---------------------------------------------
/**
 * `workspaceId` scopes the feed to one workspace — Activity is a row inside a
 * workspace's sidebar, so it must only show that workspace's rows. Optional so
 * clients built before the scoping (shipped macOS builds) still get the old
 * cross-workspace feed rather than an error.
 */
export const ListNotificationsQuery = z.object({
  workspaceId: z.string().uuid().optional(),
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuery>;

/**
 * Either a cursor (everything up to it) or a single row (one Activity click).
 * `workspaceId` scopes a cursor sweep, so opening Activity in one workspace
 * can't mark another workspace's older rows read. Ignored alongside `id`,
 * which already names a single row.
 */
export const MarkNotificationsReadBody = z
  .object({
    upToId: z.string().uuid().optional(),
    id: z.string().uuid().optional(),
    workspaceId: z.string().uuid().optional(),
  })
  .refine((b) => b.upToId !== undefined || b.id !== undefined, 'upToId or id required');
export type MarkNotificationsReadBody = z.infer<typeof MarkNotificationsReadBody>;

// ---- profiles --------------------------------------------------
export const NotificationPrefsBody = z.object({
  dm: z.boolean().optional(),
  mention: z.boolean().optional(),
  groupMention: z.boolean().optional(),
  threadReply: z.boolean().optional(),
  reaction: z.boolean().optional(),
  channelInvite: z.boolean().optional(),
  persistentBanners: z.boolean().optional(),
  sound: z.boolean().optional(),
});

/** #220: the only schemes a profile website may use.
 *
 * A profile website is rendered as a clickable link by every client, so an
 * arbitrary string here is stored XSS: `javascript:` and `data:` URLs run in
 * the viewer's page, not the author's. The allowlist lives on the write path
 * (below) so nothing unsafe is ever stored; clients re-check at render only as
 * defence in depth for rows written before this rule. */
export const PROFILE_WEBSITE_MAX = 200;
export const PROFILE_BIO_MAX = 500;
/** #434: the one-line role a Directory card shows under the name. Short on
 * purpose — a card truncates, so anything longer would only ever be read as an
 * ellipsis. */
export const PROFILE_TITLE_MAX = 80;

/** Absolute http(s) URL: a literal `http://` or `https://` prefix, a non-empty
 * host, and no whitespace anywhere.
 *
 * A regex rather than `new URL()` because this package compiles with `lib:
 * ES2024` and no DOM or node types, so `URL` is not in scope. Requiring the
 * string to *start* with the scheme is the property that matters: no amount of
 * trailing junk can turn `https://…` back into `javascript:…`, and leading
 * whitespace or control characters — which a browser would strip before
 * parsing an href — fail the match instead of being normalised away. */
const PROFILE_WEBSITE_RE = /^https?:\/\/[^\s/?#]+[^\s]*$/i;

/** True only for an absolute `http:` or `https:` URL. Everything else — other
 * schemes, relative paths, bare hostnames — is false. */
export function isProfileWebsiteUrl(s: string): boolean {
  return PROFILE_WEBSITE_RE.test(s);
}

export const PatchMeBody = z
  .object({
    displayName: z.string().min(1).max(80).optional(),
    // #220: '' clears the link; anything else must be an absolute http(s) URL.
    website: z
      .string()
      .max(PROFILE_WEBSITE_MAX)
      .refine((s) => s === '' || isProfileWebsiteUrl(s), 'must start with http:// or https://')
      .optional(),
    // #220: plain text, newlines preserved. '' clears it.
    bio: z.string().max(PROFILE_BIO_MAX).optional(),
    // #434: one-line role/title. Trimmed before the length check, so trailing
    // whitespace can neither be stored nor push a title over the limit; '' clears it.
    title: z.string().trim().max(PROFILE_TITLE_MAX).optional(),
    timezone: z
      .string()
      .max(64)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'must be a valid IANA timezone name')
      .optional(),
    // status: set both together ({emoji:'🎧', text:'Focusing'}); both '' clears it
    statusEmoji: z
      .string()
      .max(32)
      .refine((s) => s === '' || /^\p{RGI_Emoji}$/v.test(s), 'must be empty or a single unicode emoji')
      .optional(),
    statusText: z.string().max(80).optional(),
    // phase 10: per-user notification prefs (shallow-merged server-side) and
    // status-driven alert suppression (set by the status picker for Focusing /
    // In a meeting / At lunch / Do not disturb; cleared on Available/clear).
    notificationPrefs: NotificationPrefsBody.optional(),
    statusSuppressAlerts: z.boolean().optional(),
    // phase 11 §10: don't unfurl links in my own messages
    unfurlOwnLinks: z.boolean().optional(),
    // #489: hide my email from the API and drop me from the Directory. This is
    // the only write path, and it only ever writes the caller's own row — which
    // is what makes "settable by the user themselves" true by construction.
    privacyMode: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.displayName !== undefined ||
      b.website !== undefined ||
      b.bio !== undefined ||
      b.title !== undefined ||
      b.timezone !== undefined ||
      b.statusEmoji !== undefined ||
      b.statusText !== undefined ||
      b.notificationPrefs !== undefined ||
      b.statusSuppressAlerts !== undefined ||
      b.unfurlOwnLinks !== undefined ||
      b.privacyMode !== undefined,
    'nothing to update',
  )
  .refine(
    (b) => (b.statusEmoji === undefined) === (b.statusText === undefined),
    'statusEmoji and statusText must be set together',
  );
export type PatchMeBody = z.infer<typeof PatchMeBody>;

// ---- Phase 4: Slack app compatibility ---------------------------
/** Outgoing Events API types an app may subscribe to (operator ruling 5). */
export const APP_EVENT_TYPES = [
  'message.channels',
  'message.groups',
  'message.im',
  'app_mention',
  'reaction_added',
  'reaction_removed',
  'member_joined_channel',
  'member_left_channel',
  'channel_created',
  'channel_archive',
] as const;

export const CreateAppBody = z.object({
  name: z.string().min(1).max(80),
});
export type CreateAppBody = z.infer<typeof CreateAppBody>;

// ---- First-class AI agents (AGENT_MEMBERS.md) -------------------
/** Agent usernames: lowercase handle, 3-32 chars, letter/digit first. */
export const AGENT_USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/** Agent invite codes: `flow-XXXX-XXXX` over a no-confusables uppercase alphabet
 *  (generated in Flow, redeemed once). Short + readable by design. */
export const AGENT_INVITE_CODE_RE = /^flow-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

/** POST /v1/agents/redeem — the bridge trades a one-time invite code (which
 *  carries the sponsor + workspace) plus its durable credentials for a token.
 *  No sponsor approval: redeeming the code IS the authorization. */
export const RedeemAgentInviteBody = z.object({
  code: z.string().regex(AGENT_INVITE_CODE_RE, 'invalid invite code'),
  username: z.string().toLowerCase().regex(AGENT_USERNAME_RE, 'username: 3-32 lowercase letters, digits, . _ -'),
  key: z.string().min(16).max(128),
  name: z.string().min(1).max(80),
  description: z.string().max(200).optional(),
});
export type RedeemAgentInviteBody = z.infer<typeof RedeemAgentInviteBody>;

export const AgentLoginBody = z.object({
  username: z.string().toLowerCase().regex(AGENT_USERNAME_RE),
  key: z.string().min(16).max(128),
});
export type AgentLoginBody = z.infer<typeof AgentLoginBody>;

export const UpdateAppBody = z
  .object({
    eventUrl: z.string().url().max(500).nullable().optional(),
    eventTypes: z.array(z.enum(APP_EVENT_TYPES)).max(APP_EVENT_TYPES.length).optional(),
  })
  .refine((b) => b.eventUrl !== undefined || b.eventTypes !== undefined, 'nothing to update');
export type UpdateAppBody = z.infer<typeof UpdateAppBody>;

// ---- artifacts (phase 13: per-channel shared) -------------------
/** POST /v1/artifacts — pin a file as an artifact in a channel. Any member of
 * the channel can pin. Name defaults to the file name. `ownsFile` marks an
 * artifact whose file was uploaded for it (agent-generated) so deleting the
 * artifact can reap the file. Requester attribution is agent-only and identifies who
 * requested a report and which source thread should receive its report card. */
/** Pin a file (`fileId`) OR a link (`url`) — exactly one. A link artifact opens
 * in the co-browsing mini-browser; only http(s) URLs are accepted. */
export const CreateArtifactBody = z
  .object({
    channelId: z.string().uuid(),
    fileId: z.string().uuid().optional(),
    url: z.string().url().max(2048).optional(),
    name: z.string().min(1).max(255).optional(),
    ownsFile: z.boolean().optional(),
    /** Mini apps (MINI_APPS.md): register this link as an app — the row gets a
     * per-artifact secret, returned once in the create response. Link-only. */
    app: z.boolean().optional(),
    requesterUserId: z.string().uuid().optional(),
    sourceThreadRootId: z.string().uuid().optional(),
    operationId: z.string().uuid().optional(),
  })
  .refine((b) => (b.fileId === undefined) !== (b.url === undefined), {
    message: 'provide exactly one of fileId or url',
  })
  .refine((b) => b.url === undefined || /^https?:\/\//i.test(b.url), {
    message: 'url must be http(s)',
  })
  .refine((b) => b.app !== true || b.url !== undefined, {
    message: 'app is only valid with url',
  });
export type CreateArtifactBody = z.infer<typeof CreateArtifactBody>;

/** PATCH /v1/artifacts/:id — rename, re-point a file artifact at a new file (the
 * agent "update" path), or re-point a link artifact at a new url (the co-browse
 * navigation path). At least one field required. */
export const UpdateArtifactBody = z
  .object({
    name: z.string().min(1).max(255).optional(),
    fileId: z.string().uuid().optional(),
    url: z.string().url().max(2048).optional(),
    ownsFile: z.boolean().optional(),
  })
  .refine((b) => b.name !== undefined || b.fileId !== undefined || b.url !== undefined, {
    message: 'provide a name, fileId, and/or url',
  })
  .refine((b) => b.url === undefined || /^https?:\/\//i.test(b.url), {
    message: 'url must be http(s)',
  });
export type UpdateArtifactBody = z.infer<typeof UpdateArtifactBody>;

// ---- files: presigned direct upload (R2) -----------------------
export const PresignUploadBody = z.object({
  filename: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
});
export type PresignUploadBody = z.infer<typeof PresignUploadBody>;

// ---- scheduled messages (#419) ---------------------------------

/** 5-field cron (`min hour dom mon dow`); each field is `*`, a number, a
 * range, a step, or a comma list of those. Parsed properly server-side — this
 * only keeps obvious junk out of the column. */
export const CRON_FIELD_RE = /^(\*|\d+)(-\d+)?(\/\d+)?(,(\*|\d+)(-\d+)?(\/\d+)?)*$/;

export const RecurrenceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('once'), at: z.string().datetime({ offset: true }) }),
  z.object({ type: z.literal('hourly'), minute: z.number().int().min(0).max(59) }),
  z.object({
    type: z.literal('everyNHours'),
    hours: z.number().int().min(1).max(24),
    anchor: z.string().datetime({ offset: true }),
  }),
  z.object({
    type: z.literal('daily'),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    type: z.literal('weekly'),
    weekday: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    type: z.literal('cron'),
    expression: z
      .string()
      .min(1)
      .max(120)
      .refine(
        (e) => {
          const fields = e.trim().split(/\s+/);
          return fields.length === 5 && fields.every((f) => CRON_FIELD_RE.test(f));
        },
        { message: 'must be 5 cron fields: min hour dom mon dow' },
      ),
  }),
]);
export type RecurrenceInput = z.infer<typeof RecurrenceSchema>;

export const CreateScheduledMessageBody = z.object({
  /** Destination: a channel, or the author's own self-DM for "Just me". */
  channelId: z.string().uuid(),
  body: z.string().min(1).max(12000),
  recurrence: RecurrenceSchema,
  /** IANA zone. Defaults to the author's profile timezone when omitted. */
  timezone: z.string().min(1).max(64).optional(),
});
export type CreateScheduledMessageBody = z.infer<typeof CreateScheduledMessageBody>;

export const UpdateScheduledMessageBody = z
  .object({
    channelId: z.string().uuid().optional(),
    body: z.string().min(1).max(12000).optional(),
    recurrence: RecurrenceSchema.optional(),
    timezone: z.string().min(1).max(64).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to update' });
export type UpdateScheduledMessageBody = z.infer<typeof UpdateScheduledMessageBody>;

export const ListScheduledMessagesQuery = z.object({
  workspaceId: z.string().uuid(),
  /** Only rows this caller owns. Absent = everything they may see. */
  mine: z.enum(['true', 'false']).optional(),
});
export type ListScheduledMessagesQuery = z.infer<typeof ListScheduledMessagesQuery>;

// ---- push devices ----------------------------------------------
/**
 * APNs device token: hex, and a path segment on the DELETE route.
 *
 * Apple's tokens are 32 bytes today (64 hex chars) but Apple has explicitly
 * said the length is not fixed, so the bound is a sanity range rather than an
 * exact length — narrow enough that nothing but a token gets stored, wide
 * enough that a longer future token still registers. Case is not significant:
 * the server lowercases before storing (see services/devices.ts) so a client
 * that sends uppercase on one launch and lowercase on the next still hits the
 * same row instead of creating a second one.
 */
/** A push token: APNs' hex (32–256 chars) or FCM's opaque registration token
 * (URL-safe characters, colons included, up to 4 KB). The per-platform rule
 * below narrows it further at registration. */
export const DeviceTokenParam = z
  .string()
  .regex(/^[A-Za-z0-9_:-]{20,4096}$/, 'must be a device push token');

const APNS_TOKEN_RE = /^[0-9a-fA-F]{32,256}$/;

/** POST /v1/me/devices — register (or re-register) this device for push.
 *
 * `environment` and `bundleId` are APNs concepts (sandbox vs production, the
 * topic) with no FCM counterpart (ANDROID.md phase 3): required for ios,
 * absent for android. Enforced here, so the row shape follows the platform. */
export const RegisterDeviceFields = z.object({
  token: DeviceTokenParam,
  platform: z.enum(['ios', 'android']),
  environment: z.enum(['sandbox', 'production']).optional(),
  /** APNs topic — the app's bundle id, e.g. `im.freeflow.app`. */
  bundleId: z.string().min(1).max(255).optional(),
});
/** The per-platform rule, exported so a schema that extends the fields (the
 * server's multi-server variant) can apply the same one. */
export const refineDevicePlatform = (b: z.infer<typeof RegisterDeviceFields>, ctx: z.RefinementCtx): void => {
    if (b.platform === 'android') {
      // The row shape follows the platform both ways: an android row must not
      // carry the APNs fields, or the sender would trust an environment/topic
      // that means nothing to FCM.
      if (b.environment !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['environment'], message: 'not used for android' });
      if (b.bundleId !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bundleId'], message: 'not used for android' });
      return;
    }
    if (!APNS_TOKEN_RE.test(b.token)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['token'], message: 'must be a hex APNs device token' });
    }
    if (!b.environment) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['environment'], message: 'required for ios' });
    if (!b.bundleId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bundleId'], message: 'required for ios' });
};
export const RegisterDeviceBody = RegisterDeviceFields.superRefine(refineDevicePlatform);
export type RegisterDeviceBody = z.infer<typeof RegisterDeviceBody>;

// ---- community email (#481) ------------------------------------
/** POST /v1/workspaces/:id/email — admin broadcast to every human member.
 * Body is markdown; the server renders and sanitizes it (single source of
 * truth) so the composer's Preview tab and the sent mail cannot diverge. */
export const SendWorkspaceEmailBody = z.object({
  subject: z.string().trim().min(1).max(200),
  markdown: z.string().trim().min(1).max(10_000),
});
export type SendWorkspaceEmailBody = z.infer<typeof SendWorkspaceEmailBody>;

/** POST /v1/workspaces/:id/email/test (#484) — the same draft to the author
 * alone, so it takes the same body; the server adds the `[Test] ` prefix. */
export const SendTestWorkspaceEmailBody = SendWorkspaceEmailBody;
export type SendTestWorkspaceEmailBody = z.infer<typeof SendTestWorkspaceEmailBody>;

/** POST /v1/workspaces/:id/email/preview — same renderer, nothing sent. */
export const PreviewWorkspaceEmailBody = z.object({
  markdown: z.string().trim().min(1).max(10_000),
});
export type PreviewWorkspaceEmailBody = z.infer<typeof PreviewWorkspaceEmailBody>;

/** POST /v1/workspaces/:id/email/images (#492) — adopt an already-uploaded
 * file as a broadcast image. The bytes travel by the ordinary presign flow;
 * this only asks for the public URL that a mail client can fetch. */
export const AdoptEmailImageBody = z.object({
  fileId: z.string().uuid(),
});
export type AdoptEmailImageBody = z.infer<typeof AdoptEmailImageBody>;
