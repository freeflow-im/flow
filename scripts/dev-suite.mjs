#!/usr/bin/env node
// `pnpm dev:suite` — the whole FreeFlow suite on one local URL, the way production runs it.
//
// The suite's backend is one process: the Cloudflare Worker in packages/edge (`wrangler dev`), which holds every app
// as a Durable Object (Directory, Org/Chat, Docs, Mail, Calendar, Contacts, Admin, Assistant, Events). It serves the
// clients' built files from packages/edge/public, which scripts/assemble.mjs fills from each client's dist. No
// Postgres, no NATS and no Node server are needed: those are the AWS origin, which this script points at a dead port.
//
// Usage:
//   pnpm dev:suite                 # start on http://localhost:8787 from the clients' existing builds
//   pnpm dev:suite --build         # build @flow/shared and every client first (a few minutes), then start
//   pnpm dev:suite --build=mail    # rebuild one client (its package name's last part) and start
//   pnpm dev:suite --port=18796    # another port
//   pnpm dev:suite --var=KEY:value # extra `wrangler dev --var` flags, repeatable
//
// A client with no dist is left out, and its path answers "not built into this deploy". Chat's and Docs' builds are
// required by the assembler, so the first run is `pnpm dev:suite --build`.
//
// Secrets go in packages/edge/.dev.vars (gitignored); this writes one with a fresh FLOW_DATA_KEY when it is missing.
// Sign-up and sign-in links are printed to the Worker's log instead of being emailed: watch this terminal for them.
// Hot reload of a client: start its own Vite dev server beside this (BUILD.md, "Local development").
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edge = path.join(root, 'packages/edge');
const args = process.argv.slice(2);
const has = (name) => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const values = (name) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const port = Number(values('port')[0] ?? 8787);
const origin = `http://localhost:${port}`;

const run = (cmd, cmdArgs, opts = {}) => {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: root, ...opts });
  if (r.status !== 0) {
    console.error(`dev:suite: \`${cmd} ${cmdArgs.join(' ')}\` failed`);
    process.exit(r.status ?? 1);
  }
};

// ---- the shared package, which the assembler and the client list read ---------------------------------------------
if (!existsSync(path.join(root, 'packages/shared/dist/manifests.js')) || has('build')) run('pnpm', ['--filter', '@flow/shared', 'build']);

// ---- the clients, each built for its manifest's base path (as packages/server/deploy/aws/Dockerfile does) ---------
const { deployClients } = await import(path.join(edge, 'scripts/clients.mjs'));
const clients = await deployClients();
if (has('build')) {
  const only = values('build').filter(Boolean);
  const chosen = only.length ? clients.filter((c) => only.includes(c.pkg.split('/').pop())) : clients;
  if (only.length && !chosen.length) {
    console.error(`dev:suite: no client named ${only.join(', ')}; the clients are ${clients.map((c) => c.pkg.split('/').pop()).join(', ')}`);
    process.exit(2);
  }
  for (const c of chosen) {
    console.log(`\ndev:suite: building ${c.pkg} for ${c.basePath}`);
    run('pnpm', ['--filter', c.pkg, 'build'], { env: { ...process.env, BASE_PATH: c.basePath, BUILD_SHA: sha() } });
  }
}
const missing = clients.filter((c) => !existsSync(path.join(root, c.dist, 'index.html')));
if (missing.some((c) => !c.optional)) {
  console.error(`dev:suite: ${missing.filter((c) => !c.optional).map((c) => c.pkg).join(' and ')} not built; run \`pnpm dev:suite --build\` once`);
  process.exit(1);
}
for (const c of missing) console.warn(`dev:suite: ${c.pkg} has no build; ${c.basePath} is left out (pnpm dev:suite --build=${c.pkg.split('/').pop()})`);

// ---- public/ for the Worker ---------------------------------------------------------------------------------------
run('node', ['scripts/assemble.mjs'], { cwd: edge });

// ---- secrets --------------------------------------------------------------------------------------------------------
const devVars = path.join(edge, '.dev.vars');
if (!existsSync(devVars)) {
  const key = execFileSync('openssl', ['rand', '-base64', '32']).toString().trim();
  writeFileSync(devVars, `EDGE_ORIGIN_SECRET=local\nFLOW_DATA_KEY=${key}\n`);
  console.log(`dev:suite: wrote ${path.relative(root, devVars)} with a new FLOW_DATA_KEY (keep it: the Worker's local data is sealed with it)`);
}
mkdirSync(path.join(edge, 'public'), { recursive: true });

// ---- the Worker -----------------------------------------------------------------------------------------------------
// The vars production sets for its hosts (wrangler.toml [vars]), set here for localhost. ORIGIN_URL is a dead port: a
// path the Worker has not ported fails fast instead of reaching production. --local-upstream makes OAuth's issuer and
// the sign-in links this origin. Containers (the PDF OCR) are off: they need Docker, and Docs' PDF import still works
// for PDFs with a text layer.
const vars = {
  PORTED_HOSTS: 'localhost',
  ASSET_HOSTS: 'localhost',
  ORIGIN_URL: 'http://localhost:9',
  WEB_URL_BASE: origin,
  FLOW_WEB_URL: origin,
  FLOW_HANDOFF_RETURN_URLS: `flow://signin,${origin}/`,
  MAIL_PROVIDER: 'fake',
  MAIL_ALLOW_INSECURE: '1',
  CALENDAR_ALLOW_INSECURE: '1',
  FLOW_UNFURL_ALLOW_HOSTS: 'localhost',
};
const flags = Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]);
for (const v of values('var')) flags.push('--var', v);

console.log(`\ndev:suite: the suite is at ${origin}  (Chat ${origin}/chat, Docs ${origin}/docs, Mail ${origin}/mail, Calendar ${origin}/calendar, Contacts ${origin}/contacts, Admin ${origin}/admin)`);
console.log('dev:suite: sign-up and sign-in links are printed below, not emailed\n');
const wrangler = spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', String(port), '--local', '--enable-containers=false', '--local-upstream', `localhost:${port}`, ...flags], {
  cwd: edge,
  stdio: 'inherit',
});
wrangler.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => wrangler.kill(sig));

function sha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
  } catch {
    return 'dev';
  }
}
