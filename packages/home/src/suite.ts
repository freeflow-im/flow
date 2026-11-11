// What Home reads from the rest of the FreeFlow suite: the user and organizations from the suite's API on the same
// origin (the session cookie), and the organization Chat selected, kept in this browser's localStorage under the key
// Chat's connection registry names (as Admin's and Contacts' suite.ts read it). Home shows that organization; the
// bar's switcher changes it for every app.
import type { WorkspaceDTO } from '@flow/shared';

export interface SuiteUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  statusEmoji: string;
  statusText: string;
}

/** An organization as `GET /v1/me/workspaces` lists it: the whole workspace row, with the caller's role and the policies. */
export type SuiteOrganization = WorkspaceDTO;

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
