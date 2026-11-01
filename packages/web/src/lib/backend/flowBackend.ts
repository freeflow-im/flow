// FlowBackend — the WorkspaceBackend a Flow server session speaks
// (docs/specs/multi-server-workspaces.md, "Provider abstraction and identity").
// A thin adapter over ConnectionRuntime's REST client: every chat-core path the
// hooks used to build lives here now, so a component never sees `/v1/…`.
//
// Live updates: the Flow socket carries far more than chat (artifacts, huddles,
// notifications, presence), and Main.tsx keeps owning that socket. This
// backend's `subscribe` is therefore a no-op for Flow; the normalized stream
// exists for a backend whose only feed is chat.
import {
  BackendError, allSupported, unavailable,
  type BackendAuthState, type BackendChannel, type BackendEventHandler, type BackendMessage, type Capabilities,
  type FileDTO, type HistoryPage, type MessageDTO, type MessagePage, type SearchResult, type SendMessageInput,
  type SendReceipt, type ThreadPage, type UserDTO, type WorkspaceBackend, type WorkspaceDTO, type WorkspaceMemberDTO,
} from '@flow/shared';
import { ApiError, type ConnectionRuntime } from '../connectionRuntime';

export class FlowBackend implements WorkspaceBackend {
  readonly provider = 'flow' as const;
  readonly connectionId: string;
  private caps: Capabilities;

  constructor(private readonly runtime: ConnectionRuntime) {
    this.connectionId = runtime.connectionId;
    // Flow has no server-side search yet; everything else is native.
    this.caps = { ...allSupported(), search: unavailable('Search is not available on this server yet.') };
  }

  private api<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.runtime.api<T>(method, path, body).catch((error: unknown) => { throw toBackendError(error); });
  }

  auth(): BackendAuthState {
    const userId = this.runtime.userId;
    return { status: this.runtime.getToken() ? 'authenticated' : 'signed_out', userId, label: this.runtime.label };
  }

  capabilities(): Capabilities { return this.caps; }

  me(): Promise<UserDTO> { return this.api<UserDTO>('GET', '/v1/me'); }

  async signOut(): Promise<void> { await this.api('POST', '/v1/auth/logout').catch(() => {}); }

  async listWorkspaces(): Promise<WorkspaceDTO[]> {
    return (await this.api<{ workspaces: WorkspaceDTO[] }>('GET', '/v1/me/workspaces')).workspaces;
  }

  async listConversations(workspaceId: string, options?: { includeArchived?: boolean }): Promise<BackendChannel[]> {
    const query = options?.includeArchived ? '?includeArchived=1' : '';
    return (await this.api<{ channels: BackendChannel[] }>('GET', `/v1/workspaces/${workspaceId}/channels${query}`)).channels;
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMemberDTO[]> {
    return (await this.api<{ members: WorkspaceMemberDTO[] }>('GET', `/v1/workspaces/${workspaceId}/members`)).members;
  }

  /** Flow pages by "before this message id"; the cursor is the oldest id seen. */
  async history(channelId: string, { cursor, limit }: { cursor: string | null; limit: number }): Promise<HistoryPage> {
    const page = await this.api<MessagePage>('GET', `/v1/channels/${channelId}/messages?limit=${limit}${cursor ? `&before=${cursor}` : ''}`);
    const oldest = page.messages[page.messages.length - 1];
    return { messages: [...page.messages].reverse(), cursor: page.hasMore && oldest ? oldest.id : null, partial: false };
  }

  async thread(channelId: string, rootId: string): Promise<ThreadPage> {
    const data = await this.api<MessagePage & { root: MessageDTO }>('GET', `/v1/messages/${rootId}/thread?limit=200`);
    return { root: data.root, replies: data.messages, cursor: null, partial: data.hasMore };
  }

  async send(input: SendMessageInput): Promise<SendReceipt> {
    const message = await this.api<BackendMessage>('POST', `/v1/channels/${input.channelId}/messages`, {
      clientMsgId: input.clientMsgId,
      body: input.body,
      ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
      ...(input.fileIds?.length ? { fileIds: input.fileIds } : {}),
      ...(input.mentions?.length ? { mentions: input.mentions } : {}),
    });
    return { message };
  }

  edit(_channelId: string, messageId: string, body: string): Promise<BackendMessage> {
    return this.api<BackendMessage>('PATCH', `/v1/messages/${messageId}`, { body });
  }

  async delete(_channelId: string, messageId: string, options: { purge?: boolean } = {}): Promise<void> {
    await this.api('DELETE', `/v1/messages/${messageId}${options.purge ? '?purge=true' : ''}`);
  }

  async setReaction(_channelId: string, messageId: string, emoji: string, on: boolean): Promise<void> {
    await this.api(on ? 'PUT' : 'DELETE', `/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
  }

  async markRead(channelId: string, messageId: string, options: { threadRootId?: string } = {}): Promise<void> {
    await this.api('POST', `/v1/channels/${channelId}/read`, { lastReadMsgId: messageId, ...(options.threadRootId ? { threadRootId: options.threadRootId } : {}) });
  }

  uploadFile(target: { workspaceId: string; channelId: string }, file: { size: number; type: string; name?: string }): Promise<FileDTO> {
    return this.runtime.uploadFile(target.workspaceId, file as File).catch((error: unknown) => { throw toBackendError(error); });
  }

  /** Flow files are fetched through the authenticated blob path by the file
   * components themselves; there is no direct URL to hand out. */
  fileUrl(): string | null { return null; }

  search(): Promise<SearchResult> {
    return Promise.reject(new BackendError('unsupported', this.caps.search.reason ?? 'Search is not available.'));
  }

  subscribe(_handler: BackendEventHandler): () => void { return () => {}; }

  openUrl(): string | null { return null; }
}

/** Translate the runtime's ApiError into the provider-neutral error the UI
 * reasons about; other errors pass through as `provider_error`. */
export function toBackendError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof ApiError) {
    const code = error.status === 401 ? 'unauthorized' : error.status === 404 ? 'not_found' : error.status === 429 ? 'rate_limited' : error.status === 0 ? 'timeout' : error.status >= 400 && error.status < 500 ? 'invalid' : 'provider_error';
    return new BackendError(code, error.message, { providerCode: error.code });
  }
  return new BackendError('provider_error', error instanceof Error ? error.message : String(error));
}
