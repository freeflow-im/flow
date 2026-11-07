import { useBoundApi } from '../lib/useBoundApi';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ArtifactDTO, FileDTO, MessageDTO, WorkspaceMemberDTO } from '@flow/shared';
import { bytesLabel, CustomEmojiContext, displayTime, InlineLinkContext, renderBlocks } from '../lib/format';
import { isMarkdownFile, isTextFile, isVideoFile } from '../lib/fileKind';
import { isSpreadsheetFile, SPREADSHEET_MAX_BYTES } from '../lib/spreadsheet';
import { CARD_LIMITS, SheetTable, SpreadsheetView, useWorkbook } from './SpreadsheetPreview';
import { MarkdownReport } from './ArtifactView';
import { INTERRUPT_EMOJI, isThinkingStatus } from '../lib/agentStatus';
import { burstConfetti, celebrationsAdded } from '../lib/confetti';
import { SCHEDULED_VIEW_ID, useAuth, useSelection } from '../state';
import { useDeleteMessage, useSendMessage, useTogglePin, useToggleReaction, useWorkspaceEmojiMap } from '../hooks';
import { useCapabilities } from '../lib/backend';
import type { BackendMessage } from '@flow/shared';
import { removeMessageFromCache, type LocalMessage } from '../lib/messageCache';
import { messageDeleteConfirmation, messageDeleteMode } from '../lib/messagePermissions';
import { Avatar } from './Avatar';
import { useFileImageSource, type FileImageSource } from './FileImage';
import { LightboxButton, LightboxShell } from './Lightbox';
import { EmojiGlyph } from './CustomEmoji';
import EmojiPicker from './EmojiPicker';
import { Modal, UserCard } from './modals';
import { UnfurlCard } from './UnfurlCard';
import { HoverTooltip } from './HoverTooltip';
import { SystemLine } from './SystemLine';
import { ReferenceChip } from './ReferenceChip';
import { ReferencesContext, referencesIn, referencesOfMessages, useReferenceLookup, useResolvedReferences } from '../lib/references';

/** Remembered scroll position per channel, so switching away and back lands
 * where you left off (ui_nits). Kept module-level (survives the per-channel
 * remount forced by `key={channelId}`) and short-lived: after TTL the entry is
 * ignored and you snap back to the bottom, the freshest place to be. */
const SCROLL_MEMORY_TTL = 5 * 60_000;
const scrollMemory = new Map<string, { top: number; ts: number; pinned: boolean }>();

/** How long an optimistic row keeps full strength before dimming. Most sends
 * confirm well inside this window, so the row never visibly flickers. */
const PENDING_DIM_DELAY_MS = 3000;

/** True once a row has been pending longer than PENDING_DIM_DELAY_MS —
 * only then does it dim to signal the send hasn't committed yet. Keyed off
 * createdAt so a remount mid-wait doesn't restart the clock. */
function usePendingSlow(pending: boolean, createdAt: string): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) {
      setSlow(false);
      return;
    }
    const remaining = PENDING_DIM_DELAY_MS - (Date.now() - Date.parse(createdAt));
    if (remaining <= 0) {
      setSlow(true);
      return;
    }
    const t = setTimeout(() => setSlow(true), remaining);
    return () => clearTimeout(t);
  }, [pending, createdAt]);
  return slow;
}

