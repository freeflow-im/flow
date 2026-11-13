// Attaching a file from Docs (components/DocsPicker.tsx): the files of Docs the person can open in the current
// organization, found by name as Docs' own search finds them (`/api/library/search`, in My files and in the organization's
// shared files) or, before anything is typed, the ones they opened last (`/api/recents`). A document is attached as the
// file Docs downloads it as (a Word, Excel or PowerPoint file, or Markdown); any other file as it is stored.

export type DocsKind = 'doc' | 'sheet' | 'deck' | 'markdown' | 'file';

export interface DocsFile {
  kind: DocsKind;
  id: string;
  name: string;
  /** The folder it is in ('' at the top). */
  folder: string;
  /** One of the organization's shared files rather than one of the person's own. */
  shared: boolean;
  /** A stored file's type and size (a document's is only known once it is made into a file). */
  type?: string;
  size?: number;
  /** A spreadsheet kept as a CSV file is downloaded as one. */
  format?: string;
}

/** What a document is downloaded as: Docs' own first format for it, but a Word file for a document, not Markdown. */
export function exportFormat(f: Pick<DocsFile, 'kind' | 'format'>): string | null {
  switch (f.kind) {
    case 'doc':
      return 'docx';
    case 'sheet':
      return f.format === 'csv' ? 'csv' : 'xlsx';
    case 'deck':
      return 'pptx';
    case 'markdown':
      return 'md';
    default:
      return null;
  }
}

const EXT_TYPES: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  md: 'text/markdown',
};

/** The name and type a file will be attached as, to show before its bytes arrive. */
export function attachedAs(f: DocsFile): { name: string; type: string } {
  const ext = exportFormat(f);
  if (!ext) return { name: f.name, type: f.type || 'application/octet-stream' };
  const name = f.name.toLowerCase().endsWith(`.${ext}`) ? f.name : `${f.name}.${ext}`;
  return { name, type: EXT_TYPES[ext]! };
}

/** The file name a download names in its Content-Disposition, or null. */
export function dispositionName(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      // Fall back to the plain name.
    }
  }
  return /filename\s*=\s*"([^"]*)"/i.exec(header)?.[1] ?? null;
}

const enc = encodeURIComponent;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error ?? `Docs could not be reached (${res.status}).`);
  return data;
}

interface SheetMetaLike {
  id: string;
  kind: Exclude<DocsKind, 'file'>;
  title: string;
  folder?: string;
  shared?: true;
  format?: string;
}
interface StoredFileLike {
  id: string;
  filename: string;
  folder?: string;
  shared?: true;
  type: string;
  size: number;
}

const fromDoc = (d: SheetMetaLike): DocsFile => ({ kind: d.kind, id: d.id, name: d.title, folder: d.folder ?? '', shared: !!d.shared, ...(d.format ? { format: d.format } : {}) });
const fromStored = (f: StoredFileLike): DocsFile => ({ kind: 'file', id: f.id, name: f.filename, folder: f.folder ?? '', shared: !!f.shared, type: f.type, size: f.size });

const place = (workspace: string | null, shared = false) => (workspace ? `&workspace=${enc(workspace)}${shared ? '&shared=1' : ''}` : '');

export const docsFiles = {
  /** The files opened last in Docs, newest first. */
  async recent(workspace: string | null): Promise<DocsFile[]> {
    const { files } = await getJson<{ files: { kind: DocsKind; id?: string; name: string; folder?: string; shared?: true; format?: string; size?: number }[] }>(`/api/recents?${place(workspace).slice(1)}`);
    return files.filter((f) => f.id).map((f) => ({ kind: f.kind, id: f.id!, name: f.name, folder: f.folder ?? '', shared: !!f.shared, ...(f.format ? { format: f.format } : {}), ...(f.size !== undefined ? { size: f.size } : {}) }));
  },

  /** Files whose names match, in My files and in the organization's shared files. */
  async search(q: string, workspace: string | null): Promise<DocsFile[]> {
    const ask = (shared: boolean) => getJson<{ docs: SheetMetaLike[]; files: StoredFileLike[] }>(`/api/library/search?q=${enc(q)}${place(workspace, shared)}`);
    // Outside an organization there is only the person's own library.
    const found = await Promise.all(workspace ? [ask(false), ask(true).catch(() => ({ docs: [], files: [] }))] : [ask(false)]);
    const seen = new Set<string>();
    return found
      .flatMap((r) => [...r.docs.map(fromDoc), ...r.files.map(fromStored)])
      .filter((f) => !seen.has(f.id) && !!seen.add(f.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  /** The bytes to attach: the stored file, or the document made into a file. */
  async fetch(f: DocsFile): Promise<{ blob: Blob; name: string; type: string }> {
    const ext = exportFormat(f);
    const res = await fetch(ext ? `/api/files/${enc(f.id)}/export?format=${ext}` : `/api/files/${enc(f.id)}/download`, { credentials: 'same-origin' });
    if (!res.ok) {
      const msg = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
      throw new Error(msg ?? `“${f.name}” could not be fetched from Docs (${res.status}).`);
    }
    const blob = await res.blob();
    const as = attachedAs(f);
    return { blob, name: dispositionName(res.headers.get('content-disposition')) ?? as.name, type: (res.headers.get('content-type') ?? '').split(';')[0]!.trim() || as.type };
  },
};
