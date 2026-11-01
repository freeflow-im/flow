// TanStack Query hooks over the REST API (phase2.md §7: online-only —
// queries are the state; WS events invalidate them).
import { useEffect } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { BackendError, dedupeMessages, emailDomain, isSelfRegisterableDomain } from '@flow/shared';
import type {
  AgentInviteDTO,
  ArtifactDTO,
  ChannelDTO,
  ChannelFilePage,
  ChannelFileSort,
  FileDTO,
  MessageDTO,
  MessagePage,
  NotificationPage,
  OAuthIdentityDTO,
  PendingWorkspaceInviteDTO,
  Recurrence,
  ScheduledMessageDTO,
  UserDTO,
  WorkspaceDTO,
  WorkspaceEmojiDTO,
  WorkspaceMemberDTO,
} from '@flow/shared';
import {
  applyMessageEvent,
  markSendFailed,
  pendingId,
  removeMessageFromCache,
  removePendingMessage,
  type LocalMessage,
} from './lib/messageCache';
import { backgroundSync, useConnectionSync } from './lib/backgroundSync';
import { connectionManager } from './lib/connectionRuntime';
import { switcherEntries, syncedBindings, type SwitcherEntry } from './lib/workspaceSwitcher';
import { useBackend, useIsFlow } from './lib/backend';
import { useAuth, useRuntime } from './state';

// Chat-core hooks go through the connection's WorkspaceBackend (#545): the
// same hook serves a Flow server and a Slack team, and no component builds a
// provider path. Flow-only surfaces (artifacts, apps, invites, scheduling,
// emoji, pins) keep their REST calls but are disabled on other providers, so
// an unsupported feature never fires a request at the wrong backend.

/** Every workspace this browser can open — this connection's live list plus
 * the other Flow servers' and Slack teams' — for the switcher surfaces. */
export function useSwitcherEntries(): SwitcherEntry[] {
  const runtime = useRuntime();
  const workspaces = useWorkspaces();
  const syncStates = useConnectionSync();
  return switcherEntries(connectionManager().state, runtime.connectionId, workspaces.data, syncStates);
}

export function useWorkspaces() {
  const runtime = useRuntime();
  const backend = useBackend();
  const query = useQuery({
    queryKey: ['workspaces'],
    queryFn: async () => ({ workspaces: await backend.listWorkspaces() }),
    select: (d) => d.workspaces,
  });
  // The foreground connection has no background socket — this session is it —
  // so hand its unread numbers to the supervisor. Without this, switching away
  // from a server would blank its switcher badge until the background socket
  // came up and refreshed (docs/specs/multi-server-workspaces.md: "switcher
  // unread state aggregated from per-connection values").
  const workspaces = query.data;
  useEffect(() => {
    if (!workspaces) return;
    backgroundSync().reportForeground(runtime.connectionId, workspaces);
    // Record what this connection holds, so the rail and menus can list these
    // workspaces — with their avatars — while another connection is on screen.
    const manager = connectionManager();
    const userId = manager.state.sessions.find(s => s.connectionId === runtime.connectionId)?.userId;
    const next = userId ? syncedBindings(manager.state, runtime.connectionId, userId, workspaces) : null;
    if (next) manager.replaceBindings(next);
  }, [runtime.connectionId, workspaces]);
  return query;
}

/**
 * Workspace invitations addressed to me (#359) — what the Accept / Decline
 * cards on the workspace chooser are drawn from, and what puts the dot on the
 * rail's "+". Live via the `workspace.invited` event.
 */
export function useWorkspaceInvites() {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const isFlow = useIsFlow();
  return useQuery({
    queryKey: ['workspaceInvites'],
    queryFn: () => api<{ invites: PendingWorkspaceInviteDTO[] }>('GET', '/v1/me/workspace-invites'),
    select: (d) => d.invites,
    enabled: isFlow,
  });
}

/**
 * External identities linked to me (phase16 §5a). Only a user who actually
 * signed in with Google may open a workspace to their email domain, so the
 * toggle is offered off the back of this.
 */