export default function MessageList({
  messages,
  names,
  membersById = {},
  hasMore,
  onLoadOlder,
  showThreadAffordances,
  unreadThreadRootIds = [],
  scrollKey: unscopedScrollKey,
  focusMessageId = null,
  onFocused,
  readOnly = false,
}: {
  messages: MessageDTO[];
  names: Record<string, string>;
  membersById?: Record<string, WorkspaceMemberDTO>;
  hasMore: boolean;
  onLoadOlder: () => void;
  showThreadAffordances: boolean;
  /** Thread roots with an unread notification for me (#270) — their reply
   * chips get a dot, so a reply that needs you is visible here and not only
   * in the sidebar badge. */
  unreadThreadRootIds?: string[];
  /** Enables per-view scroll-position memory (channels pass their id; threads omit it). */
  scrollKey?: string;
  /** Jump-to-message target (phase 12): scroll it into view + flash it once
   * it's rendered, then call onFocused. */
  focusMessageId?: string | null;
  onFocused?: () => void;
  /** Archived channel (#588): history only — no hover menu, no reacting. */
  readOnly?: boolean;
}) {
  const { scopedStorageKey, api, serverOrigin } = useBoundApi();
  const scrollKey = unscopedScrollKey ? scopedStorageKey(`scroll:${unscopedScrollKey}`) : undefined;
  // FreeFlow addresses in these messages, resolved for the reader in one call (lib/references.ts, platform phase 6.4).
  const workspaceId = useSelection().workspaceId;
  const references = useResolvedReferences(api, serverOrigin, workspaceId, referencesOfMessages(messages, serverOrigin, workspaceId));
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true); // at (or near) the bottom, so growth should keep us there
  const lastTopRef = useRef(0);
  // A pending jump suppresses the bottom-pin so it doesn't yank us off the
  // target message we're scrolling to.
  const focusRef = useRef<string | null>(focusMessageId);
  focusRef.current = focusMessageId;
  const lastId = messages.length > 0 ? messages[messages.length - 1]!.id : null;
  // Reading back-scroll → offer a way back to the newest message (#111).
  // `pinnedRef` is a ref (it's read from scroll/resize handlers), so mirror it
  // into state for rendering.
  const [showJump, setShowJump] = useState(false);

  // Raise the jump button once we're both unpinned and visibly short of the
  // end (the slack keeps a part-scrolled last message from raising it).
  const syncJump = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    setShowJump(!pinnedRef.current && gap > 120);
  };

  const jumpToLatest = () => {
    pinnedRef.current = true;
    setShowJump(false);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };

  // On mount, restore a recent remembered position; otherwise land at the
  // bottom. Runs before paint so the viewport never flashes the bottom first.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // A pending jump-to-message owns the scroll — let its effect place us,
    // instead of flashing the remembered/bottom position first.
    if (focusRef.current) {
      pinnedRef.current = false;
      return;
    }
    const mem = scrollKey ? scrollMemory.get(scrollKey) : undefined;
    if (mem && Date.now() - mem.ts < SCROLL_MEMORY_TTL && !mem.pinned) {
      scroller.scrollTop = mem.top;
      pinnedRef.current = false;
      lastTopRef.current = mem.top;
      syncJump(); // opened mid-history — offer the way back down right away
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
      pinnedRef.current = true;
      if (scrollKey) scrollMemory.delete(scrollKey); // expired → forget it
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new message keeps us at the bottom only while we're pinned there — if the
  // user has scrolled up (to read, or restored from memory), don't yank them.
  useEffect(() => {
    if (focusRef.current) return; // a jump owns the scroll position
    if (pinnedRef.current) bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [lastId]);

  // Jump-to-message: once the target row is in the DOM (it may take a few
  // older-history pages to arrive), center it and flash it, then release.
  useEffect(() => {
    if (!focusMessageId) return;
    const el = scrollerRef.current?.querySelector(
      `[data-testid="message-${CSS.escape(focusMessageId)}"]`,
    );
    if (!el) return; // not loaded yet — re-runs when `messages` grows
    pinnedRef.current = false; // stop the bottom-pin from fighting the scroll
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('mc-flash');
    const t = window.setTimeout(() => {
      el.classList.remove('mc-flash');
      onFocused?.();
    }, 2000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMessageId, messages]);

  // Attachments (images, text previews) finish loading after the initial
  // scroll and grow the content, leaving a freshly opened channel short of
  // the bottom. Stay pinned to the bottom as content grows until the user
  // scrolls away (macOS gets this from defaultScrollAnchor(.bottom)).
  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    // A scroll event lands a frame after the scroll that caused it, so by the
    // time it runs the content may already have grown again (a late unfurl
    // card, an image finishing). Distance-from-bottom alone therefore can't
    // tell "the user scrolled away" from "the page grew under us" — reading it
    // that way let our own pinning scroll come back as a 286px gap and latch
    // pinned=false, stranding the viewport above the newest card. Growth never
    // moves scrollTop up, so that (not the distance) is the leaving-the-bottom
    // signal; the distance only ever pins us back on.
    const remember = () => {
      if (scrollKey) scrollMemory.set(scrollKey, { top: scroller.scrollTop, ts: Date.now(), pinned: pinnedRef.current });
    };
    const onScroll = () => {
      const top = scroller.scrollTop;
      if (scroller.scrollHeight - top - scroller.clientHeight < 40) pinnedRef.current = true;
      else if (top < lastTopRef.current - 1) pinnedRef.current = false;
      lastTopRef.current = top;
      syncJump();
      remember();
    };
    scroller.addEventListener('scroll', onScroll);
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) scroller.scrollTop = scroller.scrollHeight;
      // A message arriving while we're scrolled up grows the content without a
      // scroll event — that's when the jump button has to appear (#111).
      syncJump();
    });
    observer.observe(content);
    return () => {
      remember(); // capture the final position for the return visit
      scroller.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ReferencesContext.Provider value={references}>
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollerRef} className="mc-scroll min-h-0 flex-1 overflow-y-auto py-2" data-testid="message-list">
        <div ref={contentRef}>
          {hasMore && (
            <div className="py-1 text-center">
              <button
                data-testid="history-load-older"
                className="text-sm font-semibold text-accent-soft hover:underline disabled:opacity-40 disabled:hover:no-underline"
                onClick={onLoadOlder}
              >
                Load earlier messages
              </button>
            </div>
          )}
          {messages.map((m, i) => (
            // Keyed on clientMsgId, not id: the optimistic row and its server
            // echo share a clientMsgId but not an id, so keying on id
            // remounts the row (and re-flashes its avatar) on reconcile.
            <div key={m.clientMsgId || m.id}>
              {startsNewDay(messages, i) && <DayDivider iso={m.createdAt} />}
              {m.systemKind ? (
                <SystemLine message={m} />
              ) : (
                <MessageRow
                  message={m}
                  names={names}
                  membersById={membersById}
                  showHeader={showsHeader(messages, i)}
                  showThreadAffordances={showThreadAffordances}
                  threadUnread={unreadThreadRootIds.includes(m.id)}
                  readOnly={readOnly}
                />
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {showJump && (
        <button
          type="button"
          data-testid="jump-to-latest"
          className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2 cursor-pointer rounded-full border border-hairline bg-white px-3 py-1.5 text-xs font-semibold text-accent-soft shadow-md hover:border-hairline2"
          onClick={jumpToLatest}
        >
          Latest msgs ↓
        </button>
      )}
    </div>
    </ReferencesContext.Provider>
  );
}

/** The chips for the FreeFlow addresses in a message, resolved for the reader by the list (platform phase 6.4). */
function MessageReferences({ body }: { body: string }) {
  const lookup = useReferenceLookup();
  if (!lookup?.organizationId) return null;
  return referencesIn(body, lookup.origin, lookup.organizationId).map((f) => <ReferenceChip key={f.ref} found={f} resolved={lookup.get(f.ref)} />);
}

export function showsHeader(messages: MessageDTO[], index: number): boolean {
  if (index === 0) return true;
  if (startsNewDay(messages, index)) return true;
  const prev = messages[index - 1]!;
  const cur = messages[index]!;
  // A system line (join/leave) breaks a run — the next real message always
  // re-shows its author header rather than merging into the pre-notice group.
  if (prev.systemKind) return true;
  if (prev.userId !== cur.userId) return true;
  // A scheduled message always starts its own group (#420). Merged into the
  // author's own preceding message it would inherit that header — and lose the
  // badge, which is the one thing saying nobody typed this just now.
  if (prev.scheduled !== cur.scheduled) return true;
  return new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime() > 300_000;
}

function startsNewDay(messages: MessageDTO[], index: number): boolean {
  if (index === 0) return true;
  return (
    new Date(messages[index - 1]!.createdAt).toDateString() !==
    new Date(messages[index]!.createdAt).toDateString()
  );
}

function DayDivider({ iso }: { iso: string }) {
  const d = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  const label =
    d.toDateString() === now.toDateString()
      ? 'Today'
      : d.toDateString() === yesterday.toDateString()
        ? 'Yesterday'
        : d.toLocaleDateString([], { month: 'long', day: 'numeric' });
  return (
    <div className="my-2 text-center">
      <span className="rounded-[20px] bg-daypill px-3 py-[3px] text-[11px] text-faint">{label}</span>
    </div>
  );
}

/** Quick one-tap reactions shown first in the message hover menu (operator
 * pick). The 🙂 button beside them still opens the full picker. */
const QUICK_REACTIONS = ['👍', '👀', '🙌'];

/** Open-external glyph (box with an arrow leaving it) for the pin-as-artifact
 * action. The rest of the UI uses unicode/emoji glyphs, but no codepoint draws
 * this mark — hence the one inline SVG. Strokes follow the button's text color. */
function ExternalLinkIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-[15px] w-[15px]"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

export function PinIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[17px] w-[17px]">
      <path
        d="M8 3h8l-1.2 6.1 3.2 3.2V14h-5v6l-1 1-1-1v-6H6v-1.7l3.2-3.2L8 3Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "12m ago" style label for thread indicators. */
function relTime(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function MessageRow({
  message,
  names,
  membersById,
  showHeader,
  showThreadAffordances,
  threadUnread = false,
  readOnly = false,
}: {
  message: MessageDTO;
  names: Record<string, string>;
  membersById: Record<string, WorkspaceMemberDTO>;
  showHeader: boolean;
  showThreadAffordances: boolean;
  /** This thread holds an unread notification for me (#270). */
  threadUnread?: boolean;
  readOnly?: boolean;
}) {
  const { api } = useBoundApi();
  const auth = useAuth();
  const sel = useSelection();
  const qc = useQueryClient();
  const toggle = useToggleReaction();
  const togglePin = useTogglePin();
  const remove = useDeleteMessage();
  // Capability gating (#545): every control below renders only when its
  // capability is usable.
  const caps = useCapabilities();
  // Shared query cache, so this is one fetch per workspace however many rows
  // are mounted (#175).
  const customEmoji = useWorkspaceEmojiMap(sel.workspaceId);
  const [showPicker, setShowPicker] = useState(false);
  // Clicking the sender's avatar opens their profile card (ui_nits).
  const [showCard, setShowCard] = useState(false);
  // Editing state lives in the selection context; the edit itself happens in the
  // prompt editor (ui_nits), so here we only highlight the row and hide its hover
  // menu while it's the one loaded in the composer.
  const editing = sel.editingMessageId === message.id;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const mine = message.userId === auth.user.id;
  const deleteMode = messageDeleteMode(message, auth.user.id, membersById[auth.user.id]?.role);
  const deleteConfirmation = deleteMode
    ? messageDeleteConfirmation(deleteMode, message.threadRootId, message.replyCount)
    : null;
  const sender = names[message.userId] ?? 'Unknown';
  const member = membersById[message.userId];
  // Optimistic row awaiting the server echo: actions suppressed. It renders
  // at full strength and only dims if the commit is slow (>3s) or fails.
  const pending = (message as LocalMessage).pending === true;
  const pendingSlow = usePendingSlow(pending, message.createdAt);
  // Optimistic row whose POST errored out: kept in place with Retry/discard.
  const failed = (message as LocalMessage).failed === true;
  const send = useSendMessage(message.channelId);
  // The agent's live "thinking…" row carries its own stop control (issue #67):
  // reacting 🛑 is what tells the bridge to end that turn.
  const thinking = !message.deletedAt && member?.isAgent === true && isThinkingStatus(message.body);
  const stopping = message.reactions.some(
    (r) => r.emoji === INTERRUPT_EMOJI && r.userIds.includes(auth.user.id),
  );

  // Confetti when a 🎉 lands (#514). This runs after commit, so the reaction
  // row it fires from is already on screen — and `celebrationsAdded` is what
  // keeps it to genuine additions rather than every render of history.
  const reactionRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const added = celebrationsAdded(message.id, message.reactions);
    const row = reactionRowRef.current;
    if (added.length === 0 || !row) return;
    for (const emoji of added) {
      // From the pill that just changed, not the middle of the row — the row is
      // as wide as the message, so its centre is nowhere near the reaction.
      const pill = row.querySelector(`[data-testid="reaction-${emoji}"]`) ?? row;
      const rect = pill.getBoundingClientRect();
      burstConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
  }, [message.id, message.reactions]);

  const deleteSelectedMessage = async () => {
    if (!deleteMode || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await remove.mutateAsync({ message, purge: deleteMode === 'permanent' });
      if (message.threadRootId === null && sel.threadRootId === message.id && deleteMode === 'permanent') sel.openThread(null);
      // A hard delete refetches what the server now says.
      if (deleteMode === 'permanent') {
        await Promise.all([
          qc.invalidateQueries({ queryKey: ['messages', message.channelId] }),
          qc.invalidateQueries({ queryKey: ['channels', sel.workspaceId] }),
          qc.invalidateQueries({ queryKey: ['pins', message.channelId] }),
          qc.invalidateQueries({ queryKey: ['channelFiles', message.channelId] }),
          qc.invalidateQueries({ queryKey: ['notifications'] }),
          qc.invalidateQueries({ queryKey: ['workspaces'] }),
        ]);
      }
      setConfirmDelete(false);
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  // Pin the message's file(s) as shared artifacts in this channel (phase 13);
  // the new artifact opens in the side panel automatically.
  const pinFiles = async () => {
    let last: ArtifactDTO | null = null;
    for (const f of message.files) {
      last = await api<ArtifactDTO>('POST', '/v1/artifacts', { channelId: message.channelId, fileId: f.id });
    }
    await qc.invalidateQueries({ queryKey: ['artifacts', sel.workspaceId] });
    if (last) sel.selectArtifact(last.id);
  };

  // Pin a bare link from the message body as a co-browsing artifact and open it.
  const pinUrl = async (url: string) => {
    const a = await api<ArtifactDTO>('POST', '/v1/artifacts', { channelId: message.channelId, url });
    await qc.invalidateQueries({ queryKey: ['artifacts', sel.workspaceId] });
    sel.selectArtifact(a.id);
  };

  return (
    <div
      data-testid={`message-${message.id}`}
      data-pending={pending || undefined}
      className={`group relative flex gap-2.5 px-[22px] ${editing ? 'bg-accent/5' : 'hover:bg-daypill/40'} ${showHeader ? 'mt-3' : 'py-px'} ${pendingSlow ? 'opacity-55' : ''}`}
    >
      <div className="w-[38px] shrink-0">
        {showHeader && (
          <button
            type="button"
            data-testid={`avatar-${message.userId}`}
            title={`View ${sender}'s profile`}
            className="block cursor-pointer leading-none"
            onClick={() => setShowCard(true)}
          >
            <Avatar userId={message.userId} name={sender} avatarUrl={member?.avatarUrl} size={38} radius={11} />
          </button>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {showHeader && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-bold">
              {sender}
              {member?.isAgent && (
                <span className="ml-1 text-sm font-normal" title="AI agent" data-testid={`agent-badge-${sender}`}>
                  🤖
                </span>
              )}
              {member?.statusEmoji && (
                <span className="ml-1 text-sm font-normal" title={member.statusText} data-testid={`status-of-${sender}`}>
                  {member.statusEmoji}
                </span>
              )}
            </span>
            {message.scheduled && <ScheduledBadge author={sender} />}
            <span className="text-[11px] text-faint">{displayTime(message.createdAt)}</span>
          </div>
        )}

        {message.deletedAt ? (
          <p className="text-sm text-faint italic">This message was deleted</p>
        ) : (
          <>
            {message.pinnedAt && (
              <div
                data-testid={`pinned-marker-${message.id}`}
                className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold text-accent-soft"
                title={`Pinned${message.pinnedBy ? ` by ${names[message.pinnedBy] ?? 'a channel member'}` : ''}`}
              >
                <PinIcon filled />
                <span>Pinned</span>
              </div>
            )}
            {message.body.trim() && (
              // data-search-body marks what the cmd-F find bar searches (#518):
              // the rendered body only, so a query never matches chrome. The
              // "(edited)" marker sits inside it, hence the skip flag.
              <div
                data-search-body=""
                className="text-sm leading-normal break-words whitespace-pre-wrap"
              >
                <InlineLinkContext.Provider value={{ onPinLink: (url) => void pinUrl(url), onOpenArtifact: sel.selectArtifact }}>
                  <CustomEmojiContext.Provider value={customEmoji}>
                    {renderBlocks(message.body, names, auth.user.id)}
                  </CustomEmojiContext.Provider>
                </InlineLinkContext.Provider>
                {message.editedAt && (
                  <span data-search-skip="" className="ml-1 text-xs text-faint">(edited)</span>
                )}
              </div>
            )}
            {thinking && (
              <div className="mt-1">
                <button
                  type="button"
                  data-testid={`interrupt-${message.id}`}
                  disabled={stopping || pending}
                  title={stopping ? 'Stopping…' : 'Stop this agent turn'}
                  className={`rounded-[20px] border px-[9px] py-[2px] text-xs font-[650] ${
                    stopping
                      ? 'border-hairline text-faint'
                      : 'border-hairline bg-white text-ink-soft hover:border-hairline2 hover:text-ink'
                  }`}
                  onClick={() => toggle.mutate({ message, emoji: INTERRUPT_EMOJI, mine: false })}
                >
                  {stopping ? '⏹ Stopping…' : '⏹ Interrupt'}
                </button>
              </div>
            )}
            {message.files.map((f) => (
              <Attachment key={f.id} file={f} />
            ))}
            {failed && (
              <div
                data-testid={`send-failed-${(message as LocalMessage).clientMsgId}`}
                className="mt-0.5 flex items-center gap-2 text-xs text-red-600"
              >
                <span>Failed to send.</span>
                <button
                  type="button"
                  className="font-semibold underline hover:no-underline"
                  onClick={() => send.retry((message as LocalMessage).clientMsgId)}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="text-muted hover:text-ink"
                  title="Discard"
                  onClick={() =>
                    send.discard((message as LocalMessage).clientMsgId, message.threadRootId ?? undefined)
                  }
                >
                  ✕
                </button>
              </div>
            )}
            {!message.deletedAt && <MessageReferences body={message.body} />}
            {/* Phase 11: link previews sit below the body/attachments and above
                reactions. Only the author gets the remove affordance (§10). */}
            {message.unfurls.map((u) => (
              <UnfurlCard
                key={u.urlHash}
                unfurl={u}
                messageId={message.id}
                channelId={message.channelId}
                workspaceId={sel.workspaceId}
                canRemove={message.userId === auth.user.id}
              />
            ))}
            {message.reactions.length > 0 && (
              <div ref={reactionRowRef} className="mt-1 flex flex-wrap gap-1">
                {message.reactions.map((r) => {
                  const mineR = r.userIds.includes(auth.user.id);
                  return (
                    <button
                      key={r.emoji}
                      data-testid={`reaction-${r.emoji}`}
                      data-count={r.count}
                      data-mine={mineR}
                      title={r.userIds.map((id) => names[id] ?? '?').join(', ')}
                      className={`rounded-[20px] border bg-white px-[9px] py-[2px] text-xs ${
                        mineR ? 'border-accent-soft/40' : 'border-hairline hover:border-hairline2'
                      }`}
                      disabled={readOnly}
                      onClick={() => toggle.mutate({ message, emoji: r.emoji, mine: mineR })}
                    >
                      <EmojiGlyph emoji={r.emoji} customEmoji={customEmoji} />{' '}
                      <span className={`font-bold ${mineR ? 'text-accent-soft' : 'text-ink-soft'}`}>{r.count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}

        {showThreadAffordances && message.replyCount > 0 && (
          <button
            data-testid={`thread-open-${message.id}`}
            data-thread-unread={threadUnread ? 'true' : undefined}
            className={`mt-1 flex cursor-pointer items-center gap-2 rounded-[10px] border bg-white py-[5px] pr-2.5 pl-1.5 text-xs ${
              threadUnread ? 'border-unread/45 hover:border-unread' : 'border-hairline hover:border-hairline2'
            }`}
            onClick={() => sel.openThread(message.id)}
          >
            {/* A reply in here needs you (#270) — the sidebar badge says the
                channel has something, this says which thread. */}
            {threadUnread && (
              <span
                data-testid={`thread-unread-${message.id}`}
                title="Unread reply"
                className="size-[7px] shrink-0 rounded-full bg-unread"
              />
            )}
            {(message.replyParticipantUserIds ?? []).length > 0 && (
              <span className="flex -space-x-1.5" data-testid={`thread-participants-${message.id}`}>
                {message.replyParticipantUserIds.map((id) => (
                  <Avatar
                    key={id}
                    userId={id}
                    name={names[id] ?? 'Unknown'}
                    avatarUrl={membersById[id]?.avatarUrl}
                    size={20}
                    radius={6}
                    className="ring-2 ring-white"
                  />
                ))}
              </span>
            )}
            <span className="font-[650] text-accent-soft">
              {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
            </span>
            {message.lastReplyAt && <span className="text-[11px] text-faint">Last reply {relTime(message.lastReplyAt)}</span>}
          </button>
        )}
      </div>

      {!readOnly && !editing && !pending && !failed && (!message.deletedAt || deleteMode === 'permanent') && (
        <div className="absolute top-0 right-[22px] hidden items-center gap-0.5 rounded-xl border border-hairline bg-white px-1.5 py-1 shadow-sm group-hover:flex">
          {!message.deletedAt && (
            <>
              {caps.reactions.state !== 'unavailable' && QUICK_REACTIONS.map((emoji) => {
                const mineR = message.reactions.find((r) => r.emoji === emoji)?.userIds.includes(auth.user.id) ?? false;
                return (
                  <button
                    key={emoji}
                    data-testid={`quick-react-${emoji}-${message.id}`}
                    className="rounded-md px-1.5 py-1 text-lg leading-none hover:bg-daypill"
                    title={`React ${emoji}`}
                    onClick={() => toggle.mutate({ message, emoji, mine: mineR })}
                  >
                    {emoji}
                  </button>
                );
              })}
              <div className="mx-0.5 h-6 w-px self-center bg-hairline" />
              {caps.reactions.state !== 'unavailable' ? (
                <button
                  data-testid={`add-reaction-${message.id}`}
                  className="rounded-md px-1.5 py-1 text-lg leading-none hover:bg-daypill"
                  title="Add reaction"
                  onClick={() => setShowPicker(true)}
                >
                  🙂
                </button>
              ) : (
                <span data-testid={`add-reaction-unavailable-${message.id}`} className="cursor-not-allowed px-1.5 py-1 text-lg leading-none opacity-40" title={caps.reactions.reason}>🙂</span>
              )}
              {showThreadAffordances && (
                <button
                  className="rounded-md px-1.5 py-1 text-lg leading-none hover:bg-daypill"
                  title="Reply in thread"
                  onClick={() => sel.openThread(message.threadRootId ?? message.id)}
                >
                  💬
                </button>
              )}
              {message.body && (
                <button
                  data-testid={`copy-message-${message.id}`}
                  className="rounded-md px-1.5 py-1 text-lg leading-none hover:bg-daypill"
                  title="Copy text"
                  onClick={() => void navigator.clipboard?.writeText(message.body)}
                >
                  📋
                </button>
              )}
              {caps.pins.state !== 'unavailable' && <button
                data-testid={`toggle-pin-${message.id}`}
                className={`flex items-center rounded-md px-1.5 py-1 leading-none hover:bg-daypill ${
                  message.pinnedAt ? 'text-accent-soft' : 'text-ink'
                }`}
                title={message.pinnedAt ? 'Unpin message' : 'Pin message'}
                onClick={() => togglePin.mutate(message)}
              >
                <PinIcon filled={!!message.pinnedAt} />
              </button>}
              {message.files.length > 0 && caps.artifacts.state !== 'unavailable' && (
                <button
                  data-testid={`pin-artifact-${message.id}`}
                  className="flex items-center rounded-md px-1.5 py-1 text-lg leading-none hover:bg-daypill"
                  title="Pin as artifact"
                  onClick={() => void pinFiles()}
                >
                  <ExternalLinkIcon />
                </button>
              )}
              {mine && caps.edit.state !== 'unavailable' && (
                <button
                  data-testid={`edit-message-${message.id}`}
                  className="rounded-md px-1.5 py-1 text-lg leading-none hover:bg-daypill"
                  title="Edit"
                  onClick={() => sel.setEditingMessage(message.id)}
                >
                  ✏️
                </button>
              )}
            </>
          )}
          {deleteMode && caps.delete.state !== 'unavailable' && (
              <button
                data-testid={`delete-message-${message.id}`}
                className="rounded-md px-1.5 py-1 text-lg leading-none hover:bg-daypill"
                title={deleteMode === 'permanent' ? 'Permanently delete' : 'Delete'}
                onClick={() => {
                  setDeleteError(null);
                  setConfirmDelete(true);
                }}
              >
                🗑
              </button>
          )}
        </div>
      )}

      {showCard && <UserCard userId={message.userId} onClose={() => setShowCard(false)} />}

      {confirmDelete && deleteConfirmation && (
        <Modal onClose={() => setConfirmDelete(false)} testid="delete-confirm-modal">
          <h3 className="mb-2 font-bold">{deleteConfirmation.title}</h3>
          <p className="mb-3 text-sm text-muted">{deleteConfirmation.body}</p>
          {deleteError && <p className="mb-3 text-sm text-red-600">{deleteError}</p>}
          <div className="flex justify-end gap-2">
            <button disabled={deleting} className="px-3 py-1.5 text-sm text-ink-soft" onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button
              data-testid="delete-confirm"
              disabled={deleting}
              className="rounded bg-red-600 px-3 py-1.5 text-sm font-semibold text-white"
              onClick={() => void deleteSelectedMessage()}
            >
              {deleting ? 'Deleting…' : deleteConfirmation.confirmLabel}
            </button>
          </div>
        </Modal>
      )}

      {showPicker && (
        <div className="absolute top-6 right-[22px] z-30">
          <EmojiPicker
            workspaceId={sel.workspaceId}
            onPick={(emoji) => {
              setShowPicker(false);
              const mineR = message.reactions.find((r) => r.emoji === emoji)?.userIds.includes(auth.user.id) ?? false;
              toggle.mutate({ message, emoji, mine: mineR });
            }}
            onClose={() => setShowPicker(false)}
          />
        </div>
      )}
    </div>
  );
}

// Collapsed-image state (phase 5 ruling): persisted per device, capped list.
// The file ids are one server's, so the key is per connection+identity — the
// same id on another backend is a different file.
const COLLAPSE_CAP = 500;
function collapsedIds(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function persistCollapsed(key: string, fileId: string, collapsed: boolean): void {
  const ids = collapsedIds(key).filter((id) => id !== fileId);
  if (collapsed) ids.push(fileId);
  localStorage.setItem(key, JSON.stringify(ids.slice(-COLLAPSE_CAP)));
}

const TEXT_PREVIEW_LINES = 10;
const TEXT_EXPAND_MAX = 100_000; // chars shown when expanded (phase 6 ruling)

function useCollapsed(fileId: string): [boolean, () => void] {
  const { scopedStorageKey } = useBoundApi();
  const key = scopedStorageKey('collapsedImages');
  const [collapsed, setCollapsed] = useState(() => collapsedIds(key).includes(fileId));
  const toggle = () =>
    setCollapsed((c) => {
      persistCollapsed(key, fileId, !c);
      return !c;
    });
  return [collapsed, toggle];
}

function useDownload(file: FileDTO): () => Promise<void> {
  const { blobUrl } = useBoundApi();
  return async () => {
    const url = await blobUrl(`/v1/files/${file.id}`);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
  };
}

function CardHeader({
  file,
  collapsed,
  onToggle,
}: {
  file: FileDTO;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-1 text-[11px] text-faint">
      <button
        data-testid={`file-collapse-${file.name}`}
        className="w-4 hover:text-ink"
        title={collapsed ? 'Show preview' : 'Hide preview'}
        onClick={onToggle}
      >
        {collapsed ? '▸' : '▾'}
      </button>
      <span className="truncate">{file.name}</span>
    </div>
  );
}

function DownloadHoverButton({ file, onDownload }: { file: FileDTO; onDownload: () => Promise<void> }) {
  return (
    <button
      data-testid={`file-download-${file.name}`}
      className="absolute top-1.5 right-1.5 z-10 hidden h-7 w-7 items-center justify-center rounded-lg border border-hairline bg-white/90 text-sm shadow-sm hover:bg-white group-hover/att:flex"
      title="Download"
      onClick={() => void onDownload()}
    >
      ⤓
    </button>
  );
}

function Attachment({ file }: { file: FileDTO }) {
  if (file.hasThumb) return <ImageAttachment file={file} />;
  if (isVideoFile(file)) return <VideoAttachment file={file} />;
  if (file.mimeType === 'application/pdf') return <PdfAttachment file={file} />;
  // Before text: a CSV is a spreadsheet first and a text file second.
  if (isSpreadsheetFile(file) && file.sizeBytes <= SPREADSHEET_MAX_BYTES) return <SpreadsheetAttachment file={file} />;
  if (isTextFile(file)) return <TextAttachment file={file} />;
  return <FileChip file={file} />;
}

/** Inline spreadsheet card: the first sheet's top-left corner as a small
 * grid; click opens the full reader with sheet tabs. A file the parser
 * cannot read falls back to the chip. */
function SpreadsheetAttachment({ file }: { file: FileDTO }) {
  const [collapsed, toggleCollapsed] = useCollapsed(file.id);
  const [reader, setReader] = useState(false);
  const download = useDownload(file);
  const state = useWorkbook(file.id, !collapsed);

  if (state.status === 'failed') return <FileChip file={file} />;
  const first = state.workbook?.sheets[0];

  return (
    <div className="mt-1 max-w-[560px]">
      <CardHeader file={file} collapsed={collapsed} onToggle={toggleCollapsed} />
      {!collapsed && (
        <div className="group/att relative mt-0.5">
          <div className="mc-scroll overflow-x-auto rounded-lg border border-hairline bg-white" data-testid={`file-sheet-${file.name}`}>
            {first ? (
              <SheetTable sheet={first} limits={CARD_LIMITS} compact />
            ) : (
              <div className="px-3 py-2 text-xs text-faint">{state.status === 'loading' ? 'Loading…' : 'Empty workbook'}</div>
            )}
          </div>
          {state.workbook && (
            <button
              data-testid={`file-${file.name}`}
              className="absolute inset-0 cursor-pointer"
              title={`Open ${file.name}`}
              onClick={() => setReader(true)}
            />
          )}
          <DownloadHoverButton file={file} onDownload={download} />
        </div>
      )}
      {reader && state.workbook && (
        <LightboxShell
          testId="sheet-reader"
          onClose={() => setReader(false)}
          caption={file.name}
          actions={
            <LightboxButton testId="sheet-reader-download" title="Download" onClick={() => void download()}>⤓</LightboxButton>
          }
        >
          <div className="h-[85vh] w-[80vw] overflow-hidden rounded-lg" onMouseDown={(e) => e.stopPropagation()}>
            <SpreadsheetView workbook={state.workbook} testId="sheet-reader-view" />
          </div>
        </LightboxShell>
      )}
    </div>
  );
}

function ImageAttachment({ file }: { file: FileDTO }) {
  const [collapsed, toggleCollapsed] = useCollapsed(file.id);
  const [lightbox, setLightbox] = useState(false);
  const download = useDownload(file);
  const variant = file.mimeType === 'image/gif' ? 'original' : 'thumbnail';
  const image = useFileImageSource(file.id, variant, !collapsed);

  return (
    <div className="mt-1">
      <CardHeader file={file} collapsed={collapsed} onToggle={toggleCollapsed} />
      {!collapsed && (
        <AttachmentImagePreview
          file={file}
          image={image}
          onOpen={() => setLightbox(true)}
          onDownload={download}
        />
      )}
      {lightbox && <ImageLightbox file={file} onClose={() => setLightbox(false)} onDownload={download} />}
    </div>
  );
}

const IMAGE_PREVIEW_MAX_WIDTH = 512;
const IMAGE_PREVIEW_MAX_HEIGHT = 480;
const IMAGE_PREVIEW_FALLBACK_WIDTH = 320;
const IMAGE_PREVIEW_FALLBACK_HEIGHT = 240;
const IMAGE_PREVIEW_MIN_EDGE = 96;

/** Definite outer geometry keeps loading and failed previews visible and
 * removes the fit-content/percentage-width cycle that is fragile on phones. */
export function attachmentPreviewStyle(file: Pick<FileDTO, 'width' | 'height'>): React.CSSProperties {
  const sourceWidth = file.width && file.width > 0 ? file.width : IMAGE_PREVIEW_FALLBACK_WIDTH;
  const sourceHeight = file.height && file.height > 0 ? file.height : IMAGE_PREVIEW_FALLBACK_HEIGHT;
  const scale = Math.min(1, IMAGE_PREVIEW_MAX_WIDTH / sourceWidth, IMAGE_PREVIEW_MAX_HEIGHT / sourceHeight);
  return {
    width: Math.max(IMAGE_PREVIEW_MIN_EDGE, Math.round(sourceWidth * scale)),
    maxWidth: '100%',
    minHeight: IMAGE_PREVIEW_MIN_EDGE,
    aspectRatio: `${sourceWidth} / ${sourceHeight}`,
  };
}

/** Presentational seam kept separate from loading so all states can be
 * regression-tested without a browser or network. */
export function AttachmentImagePreview({
  file,
  image,
  onOpen,
  onDownload,
}: {
  file: FileDTO;
  image: FileImageSource;
  onOpen: () => void;
  onDownload: () => Promise<void>;
}) {
  return (
    <div
      data-testid={`file-image-frame-${file.name}`}
      className="group/att relative mt-0.5 max-w-full min-w-0 overflow-hidden rounded-lg border border-hairline bg-daypill"
      style={attachmentPreviewStyle(file)}
    >
      {image.src && image.status !== 'failed' && (
        <button
          type="button"
          data-testid={`file-${file.name}`}
          className={`absolute inset-0 block h-full w-full ${image.status === 'loaded' ? '' : 'opacity-0'}`}
          onClick={onOpen}
          title={file.name}
        >
          <img
            src={image.src}
            alt={file.name}
            className="h-full w-full object-contain"
            onLoad={image.onLoad}
            onError={image.onError}
          />
        </button>
      )}
      {image.status === 'loading' && (
        <div role="status" className="absolute inset-0 flex items-center justify-center text-xs text-faint">
          Loading preview…
        </div>
      )}
      {image.status === 'failed' && (
        <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center text-xs text-faint">
          <span>Preview unavailable</span>
          <span className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              data-testid={`file-retry-${file.name}`}
              className="rounded-md border border-hairline bg-white px-2 py-1 font-semibold text-ink hover:border-hairline2"
              onClick={image.retry}
            >
              Retry
            </button>
            <button
              type="button"
              data-testid={`file-error-download-${file.name}`}
              className="rounded-md border border-hairline bg-white px-2 py-1 font-semibold text-ink hover:border-hairline2"
              onClick={() => void onDownload()}
            >
              Download
            </button>
          </span>
        </div>
      )}
      {image.status === 'loaded' && <DownloadHoverButton file={file} onDownload={onDownload} />}
    </div>
  );
}

/** Inline video card (ui_nits): preview-card chrome (collapse chevron, hover
 * Download) + native <video> controls, expand affordance opens a lightbox.
 * Prefers a presigned streaming URL (R2 serves Range, so the browser streams
 * and seeks without downloading the file — videos can be hundreds of MB);
 * falls back to whole-blob fetch when the server can't presign (local dev,
 * legacy rows). On error with a streamed URL we re-mint once — the TTL may
 * simply have expired in a long-open tab. */
function VideoAttachment({ file }: { file: FileDTO }) {
  const { blobUrl, fileStreamUrl } = useBoundApi();
  const [collapsed, toggleCollapsed] = useCollapsed(file.id);
  const [url, setUrl] = useState<string | null>(null);
  const [streamed, setStreamed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retried, setRetried] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const download = useDownload(file);

  useEffect(() => {
    let alive = true;
    void fileStreamUrl(file.id)
      .then((r) => {
        if (!alive) return null;
        if (r.url) {
          setStreamed(true);
          setUrl(r.url);
          return null;
        }
        return blobUrl(`/v1/files/${file.id}`).then((u) => { if (alive) setUrl(u); });
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [file.id]);

  const onVideoError = () => {
    if (streamed && !retried) {
      setRetried(true);
      setUrl(null);
      void fileStreamUrl(file.id)
        .then((r) => (r.url ? setUrl(r.url) : setFailed(true)))
        .catch(() => setFailed(true));
      return;
    }
    setFailed(true);
  };

  // Browser can't fetch or decode this video (codec/container) → plain chip.
  if (failed) return <FileChip file={file} />;

  return (
    <div className="mt-1">
      <CardHeader file={file} collapsed={collapsed} onToggle={toggleCollapsed} />
      {!collapsed && (
        <div className="group/att relative mt-0.5 w-[min(576px,100%)]">
          {url ? (
            <video
              data-testid={`file-video-${file.name}`}
              src={url}
              controls
              preload="metadata"
              className="block h-auto max-h-[480px] w-full rounded-lg border border-hairline bg-black"
              onError={onVideoError}
            />
          ) : (
            <div className="flex h-[240px] w-full items-center justify-center rounded-lg border border-hairline bg-daypill text-2xl text-faint">
              ▶
            </div>
          )}
          <button
            data-testid={`file-video-expand-${file.name}`}
            className="absolute top-1.5 right-10 z-10 hidden h-7 w-7 items-center justify-center rounded-lg border border-hairline bg-white/90 text-sm shadow-sm hover:bg-white group-hover/att:flex"
            title="Expand"
            onClick={() => setLightbox(true)}
          >
            ⤢
          </button>
          <DownloadHoverButton file={file} onDownload={download} />
        </div>
      )}
      {lightbox && url && (
        <VideoLightbox file={file} url={url} onClose={() => setLightbox(false)} onDownload={download} />
      )}
    </div>
  );
}

/** Full-window video player overlay, matching the image lightbox chrome. */
function VideoLightbox({
  file,
  url,
  onClose,
  onDownload,
}: {
  file: FileDTO;
  url: string;
  onClose: () => void;
  onDownload: () => Promise<void>;
}) {
  return (
    <LightboxShell
      testId="video-lightbox"
      onClose={onClose}
      caption={file.name}
      actions={
        <LightboxButton testId="video-lightbox-download" title="Download" onClick={() => void onDownload()}>
          ⤓
        </LightboxButton>
      }
    >
      <video src={url} controls autoPlay className="max-h-[85vh] max-w-[88vw] rounded-lg bg-black" />
    </LightboxShell>
  );
}

/** Inline monospace preview for text-ish files (phase 6): first lines +
 * Expand, expanded output capped with a visible truncation notice. */
function TextAttachment({ file }: { file: FileDTO }) {
  const { fileText } = useBoundApi();
  const [collapsed, toggleCollapsed] = useCollapsed(file.id);
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const download = useDownload(file);

  useEffect(() => {
    let alive = true;
    void fileText(`/v1/files/${file.id}`)
      .then((t) => { if (alive) setText(t); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [file.id]);

  if (failed) return <FileChip file={file} />;

  const lines = text === null ? [] : text.split('\n');
  const preview = lines.slice(0, TEXT_PREVIEW_LINES).join('\n');
  const canExpand = text !== null && text.length > preview.length;
  const expandTruncated = text !== null && text.length > TEXT_EXPAND_MAX;
  const shown = text === null ? 'Loading…' : expanded ? text.slice(0, TEXT_EXPAND_MAX) : preview;

  return (
    <div className="mt-1 max-w-[560px]">
      <CardHeader file={file} collapsed={collapsed} onToggle={toggleCollapsed} />
      {!collapsed && (
        <div className="mt-0.5">
          <div className="group/att relative">
            {isMarkdownFile(file) ? <MarkdownReport text={shown} /> : <pre
              data-testid={`file-text-${file.name}`}
              className="mc-scroll overflow-x-auto rounded-lg border border-hairline bg-white px-3 py-2 font-mono text-[11px] leading-4 whitespace-pre text-ink"
            >
              {shown}
            </pre>}
            <DownloadHoverButton file={file} onDownload={download} />
          </div>
          {expanded && expandTruncated && (
            <p className="mt-0.5 text-[11px] text-faint">Showing the first 100 KB — download for the full file.</p>
          )}
          {canExpand && (
            <button
              data-testid={`file-text-expand-${file.name}`}
              className="mt-0.5 text-xs font-semibold text-accent-soft hover:underline"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Collapse ▴' : 'Expand ▾'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Mid-size PDF preview via the browser's native renderer (phase 6 ruling:
 * no pdf.js dependency); click opens the in-app full reader. */
function PdfAttachment({ file }: { file: FileDTO }) {
  const { blobUrl } = useBoundApi();
  const [collapsed, toggleCollapsed] = useCollapsed(file.id);
  const [url, setUrl] = useState<string | null>(null);
  const [reader, setReader] = useState(false);
  const download = useDownload(file);

  useEffect(() => {
    let alive = true;
    void blobUrl(`/v1/files/${file.id}`).then((u) => { if (alive) setUrl(u); }).catch(() => {});
    return () => { alive = false; };
  }, [file.id]);

  return (
    <div className="mt-1">
      <CardHeader file={file} collapsed={collapsed} onToggle={toggleCollapsed} />
      {!collapsed && (
        <div className="group/att relative mt-0.5 h-[400px] w-[min(320px,100%)]">
          {url ? (
            <embed
              src={`${url}#toolbar=0&navpanes=0`}
              type="application/pdf"
              className="h-full w-full rounded-lg border border-hairline"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center rounded-lg border border-hairline bg-white text-xs text-faint">
              Loading…
            </div>
          )}
          {/* the embed swallows clicks — a transparent overlay opens the reader */}
          <button
            data-testid={`file-${file.name}`}
            className="absolute inset-0 cursor-pointer"
            title={`Open ${file.name}`}
            onClick={() => setReader(true)}
          />
          <DownloadHoverButton file={file} onDownload={download} />
        </div>
      )}
      {reader && url && (
        <PdfReader file={file} url={url} onClose={() => setReader(false)} onDownload={download} />
      )}
    </div>
  );
}

/** In-app full PDF reader overlay (browser viewer, toolbar enabled). */
function PdfReader({
  file,
  url,
  onClose,
  onDownload,
}: {
  file: FileDTO;
  url: string;
  onClose: () => void;
  onDownload: () => Promise<void>;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      data-testid="pdf-reader"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/75"
      onMouseDown={onClose}
    >
      <div className="absolute top-4 right-5 flex gap-1.5" onMouseDown={(e) => e.stopPropagation()}>
        <button
          data-testid="pdf-reader-open-external"
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 text-white hover:bg-white/30"
          title="Open external"
          onClick={() => window.open(url, '_blank')}
        >
          ↗
        </button>
        <button
          data-testid="pdf-reader-download"
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 text-white hover:bg-white/30"
          title="Download"
          onClick={() => void onDownload()}
        >
          ⤓
        </button>
        <button
          data-testid="pdf-reader-close"
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 text-white hover:bg-white/30"
          title="Close"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="h-[90vh] w-[80vw]" onMouseDown={(e) => e.stopPropagation()}>
        <embed src={url} type="application/pdf" className="h-full w-full rounded-lg" />
      </div>
      <span className="mt-2 max-w-[80vw] truncate text-xs text-white/70" onMouseDown={(e) => e.stopPropagation()}>
        {file.name}
      </span>
    </div>
  );
}

function FileChip({ file }: { file: FileDTO }) {
  const download = useDownload(file);
  return (
    <div className="group/att relative mt-1 w-fit">
      <button
        data-testid={`file-${file.name}`}
        className="flex items-center gap-2 rounded-[10px] border border-hairline bg-white py-2 pr-10 pl-3 text-left text-sm hover:border-hairline2"
        onClick={() => void download()}
      >
        <span>📄</span>
        <span>
          <span className="block font-medium">{file.name}</span>
          <span className="block text-xs text-muted">{bytesLabel(file.sizeBytes)}</span>
        </span>
      </button>
      <button
        data-testid={`file-download-${file.name}`}
        className="absolute top-1/2 right-2 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-sm text-faint hover:bg-daypill hover:text-ink group-hover/att:flex"
        title="Download"
        onClick={() => void download()}
      >
        ⤓
      </button>
    </div>
  );
}

/** In-app image popup (phase 5 item 5): original file, open-external + download icons. */
function ImageLightbox({
  file,
  onClose,
  onDownload,
}: {
  file: FileDTO;
  onClose: () => void;
  onDownload: () => Promise<void>;
}) {
  const image = useFileImageSource(file.id, 'original');
  return (
    <LightboxShell
      testId="lightbox"
      onClose={onClose}
      caption={file.name}
      actions={
        <>
          <LightboxButton
            testId="lightbox-open-external"
            title="Open external"
            onClick={() => { if (image.src) window.open(image.src, '_blank'); }}
          >
            ↗
          </LightboxButton>
          <LightboxButton testId="lightbox-download" title="Download" onClick={() => void onDownload()}>
            ⤓
          </LightboxButton>
        </>
      }
    >
      {image.src && image.status !== 'failed' ? (
        <img
          src={image.src}
          alt={file.name}
          className="max-h-[85vh] max-w-[88vw] rounded-lg object-contain"
          onLoad={image.onLoad}
          onError={image.onError}
        />
      ) : image.status === 'failed' ? (
        <div role="alert" className="flex flex-col items-center gap-2 text-sm text-white/70">
          <span>Preview unavailable</span>
          <button
            type="button"
            className="rounded-md border border-white/30 px-3 py-1.5 font-semibold text-white hover:bg-white/10"
            onClick={image.retry}
          >
            Retry
          </button>
        </div>
      ) : (
        <span className="text-sm text-white/70">Loading…</span>
      )}
    </LightboxShell>
  );
}

/**
 * "🕐 SCHEDULED" next to the author name (#420): this message was posted by
 * one of their scheduled messages rather than typed just now. It is
 * deliberately a badge on an otherwise ordinary message — the author, the
 * mentions and the notifications are all real, and only the timing was
 * automatic. Clicking it opens the Scheduled panel, where the row that posted
 * it lives.
 */
function ScheduledBadge({ author }: { author: string }) {
  const sel = useSelection();
  return (
    <HoverTooltip text={`Posted automatically · runs as ${author} · click to open Scheduled`}>
      <button
        type="button"
        data-testid="scheduled-badge"
        className="cursor-pointer rounded bg-accent/10 px-1.5 py-px text-[10px] font-bold tracking-wide text-accent-deep uppercase"
        onClick={() => sel.selectChannel(SCHEDULED_VIEW_ID)}
      >
        🕐 Scheduled
      </button>
    </HoverTooltip>
  );
}
