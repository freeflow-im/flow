// New files that appear in the folders the desktop app watches (Downloads, Documents, Desktop): a download that
// finishes, a file saved from another app, a screenshot. main.js opens each in the app. Only the folders
// themselves, not what is inside their folders, and only the kinds of file the person chose in Settings (KINDS).
// A file is told once it stops changing, so a download still being written is not opened half done; browsers
// write theirs under a name of their own (.crdownload, .part, .download) and rename it when done, which is when
// it appears here. Several files at once are a copy, not a download, and open nothing.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, watch } from 'node:fs';
import path from 'node:path';

/**
 * The kinds of file that can open, as Settings lists them, with whether each does when the person has not chosen.
 * A file of none of the extensions is a text file when its bytes are text (`text`), as the app's own text editor decides.
 */
export const KINDS = [
  { id: 'office', label: 'Word, Excel and PowerPoint files', exts: ['.docx', '.xlsx', '.xls', '.pptx', '.ffdoc', '.ffsheet', '.ffslides'], on: true },
  { id: 'pdf', label: 'PDFs', exts: ['.pdf'], on: true },
  { id: 'markdown', label: 'Markdown', exts: ['.md', '.markdown'], on: true },
  { id: 'csv', label: 'CSV files', exts: ['.csv'], on: true },
  { id: 'text', label: 'Other text files (.txt, .json, .log, code…)', exts: [], text: true, on: true },
  { id: 'pictures', label: 'Pictures (PNG, JPEG, GIF, WebP)', exts: ['.png', '.jpg', '.jpeg', '.gif', '.webp'], on: true },
  { id: 'videos', label: 'Videos', exts: ['.mp4', '.m4v', '.mov', '.webm', '.ogv'], on: false },
];
export const DEFAULT_KINDS = KINDS.filter((k) => k.on).map((k) => k.id);

/** Names that are never a finished file: a download or a save still being written, a backup, an editor's swap file. */
const UNFINISHED = /\.(crdownload|part|partial|download|opdownload|tmp|temp|swp|lock)$|~$/i;
/** Extensions of files whose bytes may look like text but which are not something to read (a key, an installer). */
const NOT_TEXT = new Set(['.pem', '.key', '.p12', '.dmg', '.pkg', '.exe', '.msi', '.zip', '.ics', '.vcf', '.webloc', '.url', '.lnk', '.torrent', '.htm', '.html']);
/** The largest text file opened (the app's text editor's limit, MAX_TEXT_EDIT_BYTES). */
const MAX_TEXT = 5 * 1024 * 1024;

/** The kind of file a name is (an id of KINDS), or null for a hidden, lock, unfinished or other file that never opens. */
export function kindOf(name) {
  if (name.startsWith('.') || name.startsWith('~$') || UNFINISHED.test(name)) return null;
  const ext = path.extname(name).toLowerCase();
  const kind = KINDS.find((k) => k.exts.includes(ext));
  if (kind) return kind.id;
  return NOT_TEXT.has(ext) ? null : 'text';
}

/** Whether the file's first 8 KB are text: valid UTF-8, no NUL and hardly any control characters (server/files.ts's looksLikeText). */
export function isText(file, size) {
  if (size > MAX_TEXT) return false;
  let fd;
  try {
    fd = openSync(file, 'r');
    const sample = Buffer.alloc(Math.min(8192, size));
    const n = readSync(fd, sample, 0, sample.length, 0);
    const bytes = sample.subarray(0, n);
    if (bytes.includes(0)) return false;
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: n < size });
    let control = 0;
    for (const b of bytes) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b) control++;
    return control <= bytes.length / 100;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Watch `dirs` and call `onFile` with each new file of the `kinds` asked for (ids of KINDS) once it has settled
 * (`settle` ms without a change). Files already there, and those `ignore` names (the app's own writes), are not
 * new. Files that settle within `bulk` ms of each other are a copy: none of them is told. Returns the function that stops.
 */
export function watchNewFiles({ dirs, kinds = DEFAULT_KINDS, onFile, ignore = () => false, settle = 1000, bulk = 1000 }) {
  const wanted = new Set(kinds);
  const watchers = [];
  const pending = new Map();
  let ready = [];
  let batch = null;

  const settled = (file) => {
    ready.push(file);
    batch ??= setTimeout(() => {
      const files = ready;
      ready = [];
      batch = null;
      if (files.length === 1) onFile(files[0]);
    }, bulk);
  };

  for (const dir of dirs) {
    let known;
    let watcher;
    try {
      known = new Set(readdirSync(dir));
      watcher = watch(dir, { persistent: false });
    } catch {
      continue; // Not there, or not ours to read.
    }
    watcher.on('error', () => {});
    watchers.push(watcher);

    /** Look at the file every `settle` ms until it stops changing. */
    const check = (name, kind, last = null) => {
      const file = path.join(dir, name);
      let st;
      try {
        st = statSync(file);
      } catch {
        // Gone: one made again under the name is new.
        known.delete(name);
        return void pending.delete(file);
      }
      // Firefox makes the file empty and fills it in at the end, under another name it then renames: that is told then.
      if (!st.isFile() || st.size === 0) return void pending.delete(file);
      const now = `${st.size}:${st.mtimeMs}`;
      if (now !== last) return void pending.set(file, setTimeout(() => check(name, kind, now), settle));
      pending.delete(file);
      known.add(name);
      if (kind === 'text' && !isText(file, st.size)) return;
      if (!ignore(file)) settled(file);
    };

    watcher.on('change', (_event, name) => {
      if (name == null) return;
      name = String(name);
      const file = path.join(dir, name);
      const kind = kindOf(name);
      if (!kind || !wanted.has(kind) || pending.has(file)) return;
      if (known.has(name)) {
        // Changed, not new. One removed is forgotten, so one made again under its name is new.
        if (!existsSync(file)) known.delete(name);
        return;
      }
      pending.set(file, setTimeout(() => check(name, kind), settle));
    });
  }

  return () => {
    for (const w of watchers) w.close();
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
    if (batch) clearTimeout(batch);
    batch = null;
    ready = [];
  };
}