export function useIdentities() {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const isFlow = useIsFlow();
  return useQuery({
    queryKey: ['identities'],
    queryFn: () => api<{ identities: OAuthIdentityDTO[] }>('GET', '/v1/me/identities'),
    select: (d) => d.identities,
    staleTime: Infinity,
    enabled: isFlow,
  });
}

/** The email domain this user may open a workspace to, or null when they have
 * no Google identity or it's a consumer domain (phase16 §5a denylist). */
export function useSelfRegisterDomain(): string | null {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const identities = useIdentities();
  const google = (identities.data ?? []).find((i) => i.provider === 'google');
  const domain = google ? emailDomain(google.email) : null;
  return domain && isSelfRegisterableDomain(domain) ? domain : null;
}

export function useChannels(workspaceId: string | null) {
  const backend = useBackend();
  return useQuery({
    queryKey: ['channels', workspaceId],
    queryFn: async () => ({ channels: (await backend.listConversations(workspaceId!)) as ChannelDTO[] }),
    select: (d) => d.channels,
    enabled: workspaceId !== null,
  });
}

/**
 * The channel list with archived public channels included (#588) — the channel
 * browser's data. Keyed under ['channels', workspaceId] so every invalidation
 * of the sidebar list refreshes this one too.
 */
export function useChannelsWithArchived(workspaceId: string | null, enabled = true) {
  const backend = useBackend();
  return useQuery({
    queryKey: ['channels', workspaceId, 'includeArchived'],
    queryFn: async () => ({
      channels: (await backend.listConversations(workspaceId!, { includeArchived: true })) as ChannelDTO[],
    }),
    select: (d) => d.channels,
    enabled: workspaceId !== null && enabled,
  });
}

/**
 * One channel by id. Archived channels are not in the sidebar list, so a miss
 * there falls back to the archived-inclusive list (#588) — that is how an
 * archived channel opened from the browser resolves, with `archivedAt` set.
 */
export function useChannel(workspaceId: string | null, channelId: string | null | undefined) {
  const channels = useChannels(workspaceId);
  const found = channelId ? (channels.data ?? []).find((c) => c.id === channelId) : undefined;
  const withArchived = useChannelsWithArchived(workspaceId, !!channelId && channels.isSuccess && !found);
  return found ?? (channelId ? (withArchived.data ?? []).find((c) => c.id === channelId) : undefined);
}

export function useMembers(workspaceId: string | null) {
  const backend = useBackend();
  return useQuery({
    queryKey: ['members', workspaceId],
    queryFn: async () => ({ members: await backend.listMembers(workspaceId!) }),
    select: (d) => d.members,
    enabled: workspaceId !== null,
  });
}

/** userId -> displayName map for the active workspace. */
export function useNameMap(workspaceId: string | null): Record<string, string> {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const members = useMembers(workspaceId);
  const map: Record<string, string> = {};
  for (const m of members.data ?? []) map[m.userId] = m.displayName;
  return map;
}

/**
 * userId -> displayName with the 🤖 badge appended for agents — display
 * strings only (testids and mention inserts keep the plain useNameMap names).
 */
export function useDisplayNameMap(workspaceId: string | null): Record<string, string> {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const members = useMembers(workspaceId);
  const map: Record<string, string> = {};
  for (const m of members.data ?? []) map[m.userId] = m.isAgent ? `${m.displayName} 🤖` : m.displayName;
  return map;
}

/** userId -> full member DTO (avatar + status) for the active workspace. */
export function useMemberMap(workspaceId: string | null): Record<string, WorkspaceMemberDTO> {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const members = useMembers(workspaceId);
  const map: Record<string, WorkspaceMemberDTO> = {};
  for (const m of members.data ?? []) map[m.userId] = m;
  return map;
}

/** Mint a one-time agent invite code for a workspace (AGENT_MEMBERS.md):
 * the sponsor hands it to their agent, which redeems it and joins immediately. */
export function useCreateAgentInvite(workspaceId: string | null) {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  return useMutation({
    mutationFn: () => api<AgentInviteDTO>('POST', `/v1/workspaces/${workspaceId}/agent-invites`),
  });
}

