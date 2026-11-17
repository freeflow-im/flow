// The installed apps' API on the edge Worker (packages/edge/src/routes/userApps.ts), same origin with the suite's session
// cookie. A 401 sends the browser to sign in.

/** An installed app as the API lists it (@flow/shared InstalledAppDTO, the fields this page reads). */
export interface InstalledApp {
  name: string;
  label: string;
  icon?: string;
  description?: string;
  serverOrigin: string | null;
  hasScreen: boolean;
  usable: boolean;
}

export class AppsApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    window.location.assign(`/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    throw new AppsApiError('unauthorized', 'Your session has ended. Sign in again.', 401);
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new AppsApiError(err?.error?.code ?? 'server_error', err?.error?.message ?? `${res.status} ${res.statusText}`, res.status);
  }
  return (await res.json()) as T;
}

const ws = (id: string) => `/v1/workspaces/${encodeURIComponent(id)}`;

export const appsApi = {
  list: async (org: string) => (await request<{ apps: InstalledApp[] }>('GET', `${ws(org)}/apps`)).apps,
  /** The app's screen URL with a one-use door key (user-apps.md §6.2): minted again for every load. */
  screen: (org: string, name: string) => request<{ url: string; expiresAt: string }>('POST', `${ws(org)}/apps/${encodeURIComponent(name)}/screen`, {}),
};

/** The app a path names: `/apps/<name>`, or null for `/apps/` itself. */
export function appNameOf(pathname: string): string | null {
  const m = /^\/apps\/([a-z][a-z0-9]{1,19})\/?$/.exec(pathname);
  return m ? m[1]! : null;
}
