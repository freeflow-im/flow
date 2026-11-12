#!/usr/bin/env node
// Builds the customer version of the FreeFlow Browser extension, for the Chrome Web Store.
//
//   node packages/browser-extension/package.mjs
//
// The source manifest is the dev build: loaded unpacked, it keeps a fixed id (its `key`), answers a local dev server,
// and may use the debugger for screenshots. The customer build is made from it here:
//   - name "FreeFlow Browser" (no "(dev)");
//   - no `key` (the Web Store refuses it and gives the item its own id);
//   - only https://app.freeflow.im may message it (no localhost);
//   - no `debugger` permission (screenshots show the tab for a moment instead).
// The result is dist/freeflow-browser-<version>.zip. The Web Store needs a higher version on every upload, so bump
// `version` in manifest.json in the PR that changes the extension.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FILES = ['background.js', 'icons'];

const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
delete manifest.key;
manifest.name = 'FreeFlow Browser';
manifest.permissions = manifest.permissions.filter((p) => p !== 'debugger');
manifest.externally_connectable = { matches: ['https://app.freeflow.im/*'] };

const dist = join(here, 'dist');
const stage = join(dist, 'freeflow-browser');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of FILES) cpSync(join(here, f), join(stage, f), { recursive: true });
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const zip = join(dist, `freeflow-browser-${manifest.version}.zip`);
rmSync(zip, { force: true });
execFileSync('zip', ['-r', '-X', '-q', zip, '.'], { cwd: stage });

console.log(`Built ${zip}`);
console.log(`  ${manifest.name} ${manifest.version}; permissions: ${manifest.permissions.join(', ')}; messaged by: ${manifest.externally_connectable.matches.join(', ')}`);
console.log(`  Unpacked copy (to test before upload): ${stage}`);