/** My artifact bookmarks in a workspace (phase 9) — WS artifact.* events invalidate. */
export function useArtifacts(workspaceId: string | null) {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const isFlow = useIsFlow();
  return useQuery({
    queryKey: ['artifacts', workspaceId],
    queryFn: () => api<{ artifacts: ArtifactDTO[] }>('GET', `/v1/workspaces/${workspaceId}/artifacts`),
    select: (d) => d.artifacts,
    enabled: workspaceId !== null && isFlow,
  });
}

/**
 * Every mini app I'm allowed to see in this workspace (#394) — apps in public
 * channels whether or not I've joined them, plus apps in private channels I'm
 * in. Powers the sidebar's "Apps" section; the host channel is resolved against
 * the channel list, which already carries public channels I'm not a member of.
 */
export function useAppArtifacts(workspaceId: string | null) {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const isFlow = useIsFlow();
  return useQuery({
    queryKey: ['app-artifacts', workspaceId],
    queryFn: () => api<{ artifacts: ArtifactDTO[] }>('GET', `/v1/workspaces/${workspaceId}/app-artifacts`),
    select: (d) => d.artifacts,
    enabled: workspaceId !== null && isFlow,
  });
}

/** Workspace custom emoji (#175). Every member can read this — you need the
 * images to render other people's reactions, not just to add your own. The
 * Slack connector serves the same route and shape from emoji.list; without the
 * emoji:read scope it refuses, and reactions keep their `:shortcode:` text. */
export function useWorkspaceEmoji(workspaceId: string | null) {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const isFlow = useIsFlow();
  return useQuery({
    queryKey: ['emoji', workspaceId],
    queryFn: () => api<{ emoji: WorkspaceEmojiDTO[] }>('GET', `/v1/workspaces/${workspaceId}/emoji`),
    select: (d) => d.emoji,
    enabled: workspaceId !== null,
    retry: isFlow ? 3 : false,
  });
}

/** `:shortcode:` → emoji, for rendering reactions. Keyed on the colon form so a
 * reaction string is a direct lookup. */
export function useWorkspaceEmojiMap(workspaceId: string | null): Record<string, WorkspaceEmojiDTO> {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const q = useWorkspaceEmoji(workspaceId);
  const map: Record<string, WorkspaceEmojiDTO> = {};
  for (const e of q.data ?? []) map[e.emoji] = e;
  return map;
}

/** Channel member ids — standard channels included (mention CTA, invite lists). */
export function useChannelMembers(channelId: string | null) {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  // Slack channel rosters are not fetched (the DTO carries DM members, and a
  // standard channel's roster would cost a rate-limited call per open).
  const isFlow = useIsFlow();
  return useQuery({
    queryKey: ['channelMembers', channelId],
    queryFn: () => api<{ userIds: string[] }>('GET', `/v1/channels/${channelId}/members`),
    select: (d) => d.userIds,
    enabled: channelId !== null && isFlow,
  });
}

/** A transcript page as the cache stores it: newest-first inside the page,
 * plus the provider's cursor and its "there is more but I held it back"
 * signal, so the list can say so instead of pretending the history ended. */
export type HistoryQueryPage = MessagePage & { nextCursor: string | null; partial: boolean; retryAfterMs?: number };

export function useMessages(channelId: string | null) {
  const backend = useBackend();
  return useInfiniteQuery({
    queryKey: ['messages', channelId],
    queryFn: async ({ pageParam }): Promise<HistoryQueryPage> => {
      const page = await backend.history(channelId!, { cursor: pageParam || null, limit: 50 });
      return { messages: [...page.messages].reverse(), hasMore: page.cursor !== null, nextCursor: page.cursor, partial: page.partial, ...(page.retryAfterMs ? { retryAfterMs: page.retryAfterMs } : {}) };
    },
    initialPageParam: '',
    getNextPageParam: (last) => (last.hasMore && last.nextCursor ? last.nextCursor : undefined),
    enabled: channelId !== null,
    // A rate-limited provider says when to come back; retrying sooner only
    // burns the shared budget (spec: honor Retry-After, never retry blindly).
    retry: (count, error) => !(error instanceof BackendError && (error.code === 'rate_limited' || error.code === 'unsupported')) && count < 1,
  });
}

