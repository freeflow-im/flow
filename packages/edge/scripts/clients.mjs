#!/usr/bin/env node
// The deploy's list of clients, from the apps' manifests (@flow/shared's APP_MANIFESTS), so a new app ships by its
// manifest alone. Reads packages/shared/dist by path (run `pnpm --filter @flow/shared build` first), so it also runs
// in the server image's build stage, where the edge's dependencies are not installed.
//
//   node packages/edge/scripts/clients.mjs build    one line per client: <package> <BASE_PATH>, for the build loop
//   node packages/edge/scripts/clients.mjs dists    one line per client: <dist folder> <required|optional>
//   node packages/edge/scripts/clients.mjs paths    the client packages' change-detection paths ('packages/x/**')
//   node packages/edge/scripts/clients.mjs check    fails when a generated block in the deploy files is stale
//   node packages/edge/scripts/clients.mjs write    rewrites those blocks (after adding an app's manifest)
//
// Generated blocks sit between `# clients:<name> begin` and `# clients:<name> end` lines in
// packages/server/deploy/aws/Dockerfile and .github/workflows/flow-aws-deploy.yml: the parts of those files that
// cannot run a script (COPY lines, a static `paths:` filter).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** @returns {Promise<{ pkg: string, dir: string, dist: string, basePath: string, optional: boolean }[]>} */
export async function deployClients() {
  const { APP_MANIFESTS } = await import(pathToFileURL(path.join(root, 'packages/shared/dist/manifests.js')).href);
  return APP_MANIFESTS.filter((m) => m.client).map((m) => {
    const dir = m.client.dist.split('/').slice(0, 2).join('/');
    const pkg = JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8')).name;
    return { pkg, dir, dist: m.client.dist, basePath: m.client.basePath, optional: !!m.client.optional };
  });
}

/** The generated blocks: file → block name → its lines (indentation is taken from the begin marker). */
export function blocks(clients) {
  return {
    'packages/server/deploy/aws/Dockerfile': {
      manifests: clients.map((c) => `COPY ${c.dir}/package.json ${c.dir}/`),
      install: [`RUN pnpm install --frozen-lockfile --filter @flow/server... ${clients.map((c) => `--filter ${c.pkg}...`).join(' ')}`],
      sources: clients.map((c) => `COPY ${c.dir} ${c.dir}`),
      // The clients the server does not serve, kept in the image for the edge Worker's deploy to copy out.
      dists: clients.filter((c) => c.optional).map((c) => `COPY --from=build /app/${c.dist} ${c.dist}`),
    },
    '.github/workflows/flow-aws-deploy.yml': {
      paths: clients.map((c) => `- '${c.dir}/**'`),
    },
  };
}

/** Replaces each block's body in `text`; throws on a missing marker. */
export function fill(text, file, fileBlocks) {
  for (const [name, lines] of Object.entries(fileBlocks)) {
    const re = new RegExp(`^([ \\t]*)# clients:${name} begin[^\\n]*\\n[\\s\\S]*?^[ \\t]*# clients:${name} end$`, 'm');
    const m = re.exec(text);
    if (!m) throw new Error(`${file}: no "# clients:${name} begin/end" block`);
    const ind = m[1];
    const body = [`${ind}# clients:${name} begin (node packages/edge/scripts/clients.mjs write)`, ...lines.map((l) => ind + l), `${ind}# clients:${name} end`];
    text = text.slice(0, m.index) + body.join('\n') + text.slice(m.index + m[0].length);
  }
  return text;
}

async function main(cmd) {
  const clients = await deployClients();
  if (cmd === 'build') return clients.forEach((c) => console.log(`${c.pkg} ${c.basePath}`));
  if (cmd === 'dists') return clients.forEach((c) => console.log(`${c.dist} ${c.optional ? 'optional' : 'required'}`));
  if (cmd === 'paths') return clients.forEach((c) => console.log(`${c.dir}/**`));
  if (cmd === 'check' || cmd === 'write') {
    let stale = 0;
    for (const [file, fileBlocks] of Object.entries(blocks(clients))) {
      const abs = path.join(root, file);
      const was = readFileSync(abs, 'utf8');
      const now = fill(was, file, fileBlocks);
      if (now === was) continue;
      if (cmd === 'write') writeFileSync(abs, now), console.log(`wrote ${file}`);
      else console.error(`${file}: its client list differs from the manifests; run node packages/edge/scripts/clients.mjs write`), stale++;
    }
    if (stale) process.exit(1);
    return;
  }
  console.error('usage: clients.mjs build | dists | paths | check | write');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2]);
