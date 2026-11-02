// What the Docs app reads from, and shares with, the rest of the FreeFlow suite when it is hosted there (`useAuth().suite`;
// ../../../../docs/specs/freeflow-suite.md): the user and organizations from the suite's API on the same origin (with
// the session cookie), the organization Chat has selected (in this browser's localStorage), and work a page must
// finish before the session ends.

/** The suite's user, as `GET /v1/me` answers (the fields the bar draws). */
export interface SuiteUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  statusEmoji: string;
  statusText: string;
}

/** An organization of the user, as `GET /v1/me/workspaces` lists it (Flow calls it a workspace). */
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
  setStatus: (patch: { statusEmoji: string; statusText: string; statusSuppressAlerts: boolean }) => suiteApi<SuiteUser>('PATCH', '/v1/me', patch),
};

// Chat keeps the selected organization per connection and identity, under a key its connection registry names
// (packages/web/src/lib/connections.ts: `scopedKey`, the registry at `flow.connections`). The connection for this
// origin is the one whose key is shared; a browser from before multiple servers keeps the plain `flow.*` keys.
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

/** The organization Chat last selected (null for none yet). */
export function readActiveOrganization(): string | null {
  try {
    return localStorage.getItem(activeOrganizationKey());
  } catch {
    return null;
  }
}

/** Select an organization for both apps: Chat opens on it next. */
export function writeActiveOrganization(id: string): void {
  try {
    localStorage.setItem(activeOrganizationKey(), id);
  } catch {
    // Not kept: this page still shows it.
  }
}

// Work a page must finish before the session ends (an editor's unsaved changes): the bar's Log out waits for it, as
// each page's own Sign out button did.
const beforeLeave = new Set<() => Promise<unknown>>();

/** Register work to finish before signing out; returns the unregister. */
export function onBeforeLeave(fn: () => Promise<unknown>): () => void {
  beforeLeave.add(fn);
  return () => {
    beforeLeave.delete(fn);
  };
}

export async function finishBeforeLeave(): Promise<void> {
  await Promise.allSettled([...beforeLeave].map((fn) => fn()));
}
