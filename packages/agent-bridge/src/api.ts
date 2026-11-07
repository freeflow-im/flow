// Minimal /v1 REST client speaking the agent bearer token.
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AccountDTO,
  AgentLoginResponse,
  AgentRedeemResponse,
  ArtifactDTO,
  ChannelDTO,
  DeliveryMode,
  EventFilter,
  FileDTO,
  HuddleJoinDTO,
  MessageDTO,
  MessagePage,
  AgentJobDTO,
  PlatformEvent,
  SubscriptionDTO,
  UserDTO,
  WorkspaceDTO,
  WorkspaceMemberDTO,
} from '@flow/shared';

/** A subscription's read: its events oldest first, the cursor to ack, and `gap` when some aged out unread. */
export interface SubscriptionPage { events: PlatformEvent[]; next: number; gap?: { from: number; to: number } }

/** `GET /v1/me`: the principal, with its accounts, one per organization (platform.md §3.3). Older servers send none. */
export type MeDTO = UserDTO & { accounts?: AccountDTO[] };

/** The start-up log's account lines: each account's address and organization (by name where the agent can see it). */
export function accountLines(me: MeDTO, workspaces: Pick<WorkspaceDTO, 'id' | 'name'>[]): string[] {
  const names = new Map(workspaces.map((w) => [w.id, w.name]));
  return (me.accounts ?? []).map((a) =>
    `account ${a.address} in "${names.get(a.organizationId) ?? a.organizationId}"${a.state === 'active' ? '' : ` (${a.state})`}`);
}

/** The agent's address in one organization, or null when the server gave none. */
export function addressIn(me: MeDTO, organizationId: string): string | null {
  return me.accounts?.find((a) => a.organizationId === organizationId)?.address ?? null;
}

const USER_MENTION_RE = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/g;

/** `attachment; filename*=UTF-8''my%20clip.mp4` → `my clip.mp4`, also accepting
 * the plain `filename="…"` form object stores send back. */
export function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1]?.trim();
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded; // malformed percent-escapes — the raw value still beats nothing
    }
  }
  return /filename="?([^";]+)"?/i.exec(header)?.[1]?.trim() || undefined;
}

/**
 * JSON calls get a deadline (#534). Without one a hung request — a server that
 * accepted the connection and went away — never settles, and the caller waiting
 * on it never settles either: an end-of-turn indicator PUT stalls `finish()`,
 * which holds a concurrency-semaphore slot open for as long as the process
 * lives. Every /v1 JSON call here is small; 30s is a stall, not slowness.
 */
const REQUEST_TIMEOUT_MS = 30_000;

export class FlowApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FlowApiError';
  }
}

async function parseError(res: Response): Promise<never> {
  let code = 'http_error';
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
    }
  } catch {
    /* non-JSON error body */
  }
  throw new FlowApiError(res.status, code, message);
}

/** Headers every request of one client carries besides its token: a wake job's `x-flow-job`, during its turn. */
export type ExtraHeaders = () => Record<string, string> | Promise<Record<string, string>>;

