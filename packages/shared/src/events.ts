import type {
  ArtifactDTO,
  ChannelDTO,
  ChannelIndicatorState,
  HuddleInviteDTO,
  HuddleParticipantDTO,
  MessageDTO,
  NotificationDTO,
  UserDTO,
  WorkspaceMemberDTO,
} from './dto.js';

// WS event envelope, per phase1.md §3
export type EventType =
  | 'message.created'
  | 'message.updated'
  | 'message.deleted' // soft delete: row kept, renders as a "This message was deleted" tombstone
  | 'message.purged' // hard delete: row gone, clients remove it entirely — bot cleanup or owner/admin moderation
  | 'thread.reply'
  | 'typing'
  | 'presence'
  | 'channel.created'
  | 'channel.updated' // rename / topic change (ui_nits item 5)
  | 'channel.archived'
  | 'channel.indicator' // per-channel subject: the activity spinner turned on/off (#137)
  | 'channel.emoji' // per-channel subject: the persistent channel emoji changed (#396)
  | 'huddle.updated' // per-channel subject: huddle roster changed (Phase 1)
  | 'huddle.invite' // per-user notify subject: a DM huddle is ringing you, or the ring resolved (#436)
  | 'member.joined'
  | 'member.left'
  | 'member.updated' // workspace role change (admin panel)
  | 'reaction.added'
  | 'reaction.removed'
  | 'notification.created' // per-user notify subject (phase 2 §4)
  // per-user notify subject: rows this user just read (from the Activity feed,
  // or implicitly by visiting the channel/thread they came from). Carries the
  // fresh unread total so every session's badge converges without a refetch.
  | 'notification.read'
  | 'artifact.created' // per-channel subject (phase 13 — artifacts are shared per channel)
  | 'artifact.updated' // per-channel subject: rename or new backing file
  | 'artifact.deleted' // per-channel subject
  | 'user.updated' // meta subject of every workspace the user belongs to
  | 'workspace.updated' // meta subject; workspace-level changes (e.g. sidebar color)
  | 'workspace.joined' // per-user subject; gateway attaches the new workspace's subs, then forwards so other sessions refresh their workspace list
  // per-user notify subject (#359): someone invited me to a workspace, or the
  // invitation I was shown is gone (accepted elsewhere, declined, expired).
  // Clients refetch GET /v1/me/workspace-invites; `workspaceId` is the target.
  | 'workspace.invited';

export interface Event<T = unknown> {
  type: EventType;
  workspaceId: string;
  channelId?: string;
  ts: string; // ISO
  data: T;
}

export interface TypingData {
  userId: string;
  channelId: string;
  /** Set when typing in a thread's composer — the indicator belongs to that
   * thread, not the channel's main view. Absent = the main composer. */
  threadRootId?: string;
}

/**
 * The channel's *aggregate* indicator after a change (#137) — not one setter's.
 * Several agents can be working in one channel; clients only ever show one
 * spinner, so the server collapses them and sends the result. `state: null`
 * means the row goes quiet.
 */
export interface ChannelIndicatorData {
  channelId: string;
  state: ChannelIndicatorState | null;
}

/**
 * A channel's emoji after a change (#396). `emoji: null` means it was cleared.
 * Published only on a real change, on the same per-channel subject shape as
 * ChannelIndicatorData — so the gateway's visibility filter keeps a private
 * channel's decoration private too.
 */
export interface ChannelEmojiData {
  channelId: string;
  emoji: string | null;
}

/**
 * A channel's live huddle roster after a change (Phase 1). Like
 * ChannelIndicatorData, this is the aggregate, not one joiner/leaver — clients
 * replace their whole roster with it. An empty array means the huddle ended.
 */
export interface HuddleUpdatedData {
  channelId: string;
  participants: HuddleParticipantDTO[];
}

