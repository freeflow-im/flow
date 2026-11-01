// WorkspaceBackend — the provider contract every Flow client consumes
// (docs/specs/multi-server-workspaces.md, "Provider abstraction and identity",
// "Public API baseline and feature mapping", "Notifications and parity").
//
// One connection = one backend. FlowBackend speaks Flow REST/WS to one Flow
// server; a client holds one backend per connected server. UI code consumes
// this interface and the normalized DTOs; it never builds a provider path, and
// an action whose capability is not `supported` never falls through to a
// server mutation. (The Slack provider that once shared this seam was removed
// for the FreeFlow suite, docs/specs/freeflow-suite.md §2.0.)
import type { ChannelDTO, FileDTO, MessageDTO, MessagePage, UserDTO, WorkspaceDTO, WorkspaceMemberDTO } from './dto.js';

export type BackendProvider = 'flow';

// ---- capabilities -----------------------------------------------------------

export type CapabilityState = 'supported' | 'limited' | 'unavailable';

/** A control's state plus the sentence the client shows for it. `reason` is
 * required unless the capability is fully supported. */
export interface Capability {
  state: CapabilityState;
  reason?: string;
}

export const CAPABILITY_NAMES = [
  'conversations', 'history', 'threads', 'send', 'edit', 'delete', 'reactions', 'files', 'search',
  'readState', 'liveUpdates', 'typing', 'presence', 'pins', 'huddles', 'artifacts', 'agents', 'apps',
  'admin', 'scheduledMessages', 'notifications', 'channelManagement', 'status',
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export type Capabilities = Record<CapabilityName, Capability>;

export const supported = (): Capability => ({ state: 'supported' });
export const limited = (reason: string): Capability => ({ state: 'limited', reason });
export const unavailable = (reason: string): Capability => ({ state: 'unavailable', reason });

/** Every capability supported — the Flow backend's baseline. */
export function allSupported(): Capabilities {
  return Object.fromEntries(CAPABILITY_NAMES.map(name => [name, supported()])) as Capabilities;
}

/** Every capability unavailable with one reason, then overridden per name. */
export function capabilitiesFrom(base: Capability, overrides: Partial<Capabilities>): Capabilities {
  const all = Object.fromEntries(CAPABILITY_NAMES.map(name => [name, base])) as Capabilities;
  return { ...all, ...overrides };
}

export function canUse(caps: Capabilities, name: CapabilityName): boolean {
  return caps[name].state !== 'unavailable';
}

// ---- auth -------------------------------------------------------------------

export type BackendAuthStatus = 'authenticated' | 'unauthorized' | 'reauthorization_required' | 'signed_out';

export interface BackendAuthState {
  status: BackendAuthStatus;
  /** The signed-in identity's user id on that server. */
  userId: string | null;
  /** Human-readable identity line for the switcher ("alice · Acme"). */
  label: string;
  /** For providers with an installation/grant lifecycle: the reason a
   * non-authenticated status was reached, in the provider's own words. */
  detail?: string;
}

// ---- normalized models ------------------------------------------------------

export type BackendMessage = MessageDTO;
export type BackendChannel = ChannelDTO;

export interface HistoryPage {
  /** Oldest first, like the transcript. */
  messages: BackendMessage[];
  /** Opaque provider cursor for the next older page; null when exhausted. */
  cursor: string | null;
  /** True when the provider limited this page (rate budget, page cap, retention)
   * so the client shows the transcript as visibly partial rather than complete. */
  partial: boolean;
  /** When the next request would be refused before this many ms pass. */
  retryAfterMs?: number;
}

export interface ThreadPage {
  root: BackendMessage;
  replies: BackendMessage[];
  cursor: string | null;
  partial: boolean;
  retryAfterMs?: number;
}

export interface SendMessageInput {
  channelId: string;
  body: string;
  /** Client-generated idempotency key; echoed back by the provider so a
   * timeout can be reconciled without a blind retry. */
  clientMsgId: string;
  threadRootId?: string | null;
  fileIds?: string[];
  /** Explicit mention targets (Flow); providers that derive mentions from the
   * body ignore it. */
  mentions?: string[];
}

export interface SendReceipt {
  message: BackendMessage;
}

export interface SearchResult {
  messages: BackendMessage[];
  cursor: string | null;
  partial: boolean;
}

// ---- events -----------------------------------------------------------------

export type BackendEvent =
  | { type: 'message.created'; message: BackendMessage }
  | { type: 'message.updated'; message: BackendMessage }
  | { type: 'message.deleted'; channelId: string; messageId: string; threadRootId: string | null }
  | { type: 'thread.reply'; message: BackendMessage }
  | { type: 'reaction.added' | 'reaction.removed'; channelId: string; messageId: string; emoji: string; userId: string }
  | { type: 'channel.updated'; channel: BackendChannel }
  | { type: 'channel.read'; channelId: string; lastReadMsgId: string | null }
  | { type: 'typing'; channelId: string; userId: string; threadRootId?: string | null }
  | { type: 'presence'; userId: string; online: boolean }
  /** A member's profile changed (name, avatar, status). Replaces the cached
   * member; for the signed-in user it also replaces `me`. */
  | { type: 'member.updated'; member: WorkspaceMemberDTO }
  | { type: 'auth.changed'; auth: BackendAuthState }
  | { type: 'capabilities.changed'; capabilities: Capabilities }
  /** The live stream is degraded: events may be missing until `resumesAt`.
   * Clients show an honest "delayed" state and reconcile by refetch. */
  | { type: 'stream.degraded'; reason: string; resumesAtMs: number | null }
  | { type: 'stream.recovered' };

export type BackendEventHandler = (event: BackendEvent) => void;

// ---- the contract -----------------------------------------------------------

export interface WorkspaceBackend {
  readonly provider: BackendProvider;
  readonly connectionId: string;

  auth(): BackendAuthState;
  capabilities(): Capabilities;
  /** The signed-in identity as the UI's user model. Providers without a Flow
   * account synthesize it from their own identity (no email, default prefs). */
  me(): Promise<UserDTO>;
  /** End this client's session with the provider; the connection record and
   * any other client's session are untouched. */
  signOut(): Promise<void>;

  listWorkspaces(): Promise<WorkspaceDTO[]>;
  /** `includeArchived` (#588): add archived public channels, for the channel
   * browser. Providers without archives ignore it. */
  listConversations(workspaceId: string, options?: { includeArchived?: boolean }): Promise<BackendChannel[]>;
  listMembers(workspaceId: string): Promise<WorkspaceMemberDTO[]>;

  /** Older messages before `cursor` (null = latest page). Oldest first. */
  history(channelId: string, options: { cursor: string | null; limit: number }): Promise<HistoryPage>;
  thread(channelId: string, rootId: string, options?: { cursor: string | null }): Promise<ThreadPage>;

  send(input: SendMessageInput): Promise<SendReceipt>;
  edit(channelId: string, messageId: string, body: string): Promise<BackendMessage>;
  /** `purge` asks for a hard delete where the provider distinguishes one (Flow). */
  delete(channelId: string, messageId: string, options?: { purge?: boolean }): Promise<void>;
  setReaction(channelId: string, messageId: string, emoji: string, on: boolean): Promise<void>;
  /** With `threadRootId` it means "I am looking at this thread" (Flow keeps a
   * separate cursor for replies); providers without that ignore it. */
  markRead(channelId: string, messageId: string, options?: { threadRootId?: string }): Promise<void>;

  /** `file` is a Blob/File in browsers; typed loosely so this package stays DOM-free. */
  uploadFile(target: { workspaceId: string; channelId: string }, file: { size: number; type: string; name?: string }): Promise<FileDTO>;
  fileUrl(file: FileDTO): string | null;

  search(query: string, options?: { cursor: string | null }): Promise<SearchResult>;

  /** Subscribe to the normalized stream; returns the unsubscribe function. */
  subscribe(handler: BackendEventHandler): () => void;

}

// ---- errors -----------------------------------------------------------------

export type BackendErrorCode =
  | 'unsupported'          // capability unavailable; never retried, never re-routed
  | 'rate_limited'         // retryAfterMs set; the client waits and says so
  | 'unauthorized'         // reauthorization required
  | 'not_found'
  | 'invalid'
  | 'timeout'              // outcome unknown: reconcile by clientMsgId/ts before retrying
  | 'provider_error';

export class BackendError extends Error {
  readonly code: BackendErrorCode;
  readonly retryAfterMs: number | undefined;
  readonly providerCode: string | undefined;
  constructor(code: BackendErrorCode, message: string, options: { retryAfterMs?: number; providerCode?: string } = {}) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
    this.providerCode = options.providerCode;
  }
}

// ---- helpers ----------------------------------------------------------------

/** Page contents that could cross pages, deduplicated by id while preserving
 * order — an event can arrive for a message that a lazy history page also
 * contains. */
export function dedupeMessages<T extends { id: string }>(messages: T[]): T[] {
  const seen = new Set<string>();
  return messages.filter(m => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

export type { MessagePage };
