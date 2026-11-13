// The suite's API on the edge Worker, same origin with the session cookie: the Org object's routes (the workspace, its
// members, invitations, emoji, join link) and the directory's (domains, accounts). A 401 sends the browser to sign in.
import type { AccountDTO, AccountKind, AgentDefinitionDTO, PlatformEvent, UsableAgentDTO, AgentInviteDTO, ChannelDTO, DnsRecordDTO, DomainDTO, DomainKind, FileDTO, InviteResultDTO, JoinLinkDTO, MemberRole, OAuthIdentityDTO, PresignedUploadDTO, PublicConfigDTO, UpdateWorkspaceBody, WorkspaceDTO, WorkspaceEmojiDTO, WorkspaceInviteDTO, WorkspaceMemberDTO } from '@flow/shared';

export class AdminApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

const toSignIn = () => {
  if (!new URLSearchParams(window.location.search).has('next')) window.location.assign(`/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
};

async function answer<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    toSignIn();
    throw new AdminApiError('unauthorized', 'Your session has ended. Sign in again.', 401);
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new AdminApiError(err?.error?.code ?? 'server_error', err?.error?.message ?? `${res.status} ${res.statusText}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return answer<T>(res);
}

/** One file as multipart: the server-buffered path the workspace icon takes. */
async function uploadMultipart<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file, file.name);
  return answer<T>(await fetch(path, { method: 'POST', credentials: 'same-origin', body: form }));
}

/** A file into the workspace's store: presign, PUT, complete (as Chat's connectionRuntime.uploadFile). */
async function uploadFile(workspaceId: string, file: File): Promise<FileDTO> {
  const pres = await request<PresignedUploadDTO>('POST', `/v1/workspaces/${encodeURIComponent(workspaceId)}/files/presign`, {
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
  });
  const target = pres.upload.url;
  // A relative target is the Worker's own proxied upload, which takes the cookie; an absolute one is the store, which must not see it.
  const relative = !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) && !target.startsWith('//');
  const put = await fetch(target, { method: pres.upload.method, credentials: relative ? 'same-origin' : 'omit', redirect: 'error', headers: pres.upload.headers, body: file });
  if (!put.ok) throw new AdminApiError('upload_failed', `upload failed (HTTP ${put.status})`, put.status);
  return request<FileDTO>('POST', `/v1/files/${encodeURIComponent(pres.file.id)}/complete`);
}

const ws = (id: string) => `/v1/workspaces/${encodeURIComponent(id)}`;

import type { AgentAvatarPreset, AssistantPrompts, AssistantSettings, AssistantSettingsUpdate } from '@flow/shared/assistant';

/** The person's own assistant (docs/specs/agents.md §1.1): its definition, who may mail it, and the model it runs on, from
 * the platform's /v1 routes, so this app depends on no other app (decision_log 2026-11-11). */
const mine = (id: string, part: 'definition' | 'senders' | 'model') => `/v1/workspaces/${encodeURIComponent(id)}/assistant/${part}`;
export const assistantApi = {
  definition: async (org: string) => (await request<{ definition: AgentDefinitionDTO }>('GET', mine(org, 'definition'))).definition,
  saveDefinition: async (org: string, body: { name?: string; instructions?: string }) => (await request<{ definition: AgentDefinitionDTO }>('PUT', mine(org, 'definition'), body)).definition,
  allowlist: async (org: string) => (await request<{ senders: string[] }>('GET', mine(org, 'senders'))).senders,
  saveAllowlist: async (org: string, senders: string[]) => (await request<{ senders: string[] }>('PUT', mine(org, 'senders'), { senders })).senders,
  settings: async (org: string) => (await request<{ settings: AssistantSettings }>('GET', mine(org, 'model'))).settings,
  saveSettings: async (org: string, body: AssistantSettingsUpdate) => (await request<{ settings: AssistantSettings }>('PUT', mine(org, 'model'), body)).settings,
  /** Its picture: a preset (null for none), or an upload. */
  // The assistant's picture, or with `agent` another agent the person may change (agents.md §1.3).
  setPreset: (org: string, preset: AgentAvatarPreset | null, agent?: string) => request<{ avatarUrl: string | null }>('PUT', `/v1/workspaces/${encodeURIComponent(org)}/assistant/avatar${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`, { preset }),
  uploadPicture: (org: string, file: File, agent?: string) => uploadMultipart<{ avatarUrl: string | null }>(`/v1/workspaces/${encodeURIComponent(org)}/assistant/avatar${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`, file),
};

/** An agent the person connected over MCP (Claude Desktop, Claude Code, …), as GET /v1/me/agent-connections lists it. */
/** One of an agent's memory files, as the Memory tab shows it. `trust: external`: written while reading someone else's content. */
export interface MemoryFileDTO { path: string; body: string; trust: string; updatedAt: string }

