// Generate the data of Admin's Changelog page (packages/admin/src/sections/Changelog.tsx) from the changelog/ entry
// files, in full, and the frozen CHANGES_ARCHIVE_*.log files of the time before them.
//
// Every entry file is changelog/YYYY-MM-DD-<slug>.md (changelog/README.md): a `#` title, bullets with platform tags,
// and maybe a `## Feature` section. The page shows all of it, newest first, so it is written as one JSON file the page
// fetches when it opens (it is too large to build into the app's code): packages/admin/public/changelog.json, which
// Vite copies into the build. It is gitignored: never edit it by hand. Admin's `dev` and `build` scripts run this, and
// it can be run directly: node scripts/build-changelog.mjs [out-file]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;
// The platform tags at the start of a bullet: `[web]` as README.md writes them, or bare [web] where an entry left out
// the backticks. A word in brackets later in the text is not one.
const LEAD = /^\s*[-*]\s+((?:(?:`\[[a-z]+\]`|\[[a-z]+\])\s*)+)/;
const TAG = /\[([a-z]+)\]/g;
const tagsOf = (body) => body.split('\n').flatMap((line) => [...(LEAD.exec(line)?.[1] ?? '').matchAll(TAG)].map((t) => t[1]));

/** One entry file: its date, slug, title, the platforms its bullets name, and its whole text. */
export function parseEntry(file, text) {
  const m = ENTRY.exec(file);
  if (!m) return null;
  const body = text.replace(/\r\n?/g, '\n').trim();
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? m[2].replace(/-/g, ' ');
  const tags = [...new Set(tagsOf(body))].sort();
  return { file, date: m[1], slug: m[2], title, tags, feature: /^##\s+Feature\b/m.test(body), body };
}

/** Every entry, newest first (the same day: by file name, last first), and the archives, oldest phase first. */
export function buildChangelog(root = repoRoot) {
  const dir = path.join(root, 'changelog');
  const entries = fs
    .readdirSync(dir)
    .map((f) => parseEntry(f, fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter(Boolean)
    .sort((a, b) => (a.date === b.date ? b.file.localeCompare(a.file) : b.date.localeCompare(a.date)));
  const archives = fs
    .readdirSync(root)
    .filter((f) => /^CHANGES_ARCHIVE_.*\.log$/.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => ({ name, text: fs.readFileSync(path.join(root, name), 'utf8') }));
  return { generatedAt: new Date().toISOString(), entries, archives };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repoRoot, 'packages/admin/public/changelog.json');
  const data = buildChangelog();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data));
  console.log(`changelog: ${data.entries.length} entries and ${data.archives.length} archives → ${path.relative(repoRoot, out)}`);
}
