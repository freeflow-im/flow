// The desktop app's "Recents": the files the person last opened on this Mac, in any app and any folder,
// as Finder's Recents shows them. Spotlight keeps a "last used" date for a file each time it is opened;
// this asks it for the files used lately (mdfind) and keeps the kinds the app can show. macOS only.
// Reached through `#runtime/local/systemRecents`: a hosted object has none of this.
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { RecentFile, Recents } from './recents.ts';

/** The folders macOS asks about before an app may read them. Most of what was opened lately is in them. */
const GUARDED = ['Desktop', 'Documents', 'Downloads'];
const refused = (e: unknown): boolean => ['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException)?.code ?? '');

/** How far back to look, and how many files to show. */
const DAYS = 90;
const LIMIT = 60;

export const recentsAvailable = (): boolean => process.platform === 'darwin';

/**
 * The files and their dates in mdfind's output ("<path>   kMDItemLastUsedDate = 2026-10-13 21:04:18 +0000", or
 * kMDItemDateAdded for a download), newest first. A file listed more than once keeps its latest date.
 */
export function parseRecents(output: string): { path: string; lastUsed: string }[] {
  const latest = new Map<string, string>();
  for (const line of output.split('\n')) {
    const m = /^(.+?)\s+kMDItem(?:LastUsedDate|DateAdded) = (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)$/.exec(line);
    if (!m) continue;
    const when = new Date(`${m[2]}T${m[3]}${m[4]}:${m[5]}`);
    if (Number.isNaN(when.getTime())) continue;
    const iso = when.toISOString();
    if ((latest.get(m[1]) ?? '') < iso) latest.set(m[1], iso);
  }
  return [...latest].map(([path, lastUsed]) => ({ path, lastUsed })).sort((a, b) => (a.lastUsed < b.lastUsed ? 1 : a.lastUsed > b.lastUsed ? -1 : 0));
}

/** Whether a recently used file is one to list: a kind the app shows, and not something hidden or the system's. */
export function listable(file: string, exts: ReadonlySet<string>, home = homedir()): boolean {
  if (!path.isAbsolute(file) || !exts.has(path.extname(file).toLowerCase())) return false;
  const rel = path.relative(home, file);
  const parts = (rel.startsWith('..') ? file : rel).split(path.sep);
  if (!rel.startsWith('..') && parts[0] === 'Library') return false;
  return !parts.some((p) => p.startsWith('.') || p === 'node_modules');
}

/** The folder a file is in, as Recents shows it: the home directory written "~". */
export const whereOf = (file: string, home: string): string => {
  const dir = path.dirname(file);
  const rel = path.relative(home, dir);
  return rel === '' ? '~' : rel.startsWith('..') ? dir : `~/${rel}`;
};

const spotlight = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('/usr/bin/mdfind', args, { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/**
 * Finder's Recents is the files with a last-used date that the system knows as content (documents, pictures, video),
 * which leaves out files of a type no app has described, such as source files. A download nobody has opened yet
 * has no last-used date, so Downloads adds the files that arrived lately, dated when they did, as Finder shows them.
 */
async function mdfind(home: string): Promise<string> {
  const content = 'kMDItemContentTypeTree == "public.content"';
  const [used, added] = await Promise.all([
    spotlight(['-onlyin', home, '-attr', 'kMDItemLastUsedDate', `kMDItemLastUsedDate >= $time.today(-${DAYS}) && ${content}`]),
    spotlight(['-onlyin', path.join(home, 'Downloads'), '-attr', 'kMDItemDateAdded', `kMDItemDateAdded >= $time.today(-${DAYS})`]).catch(() => ''),
  ]);
  return `${used}\n${added}`;
}

/**
 * The recently used files with one of the extensions, newest first. `run` stands in for Spotlight in tests.
 * Reading each guarded folder first is what makes macOS ask the person, the first time, whether the app may;
 * one it refuses is reported, since its files cannot be listed or opened.
 */
export async function recentFiles(exts: ReadonlySet<string>, run: (home: string) => Promise<string> = mdfind, home = homedir()): Promise<Recents> {
  const blocked: string[] = [];
  for (const name of GUARDED) {
    try {
      await readdir(path.join(home, name));
    } catch (e) {
      if (refused(e)) blocked.push(name);
    }
  }
  const out: RecentFile[] = [];
  for (const f of parseRecents(await run(home))) {
    if (out.length >= LIMIT) break;
    if (!listable(f.path, exts, home)) continue;
    try {
      const st = await stat(f.path);
      if (st.isFile()) out.push({ path: f.path, name: path.basename(f.path), where: whereOf(f.path, home), lastUsed: f.lastUsed, size: st.size });
    } catch {
      // Moved or deleted since it was used.
    }
  }
  return { files: out, blocked };
}

/**
 * The desktop app's: the files opened in the app that are still there. One that is gone stays recorded, in case
 * it comes back (a drive, say).
 */
export async function openedFiles(opens: { ref: string; openedAt: string }[], exts: ReadonlySet<string>, home = homedir()): Promise<RecentFile[]> {
  const out: RecentFile[] = [];
  for (const r of opens) {
    if (!exts.has(path.extname(r.ref).toLowerCase())) continue;
    try {
      const st = await stat(r.ref);
      if (st.isFile()) out.push({ path: r.ref, name: path.basename(r.ref), where: whereOf(r.ref, home), lastUsed: r.openedAt, size: st.size, app: true });
    } catch {
      // Moved or deleted since.
    }
  }
  return out;
}
