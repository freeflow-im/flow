import type { AgentEvent, AgentJob, AgentTurnRequest, AssistantSettings, AssistantSettingsUpdate, ChatItem } from '../../shared/agent/protocol.ts';
import type { ConnectionInfo, ConnectorInfo, FetchResult } from '../../shared/connectors.ts';
import type { Deck } from '../../shared/deck.ts';
import type { LinkedTable, SheetTableRef } from '../../shared/sheetTable.ts';
import type { LinkedChart, SheetChartList } from '../../shared/chart.ts';
import type { Doc } from '../../shared/doc.ts';
import type { MarkdownDoc } from '../../shared/markdown.ts';
import type { FilePreview } from '../../shared/preview.ts';
import { CELL_IMAGE_TOO_LARGE, type ConnectedAgent, type DeletedFile, type NewFilesSettings, type NewFilesUpdate, type SheetMeta, type StoredFile, type Workbook } from '../../shared/types.ts';
import type { ZipEntry, ZipOfficeView } from '../../shared/zip.ts';
import { activeOrganizationId } from './suite.ts';
import { readAgentEvents } from './agent/stream.ts';

/** What can have a public link: a presentation, or a stored file (a video). */
export type SharedKind = 'deck' | 'file';

/** What a grant can name (server/access.ts): a document of any kind, a stored file, or a folder (by its object id). */
export type GrantKind = 'sheet' | 'file' | 'folder';
export type GrantRole = 'viewer' | 'editor' | 'manager' | 'owner';
/** One grant on a file or folder (platform.md §4.3): `account:<id>`, `channel:<id>`, `org` or `link:<token>`. */
export interface GrantInfo {
  principal: string;
  role: GrantRole;
  grantedBy: string;
  grantedAt: string;
  expiresAt?: string;
}
/** A file's or folder's own grants, the caller's role on it and its link's address; `id` when a change gave it a new one (a folder moved root). */
export interface Sharing {
  grants: GrantInfo[];
  role: GrantRole;
  link: string | null;
  id?: string;
}

/** A file previewed read-only for an hour (server/previews.ts): Mail's attachments. */
export interface PreviewInfo {
  id: string;
  kind: 'doc' | 'deck' | 'sheet' | 'markdown' | 'pdf' | 'file';
  filename: string;
  type: string;
  size: number;
  expiresAt: number;
  saved?: { kind: string; id: string; title: string; path: string; url: string };
}
export type PreviewView =
  | { kind: 'doc'; doc: Doc }
  | { kind: 'deck'; deck: Deck }
  | { kind: 'sheet'; workbook: Workbook }
  | { kind: 'markdown'; text: string }
  | { kind: 'pdf'; url: string }
  | { kind: 'file' };

/** What a public link shows. */
export type PublicView = { kind: 'deck'; title: string; deck: Deck } | { kind: 'video'; title: string; url: string };

export interface User {
  id: string;
  email: string;
}

export class ApiError extends Error {
  readonly status: number;
  /** Machine-readable reason, when the server gives one (e.g. 'unverified'). */
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, url: string, body?: unknown, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const { error, code } = data as { error?: string; code?: string };
    throw new ApiError(res.status, error ?? `Request failed (${res.status})`, code);
  }
  return data as T;
}

async function uploadExcel<T>(url: string, file: File): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    // The server detects .xlsx vs .xls from the file contents.
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = res.status === 413 ? 'This file is too large to import (20 MB maximum).' : (data as { error?: string }).error;
    throw new ApiError(res.status, msg ?? `Import failed (${res.status})`);
  }
  return data as T;
}

/** Store a cell image on the server; resolves to its URL. */
async function uploadImage(file: Blob): Promise<string> {
  // A picture is the organization's it was uploaded in (its members see it in the file it is put in).
  const res = await fetch(`/api/images${inFolder(undefined, true)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = res.status === 413 ? `${CELL_IMAGE_TOO_LARGE}.` : (data as { error?: string }).error;
    throw new ApiError(res.status, msg ?? `Image upload failed (${res.status})`);
  }
  return (data as { url: string }).url;
}

/** Store a file (generated PDF, upload) on the server. */
async function uploadFile(name: string, file: Blob, folder?: Place): Promise<StoredFile> {
  const res = await fetch(`/api/files${inFolder(folder, true)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(name) },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, res.status === 413 ? 'This file is too large to upload.' : ((data as { error?: string }).error ?? `File upload failed (${res.status})`));
  return (data as { file: StoredFile }).file;
}

/** A folder of the library (shared/folders.ts): its name and its path from the top. */
export interface FolderInfo {
  name: string;
  path: string;
  /** In the FreeFlow suite: the folder as an object grants name (server/access.ts). */
  id?: string;
}

