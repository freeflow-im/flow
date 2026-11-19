// The installed apps' API on the edge Worker (packages/edge/src/routes/userApps.ts), same origin with the suite's session
// cookie. A 401 sends the browser to sign in.

/** An installed app as the API lists it (@flow/shared InstalledAppDTO, the fields this page reads). */
export interface InstalledApp {
  name: string;
  label: string;
  icon?: string;
  /** An image icon (user-apps.md §4), on the suite's origin. */
  iconUrl?: string;
  description?: string;
  serverOrigin: string | null;
  hasScreen: boolean;
  usable: boolean;
  hosted?: boolean;
  version?: number;
  /** Owners and admins: per scope, `members` or the account ids it is given to. */
  grants?: Record<string, string[]>;
}

/** One of the person's drafts (§9.6): its files (path → bytes) and what stands between it and a version. */
export interface AppDraft { name: string; label: string; files: Record<string, number>; problems: string[]; devHost: string; createdAt: string; updatedAt: string }

/** A tool call's answer, as the Worker gives it. */
export type ToolAnswer = { ok: true; result: unknown } | { ok: false; error: string };

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
  // Building (§9.6): the person's drafts, their files, trying, the preview and publishing.
  drafts: async (org: string) => (await request<{ drafts: AppDraft[] }>('GET', `${ws(org)}/apps/drafts`)).drafts,
  draft: async (org: string, name: string) => (await request<{ draft: AppDraft }>('GET', `${ws(org)}/apps/drafts/${encodeURIComponent(name)}`)).draft,
  createDraft: async (org: string, name: string, label: string, fromInstalled = false) => (await request<{ draft: AppDraft }>('POST', `${ws(org)}/apps/drafts`, { name, label, ...(fromInstalled ? { fromInstalled: true } : {}) })).draft,
  deleteDraft: (org: string, name: string) => request<{ ok: true }>('DELETE', `${ws(org)}/apps/drafts/${encodeURIComponent(name)}`),
  readFile: async (org: string, name: string, path: string) => (await request<{ text: string }>('GET', `${ws(org)}/apps/drafts/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`)).text,
  writeFile: async (org: string, name: string, path: string, text: string) => (await request<{ draft: AppDraft }>('PUT', `${ws(org)}/apps/drafts/${encodeURIComponent(name)}/file`, { path, text })).draft,
  deleteFile: async (org: string, name: string, path: string) => (await request<{ draft: AppDraft }>('DELETE', `${ws(org)}/apps/drafts/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`)).draft,
  tryTool: (org: string, name: string, tool: string, input: Record<string, unknown>) => request<ToolAnswer>('POST', `${ws(org)}/apps/drafts/${encodeURIComponent(name)}/try`, { tool, input }),
  preview: (org: string, name: string) => request<{ url: string }>('POST', `${ws(org)}/apps/drafts/${encodeURIComponent(name)}/preview`, {}),
  publish: (org: string, name: string) => request<{ name: string; version: number }>('POST', `${ws(org)}/apps/drafts/${encodeURIComponent(name)}/publish`, {}),
  // Installing from the builder (owners and admins, §9.6): a published version, with who gets it.
  installVersion: (org: string, name: string, version: number, grants: AppGrants) => request<{ app: string; version: number }>('POST', `${ws(org)}/apps`, { name, version, grants }),
  updateToVersion: (org: string, name: string, version: number, grants: AppGrants) => request<{ ok: true; version: number }>('PUT', `${ws(org)}/apps/${encodeURIComponent(name)}`, { version, grants }),
  accounts: async (org: string) => (await request<{ accounts: OrgAccount[] }>('GET', `${ws(org)}/accounts`)).accounts,
  uploads: async (org: string) => (await request<{ versions: { name: string; version: number; installed: boolean }[] }>('GET', `${ws(org)}/apps/versions`)).versions,
};

/** Who gets an installed app's scopes (§5.2): every member, and named people or shared agents. */
export interface AppGrants { members: boolean; accounts: string[] }

/** An account of the organization, as the install popup lists them. */
export interface OrgAccount { id: string; displayName: string; kind: string; state: string; agentMode?: 'personal' | 'shared' | null }

/** The draft a Build page address opens: `/apps/?build=<name>`, or null. */
export function buildingOf(search: string): string | null {
  const name = new URLSearchParams(search).get('build');
  return name && /^[a-z][a-z0-9]{1,19}$/.test(name) ? name : null;
}

/** The app a path names: `/apps/<name>`, or null for `/apps/` itself. */
export function appNameOf(pathname: string): string | null {
  const m = /^\/apps\/([a-z][a-z0-9]{1,19})\/?$/.exec(pathname);
  return m ? m[1]! : null;
}