export interface AgentConnection { id: string; name: string; mode?: 'personal' | 'shared'; agentName?: string; origin: string; endpoint: string; connectedAt: string; lastActiveAt?: string; organization?: string }
/** The organization's suggested prompts for the assistant's panel, by page (agents.md §1.2): only the pages it changed. */
export const promptsApi = {
  get: async (org: string) => (await request<{ prompts: AssistantPrompts }>('GET', `${ws(org)}/assistant-prompts`)).prompts,
  save: async (org: string, prompts: AssistantPrompts) => (await request<{ prompts: AssistantPrompts }>('PUT', `${ws(org)}/assistant-prompts`, { prompts })).prompts,
};

export const connectionsApi = {
  list: () => request<{ mcpUrl: string; agents: AgentConnection[] }>('GET', '/v1/me/agent-connections'),
  disconnect: (id: string) => request<{ ok: true }>('DELETE', `/v1/me/agent-connections/${encodeURIComponent(id)}`),
};

export const adminApi = {
  update: (id: string, patch: UpdateWorkspaceBody) => request<WorkspaceDTO>('PATCH', ws(id), patch),
  setIcon: (id: string, file: File) => uploadMultipart<WorkspaceDTO>(`${ws(id)}/avatar`, file),
  clearIcon: (id: string) => request<WorkspaceDTO>('DELETE', `${ws(id)}/avatar`),
  // The full list (decision_log 2026-11-11): people, guests, shared agents and personal agents, from the Org object.
  members: async (id: string) => (await request<{ members: WorkspaceMemberDTO[] }>('GET', `${ws(id)}/members?all=1`)).members,
  transferOwnership: (id: string, userId: string) => request<WorkspaceDTO>('POST', `${ws(id)}/owner`, { userId }),
  deleteWorkspace: (id: string) => request<unknown>('DELETE', ws(id)),
  emoji: async (id: string) => (await request<{ emoji: WorkspaceEmojiDTO[] }>('GET', `${ws(id)}/emoji`)).emoji,
  addEmoji: async (id: string, shortcode: string, file: File) => {
    const uploaded = await uploadFile(id, file);
    return request<WorkspaceEmojiDTO>('POST', `${ws(id)}/emoji`, { shortcode, fileId: uploaded.id });
  },
  removeEmoji: (id: string, emojiId: string) => request<unknown>('DELETE', `${ws(id)}/emoji/${encodeURIComponent(emojiId)}`),
  joinLink: (id: string) => request<JoinLinkDTO>('GET', `${ws(id)}/join-link`),
  newJoinLink: (id: string) => request<JoinLinkDTO>('POST', `${ws(id)}/join-link`),
  revokeJoinLink: (id: string) => request<JoinLinkDTO>('DELETE', `${ws(id)}/join-link`),
  identities: async () => (await request<{ identities: OAuthIdentityDTO[] }>('GET', '/v1/me/identities')).identities,
  config: () => request<PublicConfigDTO>('GET', '/v1/config'),
  // Domains (routes/domains.ts): the list with each record's DNS check, reused for a minute unless `refresh`.
  domains: async (id: string, refresh = false) => (await request<{ domains: DomainDTO[] }>('GET', `${ws(id)}/domains${refresh ? '?refresh=1' : ''}`)).domains,
  addDomain: (id: string, domain: string) => request<DomainDTO>('POST', `${ws(id)}/domains`, { domain }),
  verifyDomain: (id: string, domain: string) => request<{ verified: boolean; found: string[] }>('POST', `${ws(id)}/domains/${encodeURIComponent(domain)}/verify`),
  /** "Turn on mail" (docs/specs/workspace-admin.md §4.3): the domain made at the provider, its DKIM record back. */
  turnOnMail: (id: string, domain: string) => request<{ domain: string; kind: DomainKind; selector: string; record: DnsRecordDTO }>('POST', `${ws(id)}/domains/${encodeURIComponent(domain)}/dkim`),
  makePrimary: (id: string, domain: string) => request<unknown>('PATCH', `${ws(id)}/domains/${encodeURIComponent(domain)}`, { primary: true }),
  removeDomain: (id: string, domain: string) => request<unknown>('DELETE', `${ws(id)}/domains/${encodeURIComponent(domain)}`),
  // Accounts (routes/accounts.ts), owner or admin: the organization's, removed ones left out.
  accounts: async (id: string) => (await request<{ accounts: AccountDTO[] }>('GET', `${ws(id)}/accounts`)).accounts,
  // Members (docs/specs/workspace-admin.md §3.2, §5): roles, kinds, removal, mailboxes.
  setRole: (id: string, userId: string, role: Exclude<MemberRole, 'owner'>) => request<unknown>('PATCH', `${ws(id)}/members/${encodeURIComponent(userId)}/role`, { role }),
  removeMember: (id: string, userId: string) => request<unknown>('DELETE', `${ws(id)}/members/${encodeURIComponent(userId)}`),
  setKind: (id: string, accountId: string, kind: AccountKind) => request<{ account: AccountDTO }>('PATCH', `${ws(id)}/accounts/${encodeURIComponent(accountId)}/kind`, { kind }),
  makeMembersGuests: (id: string) => request<{ changed: number; unchanged: number }>('POST', `${ws(id)}/accounts/kind`, { kind: 'guest', all: true }),
  provisionAll: (id: string) => request<{ queued: number }>('POST', `${ws(id)}/provision`, {}),
  provisionOne: (id: string, accountId: string) => request<{ queued: boolean }>('POST', `${ws(id)}/accounts/${encodeURIComponent(accountId)}/provision`, {}),
  // Invitations (§6.3, §6.5): pending ones, revoking one, and inviting people or chat guests.
  invites: async (id: string) => (await request<{ invites: WorkspaceInviteDTO[] }>('GET', `${ws(id)}/invites`)).invites,
  revokeInvite: (id: string, inviteId: string) => request<unknown>('DELETE', `${ws(id)}/invites/${encodeURIComponent(inviteId)}`),
  invite: async (id: string, emails: string[], kind: AccountKind) => (await request<{ results: InviteResultDTO[] }>('POST', `${ws(id)}/invites`, { emails, kind })).results,
  // Channels (the Automations form's choices) and agents (§3.4).
  channels: async (id: string) => (await request<{ channels: ChannelDTO[] }>('GET', `${ws(id)}/channels`)).channels,
  /** The organization's event log (platform.md §5.2), newest first from the head or below a seq: the Event log section. */
  events: (id: string, q: { before?: number; limit?: number; types?: string; channel?: string; actor?: 'person' | 'agent'; text?: string }) => {
    const params = new URLSearchParams({ workspace: id, before: String(q.before ?? 0), limit: String(q.limit ?? 50) });
    if (q.types) params.set('types', q.types);
    if (q.channel) params.set('channel', q.channel);
    if (q.actor) params.set('actor', q.actor);
    if (q.text) params.set('text', q.text);
    return request<{ events: PlatformEvent[]; next: number }>('GET', `/v1/events?${params.toString()}`);
  },
  removeAgent: (id: string, userId: string) => request<unknown>('DELETE', `${ws(id)}/agents/${encodeURIComponent(userId)}`),
  /** A personal agent's account removed, with its delegations (docs/specs/agents.md §2). */
  removePersonalAgent: (id: string, accountId: string) => request<{ account: AccountDTO }>('DELETE', `${ws(id)}/accounts/${encodeURIComponent(accountId)}`),
  agentInvite: (id: string) => request<AgentInviteDTO>('POST', `${ws(id)}/agent-invites`),
  // Hosted shared agents (docs/specs/agents.md §6): made here, with a definition kept by the agent's runtime.
  // A person's own private agents (docs/specs/agents.md §1.3): their assistant first, up to five in all.
  myAgents: (id: string) => request<{ agents: UsableAgentDTO[]; limit: number }>('GET', `${ws(id)}/agents/mine`),
  makePersonalAgent: (id: string, body: { name: string; instructions?: string }) => request<{ agent: UsableAgentDTO; definition: AgentDefinitionDTO }>('POST', `${ws(id)}/agents/personal`, body),
  removeMyAgent: (id: string, userId: string) => request<{ account: AccountDTO }>('DELETE', `${ws(id)}/agents/personal/${encodeURIComponent(userId)}`),
  // An agent's memory files (docs/specs/agents.md §6.1): what the caller may see of them, edit, and delete.
  agentMemory: (id: string, userId: string) => request<{ files: MemoryFileDTO[]; shared: boolean; mayEditTeam: boolean }>('GET', `${ws(id)}/agents/${encodeURIComponent(userId)}/memory`),
  saveAgentMemory: (id: string, userId: string, body: { path: string; body: string }) => request<{ ok: true }>('PUT', `${ws(id)}/agents/${encodeURIComponent(userId)}/memory`, body),
  forgetAgentMemory: (id: string, userId: string, path?: string) => request<{ removed: number }>('DELETE', `${ws(id)}/agents/${encodeURIComponent(userId)}/memory${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  makeHostedAgent: (id: string, body: { name: string; instructions?: string }) => request<{ agent: UsableAgentDTO; definition: AgentDefinitionDTO }>('POST', `${ws(id)}/agents/hosted`, body),
  agentDefinition: (id: string, userId: string) => request<{ definition: AgentDefinitionDTO; mayEdit: boolean }>('GET', `${ws(id)}/agents/${encodeURIComponent(userId)}/definition`),
  saveAgentDefinition: (id: string, userId: string, body: { name?: string; instructions?: string }) => request<{ definition: AgentDefinitionDTO; mayEdit: boolean }>('PUT', `${ws(id)}/agents/${encodeURIComponent(userId)}/definition`, body),
};