/** A folder on the desktop app's machine its folder menu offers: its name and absolute path. */
export interface LocalPlace {
  name: string;
  path: string;
}

/** A signature the user keeps for signing PDFs (server/signatures.ts). */
export interface SavedSignature {
  id: string;
  /** A PNG picture as a data: address. */
  image: string;
  createdAt: string;
}

/**
 * Where in the library (docs/specs/freeflow-suite.md §2.4): a folder of the user's files (its path, '' the top), or a
 * folder of a root: with `shared`, the organization's shared files (Organization files). The organization is the one
 * selected in the suite bar unless `workspace` names another (a file's own); outside the suite there is none.
 */
export type Place = string | { folder: string; shared?: boolean; workspace?: string };

/** The fields of a request that name a place (folder, workspace, shared), for a query or a JSON body. */
export function placeFields(place: Place | undefined): { folder?: string; workspace?: string; shared?: '1' } {
  const folder = typeof place === 'string' ? place : (place?.folder ?? '');
  const workspace = (typeof place === 'object' ? place.workspace : undefined) ?? activeOrganizationId() ?? undefined;
  const shared = typeof place === 'object' && place.shared && workspace;
  return { ...(folder ? { folder } : {}), ...(workspace ? { workspace } : {}), ...(shared ? { shared: '1' as const } : {}) };
}

/** Where a file made beside this one goes: its folder, in its root. */
export const placeOf = (meta: { folder?: string; workspaceId?: string; shared?: true }): Place => (meta.workspaceId ? { folder: meta.folder ?? '', workspace: meta.workspaceId, shared: !!meta.shared } : (meta.folder ?? ''));

/** `&folder=...&workspace=...` (or `?...`) for a request that names a place; nothing for the top of the user's files outside the suite. */
const inFolder = (place: Place | undefined, first = false) => {
  const q = new URLSearchParams(placeFields(place)).toString();
  return q ? `${first ? '?' : '&'}${q}` : '';
};

/** A grants route of a file or folder, in the organization the bar selected. */
const grantUrl = (kind: GrantKind, id: string, rest = '') => `/api/grants/${kind}/${encodeURIComponent(id)}${rest}${inFolder(undefined, true)}`;

/** A file of Recents. */
/** The window event after a file or folder was made a favorite or not (api.setFavorite). */
export const FAVORITES_CHANGED = 'favorites-changed';

export interface RecentFile {
  /** On the web: the file's id. */
  id?: string;
  /** In the desktop app: its absolute path (it has no id until its folder is the open one). */
  path?: string;
  name: string;
  /** In the desktop app: the folder it is in, with the home directory written "~". */
  where?: string;
  /** On the web: the library folder it is in ('' at the top). */
  folder?: string;
  /** In the FreeFlow suite: its organization, and whether it is one of the organization's shared files. */
  workspaceId?: string;
  shared?: true;
  format?: SheetMeta['format'];
  text?: boolean;
  lastUsed: string;
  size?: number;
  kind: SheetMeta['kind'] | 'file';
  /** Opened in this app: listed ahead of what the system knows was opened. */
  app?: boolean;
}

/** A web file copied into the folder, or a folder's file copied to the web (desktop app; server/webCopy.ts). */
export interface CopiedFile {
  kind: 'doc' | 'deck' | 'sheet' | 'markdown' | 'file';
  id: string;
  title: string;
  warnings: string[];
}
export type DownloadFormat = 'office' | 'native' | 'pdf' | 'csv' | 'as-is';

