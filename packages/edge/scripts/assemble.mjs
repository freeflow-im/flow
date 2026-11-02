// Fills public/ for the Worker from the clients' builds: the web client at the root, the Workspace client under
// /workspace. Pages stay out: the origin answers them, because it decides per request (the sign-in redirect on
// /workspace, the headers of /p/*), except on the hosts the Worker answers for, where src/routes/pages.ts serves them from /_pages. So do files over the 25 MiB Workers takes (the assistant's ONNX runtimes): the
// Worker misses and the origin answers. Production copies the builds out of the server's image (deploy-edge.yml), so the names match the server's pages.
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const edge = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packages = path.resolve(edge, '..');
const out = path.join(edge, 'public');
const MAX_FILE = 25 * 1024 * 1024;
const left = [];
const belongsHere = (file) => {
  // A client's own page is filed under /_pages; its other HTML (privacy.html, the Mermaid sandbox) is an ordinary file.
  if (/(^|\/)(index|landing)\.html$/.test(file)) return false;
  const stat = statSync(file);
  if (stat.isFile() && stat.size > MAX_FILE) {
    left.push(path.basename(file));
    return false;
  }
  return true;
};

const clients = [
  [path.join(packages, 'web', 'dist'), out],
  [path.join(packages, 'docs', 'dist', 'client'), path.join(out, 'workspace')],
];
for (const [from] of clients) {
  if (!existsSync(path.join(from, 'index.html'))) throw new Error(`${from} has no build; build the clients first`);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [from, to] of clients) cpSync(from, to, { recursive: true, filter: belongsHere });
// The clients' pages, which the Worker serves on the hosts it answers for (src/routes/pages.ts); the origin's own pages until then.
mkdirSync(path.join(out, '_pages'), { recursive: true });
cpSync(path.join(clients[0][0], 'index.html'), path.join(out, '_pages', 'index.html'));
cpSync(path.join(clients[1][0], 'index.html'), path.join(out, '_pages', 'workspace.html'));
console.log(`assembled ${out}${left.length ? `; left to the origin: ${left.join(', ')}` : ''}`);
