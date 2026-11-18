// The calls setup makes (docs/specs/onboarding.md): the platform's /v1 routes and the assistant's /api/agent ones, so
// Home depends on no other app.
import type { AccountDTO, AccountKind, AgentDefinitionDTO, DomainDTO, InviteResultDTO, SubscriptionDTO, UsableAgentDTO, WorkspaceDTO, WorkspaceInviteDTO, WorkspaceMemberDTO } from '@flow/shared';
import type { AgentAvatarPreset, AssistantSettings } from '@flow/shared/assistant';
import type { CalendarProvider, MailProviderPreset, NewCalendarAccount, NewMailAccount } from '@flow/suite-bar/link-accounts';
import { HomeApiError } from '../api';

/** A linked mail or calendar account, as its app lists it (only what setup shows). */
export interface LinkedAccount { id: string; email: string; status?: string; kind?: string }

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
  /** The workspace's domains with each record's DNS check (Admin › Domains' list), looked at again with `refresh`. */
  domains: async (org: string, refresh = false) => (await request<{ domains: DomainDTO[] }>('GET', `${ws(org)}/domains${refresh ? '?refresh=1' : ''}`)).domains,
  verifyDomain: (org: string, domain: string) => request<{ verified: boolean; found: string[] }>('POST', `${ws(org)}/domains/${enc(domain)}/verify`),
  turnOnMail: (org: string, domain: string) => request<unknown>('POST', `${ws(org)}/domains/${enc(domain)}/dkim`),
  makePrimary: (org: string, domain: string) => request<unknown>('PATCH', `${ws(org)}/domains/${enc(domain)}`, { primary: true }),
  removeDomain: (org: string, domain: string) => request<unknown>('DELETE', `${ws(org)}/domains/${enc(domain)}`),

  // Linking the mail and calendars a person already has (the "Your email and calendar" step), as Mail and Calendar do.
  mailAccounts: async (org: string) => (await request<{ accounts: LinkedAccount[] }>('GET', `/v1/mail/accounts?workspace=${enc(org)}`)).accounts,
  mailProvider: (org: string, email: string) => request<MailProviderPreset | null>('GET', `/v1/mail/providers?email=${enc(email)}&workspace=${enc(org)}`),
  addMailAccount: async (org: string, body: NewMailAccount) => (await request<{ account: LinkedAccount }>('POST', `/v1/mail/accounts?workspace=${enc(org)}`, body)).account,
  calendarAccounts: async (org: string) => (await request<{ accounts: LinkedAccount[] }>('GET', `/v1/calendar/accounts?workspace=${enc(org)}`)).accounts,
  calendarProvider: (org: string, email: string) => request<CalendarProvider>('GET', `/v1/calendar/providers?email=${enc(email)}&workspace=${enc(org)}`),
  addCalendarAccount: async (org: string, body: NewCalendarAccount) => (await request<{ account: LinkedAccount }>('POST', `/v1/calendar/accounts?workspace=${enc(org)}`, body)).account,
  /** Google's consent page for calendars, coming back to setup (it keeps the path; the step is saved). */
  googleCalendarStart: async (org: string, email?: string) =>
    (await request<{ url: string }>('GET', `/v1/calendar/google/start?return=${enc(`${window.location.origin}/home/setup`)}${email ? `&email=${enc(email)}` : ''}&workspace=${enc(org)}`)).url,
  /** The person's own account in the organization: its hosted address, or the linked mailbox they go by. */
  myAccount: async (org: string) => (await request<{ accounts: AccountDTO[] }>('GET', '/v1/me/accounts')).accounts.find((a) => a.organizationId === org) ?? null,
  /** Which linked mailbox coworkers see (platform.md §3.2), for a person with no hosted address. */
  setAddress: (org: string, address: string | null) => request<unknown>('PUT', `${ws(org)}/me/address`, { address }),
  /** Whether this server has Google sign-in for calendars (its client id). */
  googleAvailable: async () => !!(await request<{ google?: boolean }>('GET', '/v1/config').catch(() => ({ google: false }))).google,

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
