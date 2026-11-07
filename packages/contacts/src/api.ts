// The contacts API on the edge Worker (/v1/contacts, packages/edge/src/routes/contacts.ts), same origin with the suite's
// session cookie, naming the organization selected in the suite bar (`?workspace=`). A 401 sends the browser to sign in.
import { readActiveOrganization } from './suite';
import type { Contact } from './lib/contacts';

export class ContactsApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

let workspace: string | null = null;
export const setContactsWorkspace = (id: string | null) => {
  workspace = id;
};
const inWorkspace = (path: string) => {
  const id = workspace ?? readActiveOrganization();
  return id ? `${path}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(id)}` : path;
};

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(inWorkspace(path), {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    if (!new URLSearchParams(window.location.search).has('next')) window.location.assign(`/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    throw new ContactsApiError('unauthorized', 'Your session has ended. Sign in again.', 401);
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ContactsApiError(err?.error?.code ?? 'server_error', err?.error?.message ?? `${res.status} ${res.statusText}`, res.status);
  }
  return (await res.json()) as T;
}

/** What an own contact is made or changed with. */
export interface ContactFields { name: string; emails: string[]; phone: string; orgName: string; notes: string }

export const contactsApi = {
  list: async () => (await request<{ contacts: Contact[] }>('GET', '/v1/contacts')).contacts,
  add: async (f: ContactFields) => (await request<{ contact: Contact }>('POST', '/v1/contacts', f)).contact,
  update: async (id: string, f: ContactFields) => (await request<{ contact: Contact }>('PATCH', `/v1/contacts/${encodeURIComponent(id)}`, f)).contact,
  remove: (id: string) => request<{ ok: true }>('DELETE', `/v1/contacts/${encodeURIComponent(id)}`),
  shared: async () => (await request<{ org: boolean }>('GET', '/v1/contacts/share')).org,
  share: async (org: boolean) => (await request<{ org: boolean }>('PUT', '/v1/contacts/share', { org })).org,
  /** The DM channel with a member (Chat's upsert), for the chat-message intent. */
  dm: async (organizationId: string, userId: string) => (await request<{ id: string }>('POST', `/v1/workspaces/${encodeURIComponent(organizationId)}/dms`, { userIds: [userId] })).id,
};
