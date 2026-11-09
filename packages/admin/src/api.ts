// The suite's API on the edge Worker, same origin with the session cookie: the Org object's routes (the workspace, its
// members, invitations, emoji, join link) and the directory's (domains, accounts). A 401 sends the browser to sign in.
import type { FileDTO, JoinLinkDTO, OAuthIdentityDTO, PresignedUploadDTO, UpdateWorkspaceBody, WorkspaceDTO, WorkspaceEmojiDTO, WorkspaceMemberDTO } from '@flow/shared';

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

export const adminApi = {
  update: (id: string, patch: UpdateWorkspaceBody) => request<WorkspaceDTO>('PATCH', ws(id), patch),
  setIcon: (id: string, file: File) => uploadMultipart<WorkspaceDTO>(`${ws(id)}/avatar`, file),
  clearIcon: (id: string) => request<WorkspaceDTO>('DELETE', `${ws(id)}/avatar`),
  members: async (id: string) => (await request<{ members: WorkspaceMemberDTO[] }>('GET', `${ws(id)}/members`)).members,
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
};