export class FlowApi {
  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
    private readonly extraHeaders: ExtraHeaders = () => ({}),
  ) {}

  /** This client, with every request marked as part of the wake job's turn (platform.md §5.2: its events carry the job). */
  withJob(jobId: string): FlowApi {
    return new FlowApi(this.serverUrl, this.token, () => ({ 'x-flow-job': jobId }));
  }

  private async auth(): Promise<Record<string, string>> {
    return { ...(await this.extraHeaders()), authorization: `Bearer ${this.token}` };
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.serverUrl}${path}`, {
        method,
        headers: {
          ...(await this.auth()),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Callers all handle FlowApiError; a bare TimeoutError would read as an
      // unrelated crash in the logs.
      if ((err as Error).name === 'TimeoutError') {
        throw new FlowApiError(504, 'timeout', `${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    }
    if (!res.ok) await parseError(res);
    return (await res.json()) as T;
  }

  me(): Promise<MeDTO> {
    return this.req('GET', '/v1/me');
  }

  // ---- the event bus's subscriptions (platform.md §5.2), as the agent's account in one organization ----

  async listSubscriptions(workspaceId: string): Promise<SubscriptionDTO[]> {
    const r = await this.req<{ subscriptions: SubscriptionDTO[] }>('GET', `/v1/events/subscriptions?workspace=${encodeURIComponent(workspaceId)}`);
    return r.subscriptions;
  }

  async createSubscription(workspaceId: string, body: { name: string; filter: EventFilter; delivery?: DeliveryMode }): Promise<SubscriptionDTO> {
    const r = await this.req<{ subscription: SubscriptionDTO }>('POST', `/v1/events/subscriptions?workspace=${encodeURIComponent(workspaceId)}`, body);
    return r.subscription;
  }

  /** What follows the subscription's cursor; never acks. `wait` long-polls, in seconds. */
  readSubscription(workspaceId: string, id: string, opts: { limit?: number; wait?: number } = {}): Promise<SubscriptionPage> {
    const q = `workspace=${encodeURIComponent(workspaceId)}${opts.limit ? `&limit=${opts.limit}` : ''}&wait=${opts.wait ?? 0}`;
    return this.req('GET', `/v1/events/subscriptions/${encodeURIComponent(id)}?${q}`);
  }

  async ackSubscription(workspaceId: string, id: string, cursor: number): Promise<number> {
    const r = await this.req<{ cursor: number }>('POST', `/v1/events/subscriptions/${encodeURIComponent(id)}/ack?workspace=${encodeURIComponent(workspaceId)}`, { cursor });
    return r.cursor;
  }

  async deleteSubscription(workspaceId: string, id: string): Promise<void> {
    await this.req('DELETE', `/v1/events/subscriptions/${encodeURIComponent(id)}?workspace=${encodeURIComponent(workspaceId)}`);
  }

  /** A wake job's steps (platform.md §5.2), as its agent: `ack` takes it under a lease, `extend` renews it, `done` closes it. */
  async jobStep(workspaceId: string, jobId: string, step: 'ack' | 'extend' | 'done', body?: { ok: boolean; note?: string }): Promise<AgentJobDTO> {
    const r = await this.req<{ job: AgentJobDTO }>('POST', `/v1/events/jobs/${encodeURIComponent(jobId)}/${step}?workspace=${encodeURIComponent(workspaceId)}`, body ?? {});
    return r.job;
  }

  async myWorkspaces(): Promise<WorkspaceDTO[]> {
    const r = await this.req<{ workspaces: WorkspaceDTO[] }>('GET', '/v1/me/workspaces');
    return r.workspaces;
  }

  async listChannels(workspaceId: string): Promise<ChannelDTO[]> {
    const r = await this.req<{ channels: ChannelDTO[] }>('GET', `/v1/workspaces/${workspaceId}/channels`);
    return r.channels;
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMemberDTO[]> {
    const r = await this.req<{ members: WorkspaceMemberDTO[] }>('GET', `/v1/workspaces/${workspaceId}/members`);
    return r.members;
  }

  /** Post a message; mentions are parsed out of the body (server fans out notifications). */
  sendMessage(channelId: string, body: string, threadRootId?: string, fileIds?: string[], clientMsgId: string = randomUUID()): Promise<MessageDTO> {
    const mentions = [...new Set([...body.matchAll(USER_MENTION_RE)].map((m) => m[1]!))];
    return this.req('POST', `/v1/channels/${channelId}/messages`, {
      clientMsgId,
      body: body.slice(0, 12000),
      ...(threadRootId ? { threadRootId } : {}),
      ...(fileIds?.length ? { fileIds } : {}),
      ...(mentions.length ? { mentions: mentions.slice(0, 50) } : {}),
    });
  }

  getArtifact(artifactId: string): Promise<ArtifactDTO> {
    return this.req('GET', `/v1/artifacts/${artifactId}`);
  }

  editMessage(messageId: string, body: string): Promise<MessageDTO> {
    return this.req('PATCH', `/v1/messages/${messageId}`, { body: body.slice(0, 12000) });
  }

  /** `hard` purges the row (no tombstone) — used for the ephemeral "thinking…" status. */
  deleteMessage(messageId: string, opts?: { hard?: boolean }): Promise<void> {
    return this.req('DELETE', `/v1/messages/${messageId}${opts?.hard ? '?purge=true' : ''}`);
  }

  /**
   * Channel activity indicator (#137): spin this channel's sidebar row while
   * we work, or stop. The server holds this in memory and expires it, so a set
   * must be refreshed to outlive `ttlSeconds` — that's deliberate, it's what
   * stops a crashed run leaving a channel spinning forever.
   */
  setChannelIndicator(channelId: string, state: 'busy' | 'none', ttlSeconds?: number): Promise<{ state: string | null }> {
    return this.req('PUT', `/v1/channels/${channelId}/indicator`, {
      state,
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    });
  }

  /**
   * Channel emoji (#396): the persistent glyph after a channel's name. Nothing
   * like the indicator above despite sharing that sidebar slot — this is a
   * stored channel property, so it stays until someone changes it. `null`
   * clears it.
   */
  setChannelEmoji(channelId: string, emoji: string | null): Promise<{ emoji: string | null }> {
    return this.req('PUT', `/v1/channels/${channelId}/emoji`, { emoji });
  }

  listMessages(channelId: string, limit = 50, before?: string): Promise<MessagePage> {
    return this.req('GET', `/v1/channels/${channelId}/messages?limit=${limit}${before ? `&before=${before}` : ''}`);
  }

  joinChannel(channelId: string): Promise<unknown> {
    return this.req('POST', `/v1/channels/${channelId}/join`);
  }

  leaveChannel(channelId: string): Promise<unknown> {
    return this.req('POST', `/v1/channels/${channelId}/leave`);
  }

  /** Answer an existing DM huddle ring and receive the ordinary room token. */
  acceptHuddleInvite(inviteId: string): Promise<HuddleJoinDTO> {
    return this.req('POST', `/v1/huddle/invites/${inviteId}/accept`, {});
  }

  declineHuddleInvite(inviteId: string): Promise<unknown> {
    return this.req('POST', `/v1/huddle/invites/${inviteId}/decline`, {});
  }

  leaveHuddle(channelId: string): Promise<unknown> {
    return this.req('POST', `/v1/channels/${channelId}/huddle/leave`, {});
  }

  /** Create a standard channel; the caller is auto-added as a member. Duplicate
   * name in the workspace → 409 `channel_exists`. */
  createChannel(
    workspaceId: string,
    body: { name: string; topic?: string; isPrivate?: boolean; parentId?: string },
  ): Promise<ChannelDTO> {
    return this.req('POST', `/v1/workspaces/${workspaceId}/channels`, body);
  }

  /** Add one workspace member to a channel (public → any member may add;
   * private → members only). One user per call, server-side. */
  addChannelMember(channelId: string, userId: string): Promise<unknown> {
    return this.req('POST', `/v1/channels/${channelId}/members`, { userId });
  }

  /** The whole thread, root first — the server returns the root separately. */
  async listThread(rootId: string, limit = 200): Promise<MessageDTO[]> {
    const r = await this.req<{ root: MessageDTO; messages: MessageDTO[] }>(
      'GET',
      `/v1/messages/${rootId}/thread?limit=${limit}`,
    );
    return r.root ? [r.root, ...r.messages] : r.messages;
  }

  addReaction(messageId: string, emoji: string): Promise<unknown> {
    return this.req('PUT', `/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
  }

  /** Download a file attachment's original bytes (the agent is a channel member, so /v1/files authorizes it). */
  async downloadFile(fileId: string): Promise<Buffer> {
    return (await this.downloadFileWithMeta(fileId)).data;
  }

  /** Bounded streaming download for live calls; cancel on hangup or timeout. */
  async downloadCallFile(fileId: string, signal: AbortSignal): Promise<Buffer> {
    const limit = 20 * 1024 * 1024;
    const res = await fetch(`${this.serverUrl}/v1/files/${encodeURIComponent(fileId)}`, {
      headers: await this.auth(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (!res.ok) await parseError(res);
    if (!res.body) throw new Error('File download returned no content');
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('File exceeds the 20 MB call limit');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return Buffer.concat(chunks);
  }

  /** As `downloadFile`, plus the name and type the bytes came labelled with —
   * a caller holding only a file id (the MCP `download_file` tool) needs the
   * real extension for the file it writes. Either header may be missing when
   * the download redirects to object storage; callers fall back. */
  async downloadFileWithMeta(
    fileId: string,
  ): Promise<{ data: Buffer; filename: string | undefined; mimeType: string | undefined }> {
    const res = await fetch(`${this.serverUrl}/v1/files/${fileId}`, {
      headers: await this.auth(),
    });
    if (!res.ok) await parseError(res);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      filename: filenameFromDisposition(res.headers.get('content-disposition')),
      mimeType: res.headers.get('content-type') || undefined,
    };
  }

  /** Set the agent's own avatar (server square-crops to 512px webp). */
  async setAvatar(filename: string, mimeType: string, data: Buffer): Promise<UserDTO> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], { type: mimeType }), filename);
    const res = await fetch(`${this.serverUrl}/v1/me/avatar`, {
      method: 'POST',
      headers: await this.auth(),
      body: form,
    });
    if (!res.ok) await parseError(res);
    return (await res.json()) as UserDTO;
  }

  /** Phase 13: pin `fileId` as a shared artifact in a channel. The caller must
   * be a member of the channel and able to read the file. `ownsFile` marks an
   * artifact whose file was uploaded for it (agent-generated). */
  /** With `app: true` (link artifacts only) the response is an
   * `AppArtifactSecretDTO`: the artifact plus its app secret, which Flow
   * returns exactly once — see docs/design/MINI_APPS.md. */
  createArtifact(
    channelId: string,
    opts: {
      fileId?: string | undefined;
      url?: string | undefined;
      name?: string | undefined;
      ownsFile?: boolean | undefined;
      app?: boolean | undefined;
      requesterUserId?: string | undefined;
      sourceThreadRootId?: string | undefined;
      operationId?: string | undefined;
    },
  ): Promise<ArtifactDTO & { appSecret?: string }> {
    return this.req('POST', '/v1/artifacts', {
      channelId,
      ...(opts.fileId ? { fileId: opts.fileId } : {}),
      ...(opts.url ? { url: opts.url } : {}),
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.ownsFile ? { ownsFile: opts.ownsFile } : {}),
      ...(opts.app ? { app: true } : {}),
      ...(opts.requesterUserId ? { requesterUserId: opts.requesterUserId } : {}),
      ...(opts.sourceThreadRootId ? { sourceThreadRootId: opts.sourceThreadRootId } : {}),
      ...(opts.operationId ? { operationId: opts.operationId } : {}),
    });
  }

  /** Phase 13: rename and/or re-point an artifact at a new file (the "update"
   * path). At least one of name/fileId must be provided. */
  /** The caller's visible artifacts in the workspace (channels they are a member
   * of), newest first. Callers filter by channelId. */
  async listArtifacts(workspaceId: string): Promise<ArtifactDTO[]> {
    const r = await this.req<{ artifacts: ArtifactDTO[] }>('GET', `/v1/workspaces/${workspaceId}/artifacts`);
    return r.artifacts;
  }

  updateArtifact(
    artifactId: string,
    patch: { name?: string; fileId?: string; ownsFile?: boolean; url?: string },
  ): Promise<ArtifactDTO> {
    return this.req('PATCH', `/v1/artifacts/${artifactId}`, patch);
  }

  /** Unpin an artifact for everyone in its channel (#393). Idempotent on the
   * server: an id that no longer exists succeeds rather than 404s, so callers
   * that want a "no such artifact" answer must look it up first. */
  async deleteArtifact(artifactId: string): Promise<void> {
    await this.req<{ ok: boolean }>('DELETE', `/v1/artifacts/${artifactId}`);
  }

  async uploadFile(workspaceId: string, filename: string, mimeType: string, data: Buffer): Promise<FileDTO> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], { type: mimeType }), filename);
    const res = await fetch(`${this.serverUrl}/v1/workspaces/${workspaceId}/files`, {
      method: 'POST',
      headers: await this.auth(),
      body: form,
    });
    if (!res.ok) await parseError(res);
    return (await res.json()) as FileDTO;
  }
}

// ---- Invite-code onboarding (AGENT_MEMBERS.md) ------------------
// A human member generates a one-time invite code inside Flow; the agent
// redeems it with its durable credentials (username + secret key) and joins
// immediately — no sponsor approval. The code carries the sponsor + workspace.

/** A fresh agent secret key (the agent's password-equivalent, shown/stored once). */
export function newAgentKey(): string {
  return `flow-agent-key-${randomBytes(24).toString('base64url')}`;
}

export interface RedeemInput {
  code: string;
  username: string;
  key: string;
  name: string;
  description?: string;
}

/**
 * Redeem a one-time invite code (the code IS the auth). Returns the agent token
 * synchronously — don't lose it (recovery: `flow-agent-bridge login` with the
 * username + key).
 */
export async function redeemAgentInvite(serverUrl: string, input: RedeemInput): Promise<AgentRedeemResponse> {
  const res = await fetch(`${serverUrl.replace(/\/+$/, '')}/v1/agents/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) await parseError(res);
  return (await res.json()) as AgentRedeemResponse;
}

/** Unauthenticated: username + key → fresh agent token (revokes prior tokens). */
export async function agentLogin(serverUrl: string, username: string, key: string): Promise<AgentLoginResponse> {
  const res = await fetch(`${serverUrl.replace(/\/+$/, '')}/v1/agents/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, key }),
  });
  if (!res.ok) await parseError(res);
  return (await res.json()) as AgentLoginResponse;
}