/**
 * A DM huddle invite changed (#436), delivered on each involved user's notify
 * subject — the caller's and every callee's, so one event drives both the
 * incoming-ring overlay and the caller's "ringing…"/"X isn't available" state.
 *
 * Clients render the ring while `invite.status === 'ringing'` and this user's
 * target row is still `ringing`; any other combination dismisses it. That rule
 * is what makes multi-device work without a second event type: accepting on a
 * phone flips the target to `accepted` and every other device of that user
 * takes the same event down. `answeredBySessionId` names the *socket* that
 * answered, so the answering device stays quiet while its siblings can say
 * "Answered on another device."
 */
export interface HuddleInviteData {
  invite: HuddleInviteDTO;
  answeredBySessionId?: string;
  /**
   * Display names of callees who could never be rung (offline, DND, muted DM,
   * or busy in another DM huddle). Only sent to the caller — it is the text of
   * "X isn't available."
   */
  unavailable?: string[];
}

export interface PresenceData {
  userId: string;
  status: 'online' | 'offline';
}

export interface ReactionEventData {
  messageId: string;
  channelId: string;
  emoji: string;
  userId: string;
}

export interface MemberLeftData {
  userId: string;
  channelId: string;
  workspaceId: string;
}

export type MessageEventData = MessageDTO;
export type ChannelCreatedData = ChannelDTO;
export type ChannelUpdatedData = ChannelDTO;
export type ChannelArchivedData = ChannelDTO;
export type MemberJoinedData = WorkspaceMemberDTO;
export type MemberUpdatedData = WorkspaceMemberDTO;
export type NotificationCreatedData = NotificationDTO;

export interface NotificationReadData {
  /** Ids that just flipped to read (empty when nothing was unread). */
  ids: string[];
  /** This user's unread notification count after the update — badge source. */
  unreadCount: number;
  readAt: string;
}
export type ArtifactEventData = ArtifactDTO;
export type UserUpdatedData = UserDTO;

/** `workspace.invited` payload (#359) — the invitation, or just its id when it ended. */
export interface WorkspaceInvitedData {
  inviteId: string;
  /** Present when the invitation is live; absent when it just ended. */
  invite?: import('./dto.js').PendingWorkspaceInviteDTO;
}

// ---- WS protocol frames (phase1.md §4) --------------------------
export type ClientFrame =
  // `workspaces` (optional, #364) narrows *presence* to the workspaces this
  // connection actually serves — an agent bridge runs one process per
  // workspace and would otherwise show a green dot in every workspace its
  // agent belongs to. Omitted means "all of them", which is what the human
  // clients want: one window is reachable in every workspace it shows.
  //
  // `since` (platform.md §5.2, "the UI socket is a consumer too"): the last
  // `cursor` seq this client applied. After `hello` the server sends what the
  // reader may see that was logged after it (each event with its `seq`), then a
  // `cursor` frame, then presence and live events. Omitted: no backlog.
  | { op: 'auth'; token: string; workspaces?: string[]; since?: number }
  // threadRootId scopes the indicator to a thread's composer; absent = the
  // channel's main composer. Older clients omit it and read as main-composer.
  | { op: 'typing'; channelId: string; threadRootId?: string }
  | { op: 'pong' };

export type ServerFrame =
  | { op: 'hello'; sessionId: string; heartbeat?: 'client' }
  // `seq` is set on an event replayed from the log (an `auth` with `since`);
  // live events carry none and are followed by a `cursor` frame instead.
  | { op: 'event'; event: Event; seq?: number }
  // The organization's event log reached `seq`: every event so far is applied.
  // Clients keep the latest as their cursor and send it as `since` on reconnect.
  | { op: 'cursor'; seq: number }
  // The `since` asked for is older than the log keeps: events `from`..`to` are
  // gone, and the backlog starts at the oldest kept. Refetch to be whole.
  | { op: 'gap'; from: number; to: number }
  // A `socket` subscription of this account has new events (a hint: read and
  // ack it over HTTP, GET /v1/events/subscriptions/:id).
  | { op: 'subscription'; id: string }
  | { op: 'ping' }
  | { op: 'error'; code: string; message: string };
