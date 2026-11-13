import { isLookingAtApp, onLookingChange } from '../lib/host';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MessageDTO } from '@flow/shared';
import { typingKey, useAuth, useLive, useSelection } from '../state';
import { useHuddle } from '../huddle';
import { useArtifacts, useChannel, useChannelMembers, useDisplayNameMap, useMarkRead, useMemberMap, useMessages, useNameMap, usePinnedMessages, useTogglePin, useWorkspaces, flattenMessages } from '../hooks';
import { dmTitle } from './Sidebar';
import { Avatar } from './Avatar';
import ChannelMembersPopover, { type MemberRow } from './ChannelMembersPopover';
import ChannelOverflowMenu from './ChannelOverflowMenu';
import MessageList, { PinIcon } from './MessageList';
import Composer, { arrowUpEdit } from './Composer';
import FindBar, { useChatFind } from './FindBar';
import { MobileMenuButton } from './MobileMenuButton';
import { useHoverTooltip } from './HoverTooltip';
import { AddPeopleModal, ChannelOptionsModal, Modal, UserCard } from './modals';
import { renderBody } from '../lib/format';
import { useSyncBar } from '../lib/syncBar';
import { useCapabilities } from '../lib/backend';
import { useBoundApi } from '../lib/useBoundApi';
import { useQueryClient } from '@tanstack/react-query';