/**
 * Channel Files panel (#347): every file shared in the channel, one sort order
 * at a time. Keyed by sort so switching links swaps to a cached list rather
 * than refetching, and paged with the server's opaque cursor.
 */
export function useChannelFiles(channelId: string | null, sort: ChannelFileSort) {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const isFlow = useIsFlow();
  return useInfiniteQuery({
    queryKey: ['channelFiles', channelId, sort],
    queryFn: ({ pageParam }) =>
      api<ChannelFilePage>(
        'GET',
        `/v1/channels/${channelId}/files?sort=${sort}&limit=30${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: channelId !== null && isFlow,
  });
}

export function usePinnedMessages(channelId: string | null) {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const isFlow = useIsFlow();
  return useQuery({
    queryKey: ['pins', channelId],
    queryFn: () => api<{ messages: MessageDTO[] }>('GET', `/v1/channels/${channelId}/pins`),
    select: (d) => d.messages,
    enabled: channelId !== null && isFlow,
  });
}

/** Flattened ascending message list from the infinite query pages. */
export function flattenMessages(pages: MessagePage[] | undefined): MessageDTO[] {
  if (!pages) return [];
  const all: MessageDTO[] = [];
  for (let i = pages.length - 1; i >= 0; i--) {
    const page = pages[i]!;
    for (let j = page.messages.length - 1; j >= 0; j--) all.push(page.messages[j]!);
  }
  // A provider page can overlap the one before it (a message that arrived
  // live is also in the next page fetched); one row per id, first seen wins.
  return dedupeMessages(all);
}

/** `channelId` is what a provider that keys threads by channel needs (Slack);
 * Flow resolves the root by id alone, so callers that only know the root can
 * pass null and Flow still answers. */
export function useThread(rootId: string | null, channelId: string | null = null) {
  const backend = useBackend();
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['thread', rootId],
    queryFn: async (): Promise<MessagePage & { root: MessageDTO }> => {
      // A Slack thread lives in a channel; find it from the loaded transcript
      // when the caller did not say. Flow ignores the channel entirely.
      const known = channelId ?? qc.getQueriesData<{ pages: MessagePage[] }>({ queryKey: ['messages'] })
        .flatMap(([key, data]) => (data?.pages ?? []).some((p) => p.messages.some((m) => m.id === rootId)) ? [String(key[1])] : [])[0] ?? '';
      const page = await backend.thread(known, rootId!);
      return { root: page.root, messages: page.replies, hasMore: page.partial };
    },
    enabled: rootId !== null,
    retry: (count, error) => !(error instanceof BackendError && (error.code === 'rate_limited' || error.code === 'unsupported')) && count < 1,
  });
}

// Activity is a row inside a workspace, so both the feed and its badge are
// scoped to that workspace — the workspaceId is part of the query key so a
// switch refetches rather than showing the previous workspace's rows.
export function useNotifications(enabled: boolean, workspaceId: string | null) {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const isFlow = useIsFlow();
  return useQuery({
    queryKey: ['notifications', workspaceId],
    queryFn: () => api<NotificationPage>('GET', `/v1/me/notifications?limit=50&workspaceId=${workspaceId!}`),
    enabled: enabled && workspaceId !== null && isFlow,
  });
}

export function useNotificationUnread(workspaceId: string | null) {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const isFlow = useIsFlow();
  return useQuery({
    queryKey: ['notificationUnread', workspaceId],
    queryFn: () => api<NotificationPage>('GET', `/v1/me/notifications?limit=1&workspaceId=${workspaceId!}`),
    enabled: workspaceId !== null && isFlow,
    select: (d) => d.unreadCount,
  });
}

interface SendInput {
  body: string;
  threadRootId?: string;
  fileIds?: string[];
  mentions?: string[];
  /** Full DTOs of the attached files so the optimistic row renders them. */
  files?: FileDTO[];
}
type SendVars = SendInput & { clientMsgId: string };

/** The exact outgoing vars for each in-flight/failed send, keyed by
 * clientMsgId, so Retry can replay the identical POST (mentions included —
 * those aren't recoverable from the stored wire body). Cleared on success or
 * discard; a session-scoped map (the optimistic cache is memory-only too). */
const outgoingSends = new Map<string, SendVars>();

/** Local-first send (macOS parity): a pending row lands in the cache before
 * the POST leaves; the response (or the WS echo, whichever wins) reconciles
 * it via clientMsgId. A failure flips the row to `failed` (kept in place with
 * a Retry affordance) rather than dropping it. */
export function useSendMessage(channelId: string) {
  const backend = useBackend();
  const qc = useQueryClient();
  const auth = useAuth();
  const optimisticRow = (vars: SendVars): LocalMessage => ({
    id: pendingId(vars.clientMsgId),
    channelId,
    userId: auth.user.id,
    threadRootId: vars.threadRootId ?? null,
    clientMsgId: vars.clientMsgId,
    body: vars.body,
    createdAt: new Date().toISOString(),
    editedAt: null,
    deletedAt: null,
    pinnedAt: null,
    pinnedBy: null,
    systemKind: null,
    scheduled: false,
    replyCount: 0,
    lastReplyAt: null,
    replyParticipantUserIds: [],
    reactions: [],
    unfurls: [], // cards arrive from the server, never optimistically
    files: vars.files ?? [],
    pending: true,
  });
  const mutation = useMutation({
    mutationFn: async (vars: SendVars): Promise<MessageDTO> =>
      (await backend.send({
        channelId,
        clientMsgId: vars.clientMsgId,
        body: vars.body,
        ...(vars.threadRootId ? { threadRootId: vars.threadRootId } : {}),
        ...(vars.fileIds?.length ? { fileIds: vars.fileIds } : {}),
        ...(vars.mentions?.length ? { mentions: vars.mentions } : {}),
      })).message,
    onMutate: (vars) => {
      outgoingSends.set(vars.clientMsgId, vars);
      // Replaces the failed row in place on a retry (sameRow matches clientMsgId).
      applyMessageEvent(qc, optimisticRow(vars), true);
    },
    onSuccess: (msg, vars) => {
      outgoingSends.delete(vars.clientMsgId);
      applyMessageEvent(qc, msg, true);
    },
    onError: (_err, vars) => markSendFailed(qc, channelId, vars.clientMsgId, vars.threadRootId),
  });
  return {
    ...mutation,
    mutate: (input: SendInput, opts?: Parameters<typeof mutation.mutate>[1]) =>
      mutation.mutate({ ...input, clientMsgId: crypto.randomUUID() }, opts),
    /** Re-POST a failed message with its original clientMsgId (idempotent
     * server-side). Flips the row back to pending and re-bumps the rollup. */
    retry: (clientMsgId: string, opts?: Parameters<typeof mutation.mutate>[1]) => {
      const vars = outgoingSends.get(clientMsgId);
      if (vars) mutation.mutate(vars, opts);
    },
    /** Drop a failed message and forget its vars (the "×" beside Retry). */
    discard: (clientMsgId: string, threadRootId?: string) => {
      outgoingSends.delete(clientMsgId);
      removePendingMessage(qc, channelId, clientMsgId, threadRootId);
    },
  };
}

export function useToggleReaction() {
  const backend = useBackend();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { message: MessageDTO; emoji: string; mine: boolean }) =>
      backend.setReaction(input.message.channelId, input.message.id, input.emoji, !input.mine),
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: ['messages', input.message.channelId] });
      if (input.message.threadRootId) {
        void qc.invalidateQueries({ queryKey: ['thread', input.message.threadRootId] });
      } else {
        void qc.invalidateQueries({ queryKey: ['thread', input.message.id] });
      }
    },
  });
}

export function useTogglePin() {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (message: MessageDTO) =>
      api<MessageDTO>(
        message.pinnedAt ? 'DELETE' : 'PUT',
        `/v1/messages/${message.id}/pin`,
      ),
    onSuccess: (updated) => {
      applyMessageEvent(qc, updated, false);
      void qc.invalidateQueries({ queryKey: ['pins', updated.channelId] });
    },
  });
}

/**
 * Advance the channel read cursor — which also clears that channel's Activity
 * notifications server-side (issue #63). With `threadRootId` it means "I'm
 * looking at this thread": the thread's rows go read and the channel cursor
 * (top-level only) stays put.
 */
export function useMarkRead() {
  const backend = useBackend();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { channelId: string; lastReadMsgId: string; threadRootId?: string }) =>
      backend.markRead(input.channelId, input.lastReadMsgId, input.threadRootId ? { threadRootId: input.threadRootId } : {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
      // Reading a channel drops that workspace's rail badge (#345) — the total
      // lives on the workspace list, so it has to be refetched too.
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
}

export function useMe() {
  const backend = useBackend();
  return useQuery({
    queryKey: ['me'],
    queryFn: () => backend.me(),
  });
}

/** Edit and delete through the backend (#545): the message list and composer
 * used to POST Flow paths directly, which is exactly the fall-through a Slack
 * workspace must never take. */
export function useEditMessage() {
  const backend = useBackend();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { message: MessageDTO; body: string }) => backend.edit(input.message.channelId, input.message.id, input.body),
    onSuccess: (updated) => applyMessageEvent(qc, updated, false),
  });
}

export function useDeleteMessage() {
  const backend = useBackend();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { message: MessageDTO; purge?: boolean }) => backend.delete(input.message.channelId, input.message.id, input.purge ? { purge: true } : {}),
    onSuccess: (_r, input) => {
      // Flow echoes a tombstone or a purge event over the socket; Slack's
      // stream does the same a poll later. Reflect it now for both.
      if (input.purge || backend.provider !== 'flow') removeMessageFromCache(qc, input.message);
      else applyMessageEvent(qc, { ...input.message, deletedAt: new Date().toISOString(), body: '' }, false);
    },
  });
}

/**
 * Scheduled messages (#420) — the Scheduled panel's list. The server already
 * scopes it (your rows plus rows destined for channels you're in), so `mine`
 * is only the "Owned by me" narrowing, and it rides the query key so toggling
 * the filter swaps to a cached list instead of refetching.
 */
export function useScheduledMessages(workspaceId: string | null, mine: boolean) {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const isFlow = useIsFlow();
  return useQuery({
    queryKey: ['scheduledMessages', workspaceId, mine],
    queryFn: () =>
      api<{ scheduledMessages: ScheduledMessageDTO[] }>(
        'GET',
        `/v1/scheduled-messages?workspaceId=${workspaceId!}${mine ? '&mine=true' : ''}`,
      ),
    select: (d) => d.scheduledMessages,
    enabled: workspaceId !== null && isFlow,
  });
}

export interface ScheduledMessageInput {
  channelId: string;
  body: string;
  recurrence: Recurrence;
  timezone?: string;
}

/** Create, edit, delete, pause/resume and run-now, all invalidating the one
 * list query — every row action updates the panel without a reload. */
export function useScheduledMessageActions() {
  const runtime = useRuntime();
  const api = runtime.api.bind(runtime);
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['scheduledMessages'] });

  const create = useMutation({
    mutationFn: (input: ScheduledMessageInput) =>
      api<ScheduledMessageDTO>('POST', '/v1/scheduled-messages', input),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: ({ id, ...patch }: Partial<ScheduledMessageInput> & { id: string; enabled?: boolean }) =>
      api<ScheduledMessageDTO>('PATCH', `/v1/scheduled-messages/${id}`, patch),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api('DELETE', `/v1/scheduled-messages/${id}`),
    onSuccess: refresh,
  });
  const setEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api<ScheduledMessageDTO>('POST', `/v1/scheduled-messages/${id}/${enabled ? 'resume' : 'pause'}`),
    onSuccess: refresh,
  });
  const runNow = useMutation({
    mutationFn: (id: string) => api<ScheduledMessageDTO>('POST', `/v1/scheduled-messages/${id}/run`),
    onSuccess: refresh,
  });
  return { create, update, remove, setEnabled, runNow };
}
