// What Contacts reads from the rest of the FreeFlow suite for its bar: the user and organizations from the suite's API on
// the same origin (the session cookie), and the organization Chat selected, kept in this browser's localStorage under
// the key Chat's connection registry names (as packages/docs/client/src/suite.ts reads it).

export interface SuiteUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  statusEmoji: string;
  statusText: string;
}

/** One of the person's accounts (GET /v1/me/accounts): its organization and its provisioning state (platform.md §3.4). */
export interface SuiteAccount {
  id: string;
  organizationId: string;
  address: string;
  state: 'requested' | 'mailbox_ready' | 'calendars_ready' | 'active' | 'suspended' | 'removed';
}

export interface SuiteOrganization {
  id: string;
  name: string;
  avatarUrl: string | null;
  role?: 'owner' | 'admin' | 'member';
  unreadCount?: number;
}

async function suiteApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(err?.error?.message ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const suite = {
  me: () => suiteApi<SuiteUser>('GET', '/v1/me'),
  organizations: async () => (await suiteApi<{ workspaces: SuiteOrganization[] }>('GET', '/v1/me/workspaces')).workspaces,
  accounts: async () => (await suiteApi<{ accounts: SuiteAccount[] }>('GET', '/v1/me/accounts')).accounts,
  setStatus: (patch: { statusEmoji: string; statusText: string; statusSuppressAlerts: boolean }) => suiteApi<SuiteUser>('PATCH', '/v1/me', patch),
  logout: () => suiteApi<{ ok: true }>('POST', '/v1/auth/logout', {}),
};

const REGISTRY_KEY = 'flow.connections';
const LEGACY_KEY = 'flow.activeWorkspace';

function activeOrganizationKey(): string {
  try {
    const registry = JSON.parse(localStorage.getItem(REGISTRY_KEY) ?? 'null') as {
      connections?: { connectionId: string; origin: string }[];
      sessions?: { connectionId: string; storageKey: string }[];
    } | null;
    const connection = registry?.connections?.find((c) => {
      try {
        return new URL(c.origin).origin === window.location.origin;
      } catch {
        return false;
      }
    });
    const session = connection && registry?.sessions?.find((s) => s.connectionId === connection.connectionId);
    if (session?.storageKey) return session.storageKey === 'legacy' ? LEGACY_KEY : `flow.${session.storageKey}.activeWorkspace`;
  } catch {
    // No registry, or not one we can read: the plain key.
  }
  return LEGACY_KEY;
}

export function readActiveOrganization(): string | null {
  try {
    return localStorage.getItem(activeOrganizationKey());
  } catch {
    return null;
  }
}

export function writeActiveOrganization(id: string): void {
  try {
    localStorage.setItem(activeOrganizationKey(), id);
  } catch {
    // Not kept: this page still shows it.
  }
}