export default function ChannelView({ channelId }: { channelId: string }) {
  const { api: boundApi } = useBoundApi();
  const qc = useQueryClient();
  const auth = useAuth();
  const sel = useSelection();
  const live = useLive();
  const huddle = useHuddle();
  const memberMap = useMemberMap(sel.workspaceId);
  const names = useNameMap(sel.workspaceId);
  const displayNames = useDisplayNameMap(sel.workspaceId); // agent names carry the 🤖 badge
  const messagesQ = useMessages(channelId);
  const pins = usePinnedMessages(channelId);
  const markRead = useMarkRead();
  // Capability gating (#545): the header's controls are not rendered for a
  // backend that cannot do them.
  const caps = useCapabilities();
  const lastReadRef = useRef<string | null>(null);
  const [cardUserId, setCardUserId] = useState<string | null>(null);
  const [editChannel, setEditChannel] = useState(false);
  const [addPeople, setAddPeople] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  // Reconnect bar (#234) — delayed and floored so short drops don't flash.
  const showSyncBar = useSyncBar(live.syncing);
  // cmd-F find bar (#518) — searches the transcript this pane has loaded.
  const paneRef = useRef<HTMLElement>(null);

  // Falls back to the archived-inclusive list, so an archived channel opened
  // from the channel browser (#588) resolves — read-only, with its banner.
  const channel = useChannel(sel.workspaceId, channelId);
  const archived = !!channel?.archivedAt;
  // This channel's artifacts, for the "⋯" menu's Artifacts section (#188).
  const artifacts = useArtifacts(sel.workspaceId);
  const channelArtifacts = useMemo(
    () => (artifacts.data ?? []).filter((a) => a.channelId === channelId),
    [artifacts.data, channelId],
  );
  const messages = useMemo(() => flattenMessages(messagesQ.data?.pages), [messagesQ.data]);
  // The find bar re-runs whenever the loaded set changes — a new message, or an
  // older page arriving — so the counter never describes a stale transcript.
  const find = useChatFind(paneRef, `${channelId}:${messages.length}:${messages.at(-1)?.id ?? ''}`);

  // Mark read whenever the newest visible message changes — but only while
  // the tab is actually visible. The WS keeps filling the cache in a hidden
  // tab, and marking read there silently consumed the very notifications the
  // banner path was raising (the read cursor also clears that channel's
  // notification rows server-side since #63). Coming back catches up.
  const newestId = messages.length > 0 ? messages[messages.length - 1]!.id : null;
  useEffect(() => {
    const sync = () => {
      if (!isLookingAtApp()) return;
      // A non-member previewing a public or archived channel (#588) has no
      // read cursor to move — the server would answer 403.
      if (channel && !channel.isMember) return;
      if (newestId && newestId !== lastReadRef.current) {
        lastReadRef.current = newestId;
        markRead.mutate({ channelId, lastReadMsgId: newestId });
      }
    };
    sync();
    return onLookingChange(sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestId, channelId, channel?.isMember]);

  // Jump-to-message (phase 12): a target from the Activity feed may sit beyond
  // the loaded pages — page older history until it's in the list (MessageList
  // then scrolls to it). Give up (and release the target) once history is
  // exhausted. Thread-reply targets are handled by ThreadPanel, not here.
  const focusId = sel.threadRootId ? null : sel.focusMessageId;
  useEffect(() => {
    if (!focusId) return;
    if (messages.some((m) => m.id === focusId)) return; // loaded — MessageList takes it
    if (messagesQ.hasNextPage && !messagesQ.isFetchingNextPage) {
      void messagesQ.fetchNextPage();
    } else if (!messagesQ.hasNextPage) {
      sel.clearFocusMessage(); // not in this channel's history
    }
  }, [focusId, messages, messagesQ.hasNextPage, messagesQ.isFetchingNextPage, sel]);

  const isDm = channel && channel.kind !== 'standard';
  // 1:1 DM header click opens the other member's card (ruling 4); self-DM shows your own.
  const dmOtherId =
    channel?.kind === 'dm'
      ? (channel.memberIds ?? []).find((id) => id !== auth.user.id) ?? auth.user.id
      : null;
  const title = channel
    ? channel.kind === 'standard'
      ? channel.name ?? ''
      : dmTitle(channel, displayNames, auth.user.id)
    : '';
  // A DM with a shared agent is not private (docs/specs/agents.md §1): anyone in the organization can ask it, and it keeps
  // no secrets from them. Every agent on a roster is a shared one; personal agents are never members.
  const workspaces = useWorkspaces();
  const dmAgent = channel?.kind === 'dm' && dmOtherId && dmOtherId !== auth.user.id && memberMap[dmOtherId]?.isAgent ? memberMap[dmOtherId] : null;
  const workspaceName = workspaces.data?.find((w) => w.id === sel.workspaceId)?.name ?? 'this organization';

  // Header avatar stack: this channel's membership for every kind (issue #70 —
  // standard channels used to show the whole workspace roster, which said
  // nothing about who was actually in the channel). The DTO only carries
  // memberIds for DMs, so it's the fallback while the fetch is in flight.
  const chanMembers = useChannelMembers(channelId);
  const headerIds = chanMembers.data ?? channel?.memberIds ?? [];
  const shown = headerIds.slice(0, 3);
  const extra = headerIds.length - shown.length;

  // Who you may take out of the channel, as the server allows it: an owner or admin anyone, a person their own assistant.
  const myRole = memberMap[auth.user.id]?.role;
  const canRemove = (id: string): boolean => {
    if (channel?.kind !== 'standard' || archived || id === auth.user.id) return false;
    const m = memberMap[id];
    return myRole === 'owner' || myRole === 'admin' || (m?.kind === 'personal_agent' && m.agentRuntime === 'hosted' && m.sponsorId === auth.user.id);
  };
  const removeMember = async (userId: string) => {
    if (!channel) return;
    await boundApi('DELETE', `/v1/channels/${channel.id}/members/${userId}`);
    await qc.invalidateQueries({ queryKey: ['channelMembers', channel.id] });
    await qc.invalidateQueries({ queryKey: ['channels', channel.workspaceId] });
  };

  const memberRows: MemberRow[] = headerIds.map((id) => {
    const m = memberMap[id];
    return {
      userId: id,
      displayName: m?.displayName ?? 'Unknown',
      avatarUrl: m?.avatarUrl,
      isAgent: m?.isAgent ?? false,
      statusEmoji: m?.statusEmoji ?? '',
      statusText: m?.statusText ?? '',
      // You're online by definition — this client is the one connected.
      online: id === auth.user.id || live.isOnline(id),
      isSelf: id === auth.user.id,
      removable: canRemove(id),
    };
  });

  // Switching channels shouldn't leave the previous channel's roster hanging open.
  useEffect(() => setMembersOpen(false), [channelId]);

  // Huddles run in any entity now — channel, DM or group DM (#436) — just not
  // in an archived one. In a channel the button joins something ambient; in a
  // DM the same button *rings* the other member(s), so it says so.
  const huddleParticipants = channel?.huddleParticipants ?? [];
  const inThisHuddle = huddle.channelId === channelId;
  const huddleEligible = !!channel && !channel.archivedAt && caps.huddles.state !== 'unavailable';
  const canEditChannel = channel?.kind === 'standard' && !archived && caps.channelManagement.state !== 'unavailable';
  const isDmHuddle = !!channel && channel.kind !== 'standard';

  // #392: the header shows the topic on one truncated line — hovering it gives
  // the whole thing, raw, matching the sidebar tooltip.
  const topicTip = useHoverTooltip(channel?.topic, 'channel-topic-tooltip');

  // Main-composer typing only — thread typing shows in its own panel. An agent
  // at work "thinks" rather than "types" (ui_nits), so carry the isAgent flag.
  const typers = Object.entries(live.typing[typingKey(channelId)] ?? {})
    .filter(([uid, ts]) => Date.now() - ts < 5000 && uid !== auth.user.id)
    .map(([uid]) => ({ name: names[uid] ?? 'Someone', isAgent: memberMap[uid]?.isAgent ?? false }));

  // #387: the chat pane sits on pure white, not the app shell's warm
  // `bg-base` — messages read cleaner, and it is what the macOS client paints
  // now too. Every other surface keeps `bg-base`.
  return (
    <section ref={paneRef} className="flex min-w-0 flex-1 flex-col bg-white">
      <header className="flex h-[60px] shrink-0 items-center justify-between border-b border-hairline px-[22px] max-md:px-3">
        <MobileMenuButton />
        <div className="min-w-0 flex-1">
          <h2
            data-testid="channel-header"
            className={`truncate text-[15px] font-bold ${dmOtherId || canEditChannel ? 'cursor-pointer hover:underline' : ''}`}
            title={canEditChannel ? 'Edit name & topic' : undefined}
            onClick={
              dmOtherId
                ? () => setCardUserId(dmOtherId)
                // Clicking a standard channel's name opens the name/topic editor (ui_nits item 5).
                : canEditChannel
                  ? () => setEditChannel(true)
                  : undefined
            }
          >
            {channel?.kind === 'standard' ? <><span className="text-muted"># </span>{title}</> : title}
          </h2>
          {dmAgent && (
            <p data-testid="dm-agent-note" className="truncate text-xs text-muted">
              Not private: anyone in {workspaceName} can ask {dmAgent.displayName}.
            </p>
          )}
          {/* #194: the topic runs through the same inline renderer as a message
              body, so a URL in it is a real link (new tab) instead of grey text. */}
          {channel?.topic && (
            // #392: the header's topic line is one truncated line, so hovering
            // it shows the whole thing — same tooltip as the sidebar, and the
            // raw text rather than the rendered links. The handlers go on the
            // line itself, not the text inside it, so a pointer anywhere along
            // the row counts as hovering it.
            <p data-testid="channel-topic" {...topicTip.anchorProps} className="truncate text-xs text-muted">
              {renderBody(channel.topic, names, auth.user.id)}
            </p>
          )}
          {topicTip.tooltip}
        </div>
        <div className="relative flex shrink-0 items-center gap-3">
          {huddleEligible && (
            <button
              type="button"
              data-testid={inThisHuddle ? 'huddle-leave' : 'huddle-join'}
              title={inThisHuddle ? 'Leave huddle' : isDmHuddle ? 'Start a huddle — this rings them' : 'Join huddle'}
              disabled={huddle.connecting}
              className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold max-md:hidden ${
                inThisHuddle
                  ? 'bg-accent/15 text-accent-soft hover:bg-accent/25'
                  : 'text-muted hover:bg-daypill/60 hover:text-ink'
              }`}
              onClick={() => {
                if (inThisHuddle) void huddle.leave();
                else if (channel) void huddle.join(channelId, channel.workspaceId).catch(() => {});
              }}
            >
              🎙 {inThisHuddle ? 'Leave Huddle' : isDmHuddle ? 'Huddle' : 'Join Huddle'}
              {/* ambient indicator: a huddle live but not yet joined shows who's in it */}
              {!inThisHuddle && huddleParticipants.length > 0 && (
                <span className="rounded-full bg-accent/15 px-1.5 text-accent-soft">{huddleParticipants.length}</span>
              )}
            </button>
          )}
          {/* member stack — opens the roster; dropped on mobile so the title gets the room */}
          <button
            data-testid="channel-members-trigger"
            data-members-trigger
            title="View members"
            aria-haspopup="dialog"
            aria-expanded={membersOpen}
            className="flex items-center rounded-lg px-1 py-0.5 hover:bg-daypill/60 max-md:hidden"
            onClick={() => setMembersOpen((v) => !v)}
          >
            {shown.map((id, i) => {
              const m = memberMap[id];
              return (
                <span key={id} className={i > 0 ? '-ml-2.5' : ''}>
                  <Avatar
                    userId={id}
                    name={m?.displayName ?? '?'}
                    avatarUrl={m?.avatarUrl}
                    size={26}
                    radius={13}
                    className="ring-2 ring-white"
                  />
                </span>
              );
            })}
            {extra > 0 && <span className="ml-1.5 text-xs text-muted">+{extra}</span>}
            {/* nothing to stack yet (fetch in flight) — keep a clickable target */}
            {shown.length === 0 && <span className="text-sm text-muted">👥</span>}
          </button>
          {/* #188: pins, artifacts and channel options share one "⋯" menu */}
          {caps.pins.state !== 'unavailable' && <button
            type="button"
            data-testid="channel-menu-trigger"
            data-overflow-trigger
            title="Channel menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="rounded-lg px-1.5 py-1 text-[17px] leading-none text-muted hover:bg-daypill/60 hover:text-ink"
            onClick={() => { setMenuOpen((v) => !v); setMembersOpen(false); }}
          >
            ⋯
          </button>}
          {membersOpen && (
            <ChannelMembersPopover
              rows={memberRows}
              loading={chanMembers.isLoading}
              onClose={() => setMembersOpen(false)}
              onSelect={(id) => { setMembersOpen(false); setCardUserId(id); }}
              onAdd={channel?.kind === 'standard' && !archived ? () => { setMembersOpen(false); setAddPeople(true); } : undefined}
              onRemove={removeMember}
            />
          )}
          {menuOpen && (
            <ChannelOverflowMenu
              artifacts={channelArtifacts}
              pinCount={pins.data?.length ?? 0}
              showOptions={channel?.kind === 'standard' && !archived}
              onOpenFiles={() => sel.openFiles(true)}
              onOpenPins={() => setPinsOpen(true)}
              onOpenArtifact={(id) => sel.selectArtifact(id)}
              onOpenOptions={() => setEditChannel(true)}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>
      </header>

      {/* #518: the find bar slides in under the header, above the transcript —
          it pushes the list down rather than floating over the newest message. */}
      {find.open && <FindBar find={find} />}

      {/* #588: archived channels open read-only from the channel browser. */}
      {archived && (
        <div
          data-testid="archived-banner"
          role="status"
          className="shrink-0 border-b border-orange-200 bg-orange-50 px-[22px] py-1.5 text-xs text-orange-800"
        >
          📦 This channel was archived{channel?.archivedAt ? ` on ${new Date(channel.archivedAt).toLocaleDateString()}` : ''}.
          Its history is read-only — no one can post, join or react here.
        </div>
      )}

      {showSyncBar && (
        <div
          className="mc-sync-bar shrink-0"
          data-testid="sync-bar"
          role="status"
          aria-label="Reconnecting"
        >
          <span />
        </div>
      )}

      {/* key: fresh list per channel so the mount effect re-runs — it restores
          this channel's remembered scroll position (or lands at the bottom when
          there's none / it's stale), keyed by channelId in scrollMemory. */}
      <MessageList
        key={channelId}
        scrollKey={channelId}
        messages={messages}
        names={names}
        membersById={memberMap}
        hasMore={messagesQ.hasNextPage ?? false}
        onLoadOlder={() => void messagesQ.fetchNextPage()}
        showThreadAffordances
        readOnly={archived}
        unreadThreadRootIds={channel?.unreadThreadRootIds ?? []}
        focusMessageId={focusId}
        onFocused={() => sel.clearFocusMessage()}
      />

      <div className="h-5 px-[22px] text-xs text-muted" data-testid="typing-indicator-slot">
        {typers.length === 1 && (
          <span data-testid="typing-indicator">
            {typers[0]!.name} is {typers[0]!.isAgent ? 'thinking' : 'typing'}…
          </span>
        )}
        {typers.length > 1 && <span data-testid="typing-indicator">Several people are typing…</span>}
      </div>

      {archived ? (
        <p data-testid="archived-composer-note" className="px-[22px] pb-[22px] text-sm text-muted">This channel is archived and read-only.</p>
      ) : (
        <Composer
          channelId={channelId}
          placeholder={`Message ${channel?.kind === 'standard' ? `#${title}` : title}`}
          onArrowUpEdit={arrowUpEdit(messages, auth.user.id, sel.setEditingMessage)}
          editingMessage={messages.find((m) => m.id === sel.editingMessageId)}
        />
      )}

      {cardUserId && <UserCard userId={cardUserId} onClose={() => setCardUserId(null)} />}
      {editChannel && channel && <ChannelOptionsModal channel={channel} onClose={() => setEditChannel(false)} />}
      {addPeople && channel && <AddPeopleModal channel={channel} onClose={() => setAddPeople(false)} />}
      {pinsOpen && (
        <PinnedMessagesModal
          messages={pins.data ?? []}
          names={names}
          loading={pins.isLoading}
          onClose={() => setPinsOpen(false)}
        />
      )}
    </section>
  );
}

export function PinnedMessagesModal({
  messages,
  names,
  loading,
  onClose,
}: {
  messages: MessageDTO[];
  names: Record<string, string>;
  loading: boolean;
  onClose: () => void;
}) {
  const sel = useSelection();
  const togglePin = useTogglePin();

  return (
    <Modal onClose={onClose} testid="pinned-messages-modal">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h3 className="font-bold">Pinned messages</h3>
        <button className="rounded px-2 text-faint hover:bg-daypill hover:text-ink" onClick={onClose}>×</button>
      </div>
      {loading ? (
        <p className="py-6 text-center text-sm text-muted">Loading…</p>
      ) : messages.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No pinned messages in this channel.</p>
      ) : (
        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {messages.map((message) => (
            <div key={message.id} className="flex items-start gap-2 rounded-xl border border-hairline p-2 hover:border-hairline2">
              <button
                type="button"
                className="min-w-0 flex-1 cursor-pointer text-left"
                onClick={() => {
                  sel.jumpToMessage(message.channelId, message.id, message.threadRootId);
                  onClose();
                }}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-xs font-bold">{names[message.userId] ?? 'Unknown'}</span>
                  <span className="shrink-0 text-[11px] text-faint">
                    {message.pinnedAt ? new Date(message.pinnedAt).toLocaleString() : ''}
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-3 text-sm text-ink-soft">
                  {message.body.trim() || message.files[0]?.name || 'Message'}
                </p>
                {message.threadRootId && <span className="text-[11px] text-accent-soft">Reply in thread</span>}
              </button>
              <button
                type="button"
                data-testid={`unpin-from-list-${message.id}`}
                title="Unpin message"
                className="shrink-0 rounded-md p-1 text-accent-soft hover:bg-daypill"
                onClick={() => togglePin.mutate(message)}
              >
                <PinIcon filled />
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