export const api = {
  // The person's account on the web, from the desktop app (through the Web tab's session).
  webStatus: () => request<{ signedIn: boolean; email?: string }>('GET', '/api/web/status'),
  webFolders: (path: string) => request<{ folders: FolderInfo[] }>('GET', `/api/web/folders?path=${encodeURIComponent(path)}`),
  uploadToWeb: (id: string, webFolder: string) => request<CopiedFile>('POST', '/api/web/upload', { id, webFolder }),
  webPreview: (kind: string, id: string) => request<{ formats: DownloadFormat[]; officeLosses: string[] }>('GET', `/api/web/preview?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`),
  downloadFromWeb: (file: { kind: string; id: string; title?: string }, folder: string, format: DownloadFormat) => request<CopiedFile>('POST', '/api/web/download', { ...file, folder, format }),
  /** What is in a folder ('' is the top): its folders, documents of every kind and stored files. */
  library: (folder: Place = '') => request<{ folder: string; folders: FolderInfo[]; docs: SheetMeta[]; files: StoredFile[] }>('GET', `/api/library${inFolder(folder, true)}`),
  /** A small picture of a document, for the thumbnail view. */
  preview: (id: string) => request<{ preview: FilePreview }>('GET', `/api/library/preview/${encodeURIComponent(id)}`),
  /** Folders, documents and stored files whose name contains the text, in every folder. */
  searchLibrary: (q: string, root: Place = '') => request<{ folders: FolderInfo[]; docs: SheetMeta[]; files: StoredFile[]; truncated: boolean }>('GET', `/api/library/search?q=${encodeURIComponent(q)}${inFolder(typeof root === 'string' ? '' : { ...root, folder: '' })}`),
  /** The desktop app: files by name anywhere in the home folder outside the open one, by their paths. */
  searchHome: (q: string) => request<{ files: { path: string; name: string; where: string; kind: RecentFile['kind'] }[]; truncated: boolean }>('GET', `/api/local/search?q=${encodeURIComponent(q)}`),
  createFolder: (parent: Place, name: string) => request<{ folder: FolderInfo }>('POST', '/api/folders', { name, ...placeFields(parent) }),
  /** Delete an empty folder. */
  deleteFolder: (path: Place) => request<{ ok: true }>('DELETE', `/api/folders${inFolder(path, true)}`),
  /** Move a document (any kind) or a stored file ('file') into a folder (of the same root). */
  moveToFolder: (kind: SheetMeta['kind'] | 'file', id: string, folder: Place) => request<{ ok: true }>('POST', '/api/library/move', { kind, id, ...placeFields(folder), folder: typeof folder === 'string' ? folder : folder.folder }),
  /**
   * Put a file in another root (FreeFlow suite): `shared` true shares it with the organization (Organization files),
   * false makes it private (My files there); `workspace` is the organization (default: the one in the bar).
   */
  setFileScope: (id: string, target: { shared: boolean; workspace?: string }) =>
    request<{ file: SheetMeta | StoredFile }>('POST', `/api/files/${encodeURIComponent(id)}/scope`, { workspace: target.workspace ?? activeOrganizationId() ?? undefined, shared: target.shared }),
  /** Put a folder and everything in it in another root, at the top there; `from` is the root it is in now. */
  setFolderScope: (path: string, from: Place, target: { shared: boolean; workspace?: string }) => {
    const f = placeFields(typeof from === 'string' ? '' : { ...from, folder: '' });
    return request<{ folder: FolderInfo; moved: number }>('POST', '/api/folders/scope', { path, from: { workspace: f.workspace, shared: f.shared }, workspace: target.workspace ?? activeOrganizationId() ?? undefined, shared: target.shared });
  },
  uploadImage,
  uploadFile,
  /** Rename a stored file; it keeps its extension. */
  renameFile: (id: string, name: string) => request<{ file: StoredFile }>('PATCH', `/api/files/${encodeURIComponent(id)}`, { name }),
  listFiles: (root: Place = '') => request<{ files: StoredFile[] }>('GET', `/api/files${inFolder(typeof root === 'string' ? '' : { ...root, folder: '' }, true)}`),
  /** Replace a stored text file's contents. */
  updateFile: async (id: string, text: string): Promise<StoredFile> => {
    const res = await fetch(`/api/files/${encodeURIComponent(id)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: new Blob([text]) });
    const data = (await res.json().catch(() => ({}))) as { file?: StoredFile; error?: string };
    if (!res.ok || !data.file) throw new ApiError(res.status, res.status === 413 ? 'This file is too large to save.' : (data.error ?? `Saving the file failed (${res.status})`));
    return data.file;
  },
  /** Save an edited picture over a stored one (same type); the version before is kept for one revert. */
  updateImageFile: async (id: string, image: Blob): Promise<StoredFile> => {
    const res = await fetch(`/api/files/${encodeURIComponent(id)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': image.type }, body: image });
    const data = (await res.json().catch(() => ({}))) as { file?: StoredFile; error?: string };
    if (!res.ok || !data.file) throw new ApiError(res.status, res.status === 413 ? 'This picture is too large to save.' : (data.error ?? `Saving the picture failed (${res.status})`));
    return data.file;
  },
  /** Save a signed PDF over a stored one; the version before is kept for one revert. */
  updatePdfFile: async (id: string, pdf: Blob): Promise<StoredFile> => {
    const res = await fetch(`/api/files/${encodeURIComponent(id)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/pdf' }, body: pdf });
    const data = (await res.json().catch(() => ({}))) as { file?: StoredFile; error?: string };
    if (!res.ok || !data.file) throw new ApiError(res.status, res.status === 413 ? 'This PDF is too large to save.' : (data.error ?? `Saving the PDF failed (${res.status})`));
    return data.file;
  },
  /** The user's saved signatures (PNG data: addresses), for signing PDFs. */
  listSignatures: () => request<{ signatures: SavedSignature[] }>('GET', '/api/settings/signatures'),
  addSignature: (image: string) => request<{ signature: SavedSignature }>('POST', '/api/settings/signatures', { image }),
  deleteSignature: (id: string) => request<{ ok: true }>('DELETE', `/api/settings/signatures/${encodeURIComponent(id)}`),
  /** Make an edited copy of a stored picture with the image model; resolves with the new file. */
  editImage: (id: string, prompt: string) => request<{ file: StoredFile }>('POST', `/api/files/${encodeURIComponent(id)}/edit-image`, { prompt }),
  revertFile: (id: string) => request<{ file: StoredFile }>('POST', `/api/files/${encodeURIComponent(id)}/revert`),
  /** A new Markdown file of a PDF's text, beside it. */
  pdfToMarkdown: (id: string) => request<{ doc: SheetMeta; pages: number; ocrPages: number[]; warnings: string[] }>('POST', `/api/files/${encodeURIComponent(id)}/markdown`),
  getFile: (id: string) => request<{ file: StoredFile }>('GET', `/api/files/${encodeURIComponent(id)}/meta`),
  /** What a stored zip file holds (shared/zip.ts). */
  zipEntries: (id: string) => request<{ entries: ZipEntry[] }>('GET', `/api/files/${encodeURIComponent(id)}/zip`),
  /** A Word, Excel or PowerPoint file in a zip, converted to be shown read-only. */
  zipOfficeView: (id: string, path: string) => request<{ view: ZipOfficeView }>('GET', `/api/files/${encodeURIComponent(id)}/zip/view?path=${encodeURIComponent(path)}`),
  deleteFile: (id: string) => request<{ ok: true }>('DELETE', `/api/files/${encodeURIComponent(id)}`),

  /** Who a file or folder is shared with (server/access.ts), and changing it. */
  grants: (kind: GrantKind, id: string) => request<Sharing>('GET', grantUrl(kind, id)),
  setGrant: (kind: GrantKind, id: string, principal: string, role: GrantRole) => request<Sharing>('PUT', grantUrl(kind, id), { principal, role }),
  removeGrant: (kind: GrantKind, id: string, principal: string) => request<Sharing>('DELETE', grantUrl(kind, id, `/${encodeURIComponent(principal)}`)),
  makeLink: (kind: GrantKind, id: string) => request<{ url: string }>('POST', grantUrl(kind, id, '/link')),
  /** Shared with me: what others shared with the user in the organization the bar selected; with `inside`, a shared folder's contents. */
  sharedWithMe: (inside?: string) =>
    request<{ folder: string; folders: FolderInfo[]; docs: SheetMeta[]; files: StoredFile[] }>('GET', `/api/library?scope=shared${inside ? `&in=${encodeURIComponent(inside)}` : ''}${inFolder(undefined)}`),
  sharing: (kind: SharedKind, id: string) => request<{ url: string | null }>('GET', `/api/sharing/${kind}/${encodeURIComponent(id)}`),
  startSharing: (kind: SharedKind, id: string) => request<{ url: string | null }>('PUT', `/api/sharing/${kind}/${encodeURIComponent(id)}`),
  stopSharing: (kind: SharedKind, id: string) => request<{ url: string | null }>('DELETE', `/api/sharing/${kind}/${encodeURIComponent(id)}`),
  publicView: (token: string) => request<PublicView>('GET', `/api/public/${encodeURIComponent(token)}`),
  /** A preview, in the organization it was made in (the Mail overlay names it in the page's address). */
  openPreview: (id: string, workspace: string | null) =>
    request<{ preview: PreviewInfo; view: PreviewView }>('GET', `/api/previews/${encodeURIComponent(id)}${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`),

  /** `suite`: hosted in the FreeFlow suite, whose sign-in (at /) is the only one; `local`: the desktop app. */
  me: () => request<{ user: User | null; googleLogin: boolean; local?: { dir: string }; suite?: { basePath: string } }>('GET', '/api/auth/me'),
  /** Recents: the files last opened in the app (server/recents.ts). */
  /**
   * The favorites: files as Recents lists them, folders with where they are (in the desktop app by their absolute
   * paths), and `keys`, those in the library (the open folder) as the list names them: `doc:<id>`, `folder:<path>`.
   */
  favorites: (root: Place = '') => request<{ files: RecentFile[]; folders: { name: string; path: string; where: string; workspaceId?: string; shared?: true }[]; keys: string[] }>('GET', `/api/favorites${inFolder(typeof root === 'string' ? '' : { ...root, folder: '' }, true)}`),
  /** Whether a file is a favorite (an editor's star). */
  isFavorite: (kind: RecentFile['kind'], id: string) => request<{ on: boolean }>('GET', `/api/favorites/one?kind=${kind}&id=${encodeURIComponent(id)}`),
  /** Make a file (kind and id), a folder (its path in the list) or, in the desktop app, anything by its absolute path a favorite, or not. */
  /** Then FAVORITES_CHANGED is sent on the window, for the lists of them on the page (the File menu's). */
  setFavorite: (what: { kind: RecentFile['kind']; id: string } | { folder: string; root?: Place } | { path: string }, on: boolean) =>
    request<{ ok: true }>('POST', '/api/favorites', 'folder' in what ? { ...placeFields(what.root ?? ''), folder: what.folder, on } : { ...what, on }).then((r) => (window.dispatchEvent(new Event(FAVORITES_CHANGED)), r)),
  recents: () =>
    request<{
      files: RecentFile[];
      /** Whether there is also recentsSystem to ask for (the desktop app). */
      system: boolean;
      /** recentsSystem's last answer, to show until it answers again. */
      cached?: { files: RecentFile[]; blocked: string[] };
    }>('GET', `/api/recents${inFolder({ folder: '' }, true)}`),
  /** The desktop app: the files last opened on this computer in any app, from Spotlight (slow). */
  recentsSystem: () => request<{ files: RecentFile[]; /** Folders macOS does not let the app read. */ blocked: string[] }>('GET', '/api/recents/system'),
  /** Tell the server a page shows this file, for Recents. */
  opened: (kind: RecentFile['kind'], id: string) => request<{ ok: true }>('POST', '/api/recents', { kind, id }),
  /** Open one of them: answers with its path in the open folder, or that the app is switching to the file's folder. */
  /** The desktop app: the file the window shows, for the MCP tools to act on (server/localMcp.ts); null for none. */
  localShowing: (file: { kind: 'doc' | 'deck' | 'sheet' | 'markdown' | 'file'; id: string } | null, window?: string) => request<{ ok: true }>('POST', '/api/local/showing', { ...(file ?? {}), ...(window ? { window } : {}) }),
  /** The desktop app: answer an agent's tool call that ran in this window (server/windowTools.ts). */
  answerToolCall: (id: string, answer: { content: string; isError?: boolean; images?: { mediaType: string; data: string }[] } | { unavailable: true }) => request<{ ok: true }>('POST', `/api/local/tool-calls/${encodeURIComponent(id)}`, answer),
  openLocal: (path: string) => request<{ file?: string; switching?: true }>('POST', '/api/local/open', { path }),
  /** The desktop app: open a file or folder by its path (absolute, ~/..., or in the open folder). */
  /** With `tab`, one outside the open folder opens in a new tab (`opened`); one inside is named for the page to open. */
  openLocalPath: (path: string, tab = false) => request<{ file?: string; folder?: string; switching?: true; opened?: true }>('POST', '/api/local/open-path', tab ? { path, tab } : { path }),
  scratchPads: () => request<{ pads: { name: string; modified: string }[] }>('GET', '/api/local/scratch-pads'),
  /** A scratch pad by its name, or a new one. */
  /** `folder`, the one of the open folder being shown: where its breadcrumbs lead back to when the window moves to show it. */
  openScratchPad: (name: string | undefined, folder: string) => request<{ file?: string; switching?: true }>('POST', '/api/local/scratch-pad', name ? { name, folder } : { folder }),
  /** The desktop app: the folders its folder menu offers (the usual ones in the home folder). */
  localPlaces: () => request<{ places: LocalPlace[] }>('GET', '/api/local/places'),
  /** The desktop app: show its Open Folder dialog. */
  /** Move the window back to the folder a file was opened from (listing.ts' returnTo). */
  returnToFolder: (dir: string, folder: string) => request<{ switching: true }>('POST', '/api/local/return', { dir, at: folder }),
  chooseLocalFolder: (tab = false) => request<{ ok: true }>('POST', '/api/local/choose-folder', tab ? { tab } : undefined),
  /** The desktop app: show a file of the folder, or a folder of it, in Finder (File Explorer on Windows). */
  revealLocal: (target: { kind: SheetMeta['kind'] | 'file'; id: string } | { folder: string }) => request<{ ok: true }>('POST', '/api/local/reveal', target),
  /** The desktop app: drag a file of the folder out of the window as the file itself, to another app. */
  dragOutLocal: (kind: SheetMeta['kind'] | 'file', id: string) => request<{ ok: true }>('POST', '/api/local/drag', { kind, id }),
  /** The desktop app: show how to connect an agent to its MCP server (and who is connected). */
  /** The library's file at a path inside the open folder. */
  resolveLocal: (file: string) => request<{ kind: SheetMeta['kind'] | 'file'; id: string }>('GET', `/api/local/resolve?file=${encodeURIComponent(file)}`),
  login: (email: string, password: string) => request<{ user: User }>('POST', '/api/auth/login', { email, password }),
  register: (email: string, password: string) => request<{ pending: true; email: string }>('POST', '/api/auth/register', { email, password }),
  verifyEmail: (token: string) => request<{ user: User }>('POST', '/api/auth/verify', { token }),
  resendVerification: (email: string) => request<{ ok: true }>('POST', '/api/auth/verify/resend', { email }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout', {}),
  forgotPassword: (email: string) => request<{ ok: true }>('POST', '/api/auth/forgot', { email }),
  checkResetToken: (token: string) => request<{ email: string }>('GET', `/api/auth/reset?token=${encodeURIComponent(token)}`),
  resetPassword: (token: string, password: string) => request<{ user: User }>('POST', '/api/auth/reset', { token, password }),

  listSheets: () => request<{ sheets: SheetMeta[] }>('GET', '/api/sheets'),
  /** A spreadsheet's charts, and one of them as a slide shows it (shared/chart.ts). */
  sheetCharts: (id: string) => request<SheetChartList>('GET', `/api/sheets/${encodeURIComponent(id)}/charts`),
  sheetChart: (id: string, chartId: string) => request<LinkedChart>('GET', `/api/sheets/${encodeURIComponent(id)}/chart?chart=${encodeURIComponent(chartId)}`),
  /** A range of a spreadsheet as the cells of a slide table (its used part when no range is given). */
  sheetTable: (id: string, ref: SheetTableRef) => {
    const q = new URLSearchParams(Object.entries(ref).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
    return request<LinkedTable>('GET', `/api/sheets/${encodeURIComponent(id)}/table${q.size ? `?${q}` : ''}`);
  },
  createSheet: (title: string, folder?: Place) => request<{ sheet: SheetMeta }>('POST', '/api/sheets', { title, ...placeFields(folder) }),
  /** Create a CSV file from the text of an uploaded .csv file; it opens in the spreadsheet editor. */
  importCsv: (title: string, csv: string, folder?: Place) => request<{ sheet: SheetMeta }>('POST', '/api/sheets', { title, csv, ...placeFields(folder) }),
  /** Turn a CSV file into a native spreadsheet. */
  convertSheet: (id: string) => request<{ sheet: SheetMeta }>('POST', `/api/sheets/${encodeURIComponent(id)}/convert`, {}),
  /** `notKept`: what an Excel file made elsewhere holds that saving it would remove (desktop app). */
  getSheet: (id: string) => request<{ sheet: SheetMeta; workbook: Workbook; notKept?: string[] }>('GET', `/api/sheets/${encodeURIComponent(id)}`),
  /** rev is the updatedAt the editor loaded; the server refuses (409) when the spreadsheet changed since. */
  saveSheet: (id: string, workbook: Workbook, rev?: string, keepalive = false) =>
    request<{ sheet: SheetMeta }>('PUT', `/api/sheets/${encodeURIComponent(id)}`, { workbook, rev }, keepalive ? { keepalive: true } : undefined),
  /** Import an Excel file (.xlsx or .xls) as a new spreadsheet. */
  importXlsx: (file: File, title: string, folder?: Place) =>
    uploadExcel<{ sheet: SheetMeta; warnings: string[] }>(`/api/sheets/import?title=${encodeURIComponent(title)}${inFolder(folder)}`, file),
  /** Convert an Excel file (.xlsx or .xls) to workbook tabs without creating a spreadsheet. */
  convertXlsx: (file: File) => uploadExcel<{ workbook: Workbook; warnings: string[] }>('/api/import/xlsx', file),
  branchSheet: (id: string, title?: string) => request<{ sheet: SheetMeta }>('POST', `/api/sheets/${encodeURIComponent(id)}/branch`, { title }),
  compareSheet: (id: string) =>
    request<{ meta: SheetMeta; base: Workbook; original: Workbook | null; parent: SheetMeta | null }>('GET', `/api/sheets/${encodeURIComponent(id)}/compare`),
  renameSheet: (id: string, title: string) => request<{ sheet: SheetMeta }>('PATCH', `/api/sheets/${encodeURIComponent(id)}`, { title }),
  deleteSheet: (id: string) => request<{ ok: true }>('DELETE', `/api/sheets/${encodeURIComponent(id)}`),

  listDecks: () => request<{ decks: SheetMeta[] }>('GET', '/api/decks'),
  /** The user's copy of the Getting started guide; the first call makes it. */
  gettingStarted: () => request<{ deck: SheetMeta }>('POST', '/api/getting-started'),
  createDeck: (title: string, deck?: Deck, folder?: Place) => request<{ deck: SheetMeta }>('POST', '/api/decks', { title, deck, ...placeFields(folder) }),
  /** `notKept`: what a PowerPoint file made elsewhere holds that saving it would remove (desktop app). */
  getDeck: (id: string) => request<{ meta: SheetMeta; deck: Deck; notKept?: string[] }>('GET', `/api/decks/${encodeURIComponent(id)}`),
  /** Keep a presentation stored as a PowerPoint file in the app's own format (desktop app). */
  convertDeck: (id: string) => request<{ meta: SheetMeta }>('POST', `/api/decks/${encodeURIComponent(id)}/convert`, {}),
  /** rev is the updatedAt the editor loaded; the server refuses (409) when the presentation changed since. */
  saveDeck: (id: string, deck: Deck, rev?: string, keepalive = false) =>
    request<{ meta: SheetMeta }>('PUT', `/api/decks/${encodeURIComponent(id)}`, { deck, rev }, keepalive ? { keepalive: true } : undefined),
  /** Import a PowerPoint file (.pptx) as a new presentation. */
  importPptx: (file: File, title: string, folder?: Place) => uploadExcel<{ deck: SheetMeta; warnings: string[] }>(`/api/decks/import?title=${encodeURIComponent(title)}${inFolder(folder)}`, file),
  /** Convert a PowerPoint file (.pptx) to slides without creating a presentation. */
  convertPptx: (file: File) => uploadExcel<{ deck: Deck; warnings: string[] }>('/api/import/pptx', file),
  renameDeck: (id: string, title: string) => request<{ meta: SheetMeta }>('PATCH', `/api/decks/${encodeURIComponent(id)}`, { title }),
  deleteDeck: (id: string) => request<{ ok: true }>('DELETE', `/api/decks/${encodeURIComponent(id)}`),

  listDocs: () => request<{ docs: SheetMeta[] }>('GET', '/api/docs'),
  createDoc: (title: string, doc?: Doc, folder?: Place) => request<{ doc: SheetMeta }>('POST', '/api/docs', { title, doc, ...placeFields(folder) }),
  /** `notKept`: what a Word file made elsewhere holds that saving it would remove (desktop app). */
  getDoc: (id: string) => request<{ meta: SheetMeta; doc: Doc; notKept?: string[] }>('GET', `/api/docs/${encodeURIComponent(id)}`),
  /** Keep a document stored as a Word file in the app's own format (desktop app). */
  convertDoc: (id: string) => request<{ meta: SheetMeta }>('POST', `/api/docs/${encodeURIComponent(id)}/convert`, {}),
  /** rev is the updatedAt the editor loaded; the server refuses (409) when the document changed since. */
  saveDoc: (id: string, doc: Doc, rev?: string, keepalive = false) =>
    request<{ meta: SheetMeta }>('PUT', `/api/docs/${encodeURIComponent(id)}`, { doc, rev }, keepalive ? { keepalive: true } : undefined),
  /** Import a Word file (.docx) as a new document. */
  importPdf: (file: File, folder?: Place) => uploadExcel<{ file: StoredFile }>(`/api/import/pdf?filename=${encodeURIComponent(file.name)}${inFolder(folder)}`, file),
  importDocx: (file: File, title: string, folder?: Place) => uploadExcel<{ doc: SheetMeta; warnings: string[] }>(`/api/docs/import?title=${encodeURIComponent(title)}${inFolder(folder)}`, file),
  /** Convert a Word file (.docx) to document blocks without creating a document. */
  convertDocx: (file: File) => uploadExcel<{ doc: Doc; warnings: string[] }>('/api/import/docx', file),
  renameDoc: (id: string, title: string) => request<{ meta: SheetMeta }>('PATCH', `/api/docs/${encodeURIComponent(id)}`, { title }),
  deleteDoc: (id: string) => request<{ ok: true }>('DELETE', `/api/docs/${encodeURIComponent(id)}`),

  listMarkdown: () => request<{ docs: SheetMeta[] }>('GET', '/api/markdown'),
  /** Create a Markdown document, empty or from the text of an uploaded .md file. */
  createMarkdown: (title: string, text = '', folder?: Place) => request<{ doc: SheetMeta }>('POST', '/api/markdown', { title, text, ...placeFields(folder) }),
  getMarkdown: (id: string) => request<{ meta: SheetMeta; doc: MarkdownDoc }>('GET', `/api/markdown/${encodeURIComponent(id)}`),
  /** `rev` is the revision loaded; the server answers 409 when the document was saved elsewhere since. */
  saveMarkdown: (id: string, doc: MarkdownDoc, rev?: string, keepalive = false) =>
    request<{ meta: SheetMeta }>('PUT', `/api/markdown/${encodeURIComponent(id)}`, { doc, rev }, keepalive ? { keepalive: true } : undefined),
  renameMarkdown: (id: string, title: string) => request<{ meta: SheetMeta }>('PATCH', `/api/markdown/${encodeURIComponent(id)}`, { title }),
  deleteMarkdown: (id: string) => request<{ ok: true }>('DELETE', `/api/markdown/${encodeURIComponent(id)}`),
  listTrash: () => request<{ files: DeletedFile[]; available: boolean }>('GET', '/api/trash'),
  restoreFromTrash: (id: string) => request<{ file: SheetMeta }>('POST', `/api/trash/${encodeURIComponent(id)}/restore`),

  /** A chat: a file's (scope = its id) or the home page's, with the file's name. */
  agentTranscript: (scope: string) => request<{ items: ChatItem[]; title: string | null }>('GET', `/api/agent?scope=${encodeURIComponent(scope)}`),
  agentReset: (scope: string) => request<{ ok: true }>('POST', '/api/agent/reset', { scope }),
  /** Answer a permission the user's own agent asked for (AgentEvent 'permission'). */
  answerAgentPermission: (id: string, allow: boolean) => request<{ ok: true }>('POST', '/api/agent/permission', { id, allow }),
  agentTurn: streamAgentTurn,
  createJob: (title: string, spec: string, opts: { kind?: 'change' | 'research'; sheetId?: string | null } = {}) =>
    request<{ job: AgentJob }>('POST', '/api/agent/jobs', { title, spec, ...opts }),
  latestJob: () => request<{ job: AgentJob | null }>('GET', '/api/agent/jobs/latest'),
  acknowledgeJob: (id: string) => request<{ ok: true }>('POST', `/api/agent/jobs/${encodeURIComponent(id)}/ack`, {}),
  listJobs: () => request<{ jobs: AgentJob[] }>('GET', '/api/agent/jobs'),
  listConnectors: () => request<{ connectors: ConnectorInfo[] }>('GET', '/api/connectors'),
  listConnections: () => request<{ connections: ConnectionInfo[] }>('GET', '/api/connections'),
  createConnection: (connector: string, name: string, fields: Record<string, string>) =>
    request<{ connection: ConnectionInfo }>('POST', '/api/connections', { connector, name, fields }),
  updateConnection: (id: string, name: string, fields: Record<string, string>) =>
    request<{ connection: ConnectionInfo }>('PATCH', `/api/connections/${encodeURIComponent(id)}`, { name, fields }),
  deleteConnection: (id: string) => request<{ ok: true }>('DELETE', `/api/connections/${encodeURIComponent(id)}`),
  /** Test credentials before saving (with an id, blank secret fields use the saved ones). */
  testCredentials: (connector: string, fields: Record<string, string>, id?: string) => request<{ ok: true }>('POST', '/api/connections/test', { connector, fields, id }),
  testConnection: (id: string) => request<{ connection: ConnectionInfo }>('POST', `/api/connections/${encodeURIComponent(id)}/test`, {}),
  fetchConnectorData: (id: string, body: { dataset: string; params: Record<string, unknown>; handle?: string }) =>
    request<FetchResult>('POST', `/api/connections/${encodeURIComponent(id)}/fetch`, body),
  assistantSettings: () => request<{ settings: AssistantSettings }>('GET', '/api/settings/assistant'),
  saveAssistantSettings: (body: AssistantSettingsUpdate) => request<{ settings: AssistantSettings }>('PUT', '/api/settings/assistant', body),
  /** Store a copy of a picture on the web; resolves to its /api/images/... address. */
  keepWebImage: async (url: string) => (await request<{ url: string }>('POST', '/api/images/fetch', { url })).url,
  connectedAgents: () => request<{ enabled: boolean; agents: ConnectedAgent[]; mcpUrl?: string; local?: true; running?: boolean; everySignIn?: true }>('GET', '/api/settings/agents'),
  disconnectAgent: (id: string) => request<{ ok: true }>('DELETE', `/api/settings/agents/${encodeURIComponent(id)}`),
  newFilesSettings: () => request<NewFilesSettings>('GET', '/api/settings/new-files'),
  saveNewFilesSettings: (update: NewFilesUpdate) => request<NewFilesSettings>('PUT', '/api/settings/new-files', update),
  revertJob: (id: string) => request<{ job: AgentJob }>('POST', `/api/agent/jobs/${encodeURIComponent(id)}/revert`, {}),
};

/** Run or resume an agent turn, calling onEvent for each server-sent event until the stream ends. */
async function streamAgentTurn(body: AgentTurnRequest, signal: AbortSignal, onEvent: (e: AgentEvent) => void): Promise<void> {
  // The organization selected in the bar: the home chat's tools work in the user's files there.
  const workspace = activeOrganizationId();
  const res = await fetch('/api/agent/turn', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(workspace ? { ...body, workspace } : body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  // The server always ends a turn with done, client_tools or error; a stream that stops without one was cut
  // off (for example by the server restarting).
  const ended = await readAgentEvents(res.body, onEvent);
  if (!ended) throw new ApiError(0, 'The connection to the server was interrupted. Send your message again.');
}
