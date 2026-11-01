// A stored picture file used as a picture in a document, on a slide or in a cell. The assistant sometimes has
// a picture as a file (it saved it from the web, or made an edited copy) and gives that file's address where a
// picture goes. Files and pictures-in-documents are stored apart (a file can be renamed, saved over or deleted;
// what a document shows must not change under it), so the file's bytes are stored as a picture of their own
// and that address is used.
import { CELL_IMAGE_TYPES, type StoredFile } from '../../../shared/types.ts';

/** A stored file's address (with or without the app's own origin, its /download form too), whole or inside Markdown's ](...). */
const FILE_ADDRESS = /(?:https?:\/\/[^\s/()"']+)?\/api\/files\/([A-Za-z0-9_-]{6,64})(?:\/download)?/g;
const WHOLE = new RegExp(`^${FILE_ADDRESS.source}$`);
const IN_MARKDOWN = new RegExp(`(\\]\\(\\s*<?)${FILE_ADDRESS.source}`, 'g');

export interface FilePictureEnv {
  readFile?(id: string): Promise<{ file: StoredFile; data: ArrayBuffer }>;
  uploadImage(file: Blob): Promise<string>;
}

/**
 * The tool input with every stored picture file's address replaced by a stored picture's: where a string is
 * such an address, and where one is the target of a Markdown image or link. A file that is not a picture, or
 * is not there, is left as it is, for the tool to refuse in its own words.
 */
export async function withFilePictures<T>(input: T, env: FilePictureEnv): Promise<T> {
  if (!env.readFile) return input;
  const ids = new Set<string>();
  const find = (v: unknown): void => {
    if (typeof v === 'string') {
      const whole = WHOLE.exec(v.trim());
      if (whole) ids.add(whole[1]);
      for (const m of v.matchAll(IN_MARKDOWN)) ids.add(m[2]);
    } else if (Array.isArray(v)) v.forEach(find);
    else if (v && typeof v === 'object') Object.values(v).forEach(find);
  };
  find(input);
  if (!ids.size) return input;
  const stored = new Map<string, string>();
  for (const id of ids) {
    try {
      const { file, data } = await env.readFile(id);
      if (CELL_IMAGE_TYPES.includes(file.type)) stored.set(id, await env.uploadImage(new Blob([data], { type: file.type })));
    } catch {
      // Not a file of the user's: left for the tool to refuse.
    }
  }
  if (!stored.size) return input;
  const swap = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const whole = WHOLE.exec(v.trim());
      if (whole) return stored.get(whole[1]) ?? v;
      return v.replace(IN_MARKDOWN, (all: string, open: string, id: string) => (stored.has(id) ? `${open}${stored.get(id)}` : all));
    }
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
    return v;
  };
  return swap(input) as T;
}
