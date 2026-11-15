// What Home reads from the rest of the FreeFlow suite: the user and organizations from the suite's API on the same
// origin (the session cookie), and the organization Chat selected, kept in this browser's localStorage under the key
// Chat's connection registry names (as Admin's and Contacts' suite.ts read it). Home shows that organization; the
// bar's switcher changes it for every app.
import type { UserDTO, WorkspaceDTO } from '@flow/shared';
import type { ProfilePatch } from '@flow/suite-bar/account-settings';

/** The signed-in person (`GET /v1/me`): the suite bar draws the name, picture and status; Settings edits the rest. */
export type SuiteUser = UserDTO;

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
  /** The Settings page's saves: the profile, a notification pref, privacy mode. */
  patchMe: (patch: ProfilePatch) => suiteApi<SuiteUser>('PATCH', '/v1/me', patch),
  uploadAvatar: async (file: File): Promise<SuiteUser> => {
    const form = new FormData();
    form.append('file', file, file.name);
    const res = await fetch('/v1/me/avatar', { method: 'POST', credentials: 'same-origin', body: form });
    const json = (await res.json().catch(() => ({}))) as SuiteUser & { error?: { message?: string } };
    if (!res.ok) throw new Error(json.error?.message ?? `${res.status} ${res.statusText}`);
    return json;
  },
  deleteAccount: async () => {
    const res = await fetch('/v1/me', { method: 'DELETE', credentials: 'same-origin' });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(err?.error?.message ?? `${res.status} ${res.statusText}`);
    }
  },
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
