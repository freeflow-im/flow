// Fills public/ for the Worker from the clients' builds, one per app manifest with a client (@flow/shared's
// APP_MANIFESTS; scripts/lib/clients.mjs): the web client at the root, the Workspace client under /docs, the Mail
// client under /mail, the Calendar client under /calendar. Pages stay out: the origin answers them, because it decides per request (the sign-in redirect on
// /docs, the headers of /p/*), except on the hosts the Worker answers for, where src/routes/pages.ts serves them from /_pages. So do files over the 25 MiB Workers takes (the assistant's ONNX runtimes): the
// Worker misses and the origin answers. Production copies the builds out of the server's image (deploy-edge.yml), so the names match the server's pages.
// Reads the shared package's build, so `pnpm --filter @flow/shared build` comes first (deploy-edge.yml does).
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_MANIFESTS } from '@flow/shared/manifests';
import { clientsFrom } from './lib/clients.mjs';

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

// A required client (Chat's, Docs') missing fails the deploy. An optional one (Mail, Calendar) is left out: a server image
// built before it existed has no build of it, and the Worker then answers its path with "not built into this deploy".
const clients = [];
for (const client of clientsFrom(APP_MANIFESTS, path.resolve(packages, '..'), out)) {
  if (existsSync(path.join(client.from, 'index.html'))) clients.push(client);
  else if (client.optional) console.warn(`${client.from} has no build; /${client.name} is left out of this deploy`);
  else throw new Error(`${client.from} has no build; build the clients first`);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const { from, to } of clients) cpSync(from, to, { recursive: true, filter: belongsHere });
// The clients' pages, which the Worker serves on the hosts it answers for (src/routes/pages.ts); the origin's own pages until then.
mkdirSync(path.join(out, '_pages'), { recursive: true });
for (const { from, page } of clients) if (page) cpSync(path.join(from, 'index.html'), path.join(out, '_pages', page));
console.log(`assembled ${out}${left.length ? `; left to the origin: ${left.join(', ')}` : ''}`);
