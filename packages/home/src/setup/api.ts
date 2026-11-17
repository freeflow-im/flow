// The calls setup makes (docs/specs/onboarding.md): the platform's /v1 routes and the assistant's /api/agent ones, so
// Home depends on no other app.
import type { AccountKind, AgentDefinitionDTO, InviteResultDTO, SubscriptionDTO, UsableAgentDTO, WorkspaceDTO, WorkspaceInviteDTO, WorkspaceMemberDTO } from '@flow/shared';
import type { AgentAvatarPreset, AssistantSettings } from '@flow/shared/assistant';
import { HomeApiError } from '../api';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new HomeApiError(res.status, err?.error?.code ?? `http_${res.status}`, err?.error?.message ?? `${res.status} ${res.statusText}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const enc = encodeURIComponent;
const ws = (org: string) => `/v1/workspaces/${enc(org)}`;

export interface SetupState { pending: boolean; step: number }
export interface TeamAgent { id: string; displayName: string }

export const setupApi = {
  state: (org: string) => request<SetupState>('GET', `${ws(org)}/setup`),
  save: (org: string, patch: { step?: number; done?: true }) => request<SetupState>('PUT', `${ws(org)}/setup`, patch),

  createWorkspace: (name: string, slug: string) => request<WorkspaceDTO>('POST', '/v1/workspaces', { name, slug }),
  addDomain: (org: string, domain: string) => request<unknown>('POST', `${ws(org)}/domains`, { domain }),

  assistant: async (org: string) => (await request<{ definition: AgentDefinitionDTO }>('GET', `${ws(org)}/assistant/definition`)).definition,
  nameAssistant: async (org: string, name: string) => (await request<{ definition: AgentDefinitionDTO }>('PUT', `${ws(org)}/assistant/definition`, { name })).definition,
  setAvatar: (org: string, preset: AgentAvatarPreset) => request<{ avatarUrl: string | null }>('PUT', `${ws(org)}/assistant/avatar`, { preset }),

  teamAgent: async (org: string) => (await request<{ agent: TeamAgent | null }>('GET', `${ws(org)}/team-agent`)).agent,
  addTeamAgent: async (org: string) => (await request<{ agent: TeamAgent }>('POST', `${ws(org)}/team-agent`)).agent,

  members: async (org: string) => (await request<{ members: WorkspaceMemberDTO[] }>('GET', `${ws(org)}/members`)).members,
  invites: async (org: string) => (await request<{ invites: WorkspaceInviteDTO[] }>('GET', `${ws(org)}/invites`)).invites,
  invite: async (org: string, email: string, kind: AccountKind = 'native') => (await request<{ results: InviteResultDTO[] }>('POST', `${ws(org)}/invites`, { emails: [email], kind })).results,
  addAgent: (org: string, visibility: 'shared' | 'private', name: string, instructions: string) =>
    request<{ agent: UsableAgentDTO }>('POST', `${ws(org)}/agents/${visibility === 'shared' ? 'hosted' : 'personal'}`, { name, instructions }),
  mcpUrl: async () => (await request<{ mcpUrl?: string }>('GET', '/v1/me/agent-connections').catch(() => ({ mcpUrl: undefined }))).mcpUrl ?? `${window.location.origin}/mcp`,

  /** The agents the person may talk to (their assistant marked `self`), each with the account id an automation wakes. */
  usableAgents: async (org: string) => (await request<{ agents: UsableAgentDTO[] }>('GET', `/api/agent/agents?workspace=${enc(org)}`)).agents,
  subscriptions: async (org: string) => (await request<{ subscriptions: SubscriptionDTO[] }>('GET', `/v1/events/subscriptions?workspace=${enc(org)}`)).subscriptions,
  createSubscription: async (org: string, body: unknown) => (await request<{ subscription: SubscriptionDTO }>('POST', `/v1/events/subscriptions?workspace=${enc(org)}`, body)).subscription,
  removeSubscription: (org: string, id: string) => request<unknown>('DELETE', `/v1/events/subscriptions/${enc(id)}?workspace=${enc(org)}`),
  /** Whether the organization has a model its agents run on (Admin › Agents); without one the assistant cannot answer. */
  hasModel: async (org: string) => modelReady((await request<{ settings: AssistantSettings }>('GET', `${ws(org)}/assistant/model`).catch(() => null))?.settings ?? null),
};

/** Whether the model settings name a usable model: the server's own (`default`), or a provider with its key saved. */
export function modelReady(s: Pick<AssistantSettings, 'provider' | 'builtIn' | 'anthropicKey' | 'openaiKey' | 'openrouterKey'> | null): boolean | null {
  if (!s) return null;
  if (s.provider === 'anthropic') return !!s.anthropicKey;
  if (s.provider === 'openai') return !!s.openaiKey;
  if (s.provider === 'openrouter') return !!s.openrouterKey;
  return s.builtIn;
}
