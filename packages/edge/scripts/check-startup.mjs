#!/usr/bin/env node
// The Worker's startup CPU, measured as a deploy would build it, and a failure above a limit (ci.yml, job edge-startup).
//
// Cloudflare refuses a version whose startup takes more than 1 s of CPU (error 10021); #872's deploy was refused on
// 2026-11-18. What costs startup is code that runs when the Worker loads, not the bundle's size: a library behind
// `import()` costs almost nothing until it is used (PR #875). This catches a change that puts heavy code back at the top
// before Cloudflare does, at deploy time.
//
// The number is `wrangler check startup`'s "Active" CPU on this machine, the median of RUNS runs. It is not Cloudflare's
// number (which is higher, and varies a lot between runs), so the limit is set from what CI measured, with room:
// STARTUP_LIMIT_MS overrides it.
//
// Usage (from packages/edge): node scripts/check-startup.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIMIT_MS = Number(process.env.STARTUP_LIMIT_MS ?? 0) || 0;
const RUNS = 3;

const wrangler = (...args) => execFileSync('pnpm', ['exec', 'wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// wrangler wants the assets folder to exist; scripts/assemble.mjs fills it only for a real deploy.
mkdirSync('public', { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'edge-startup-'));
const bundle = join(dir, 'worker.bundle');
wrangler('deploy', '--dry-run', '--outfile', bundle);

const runs = [];
for (let i = 0; i < RUNS; i++) {
  const out = wrangler('check', 'startup', '--worker', bundle, '--outfile', join(dir, `startup-${i}.cpuprofile`));
  const m = /Active:\s*([\d.]+)\s*ms/.exec(out);
  if (!m) throw new Error(`no "Active" line in wrangler check startup's output:\n${out}`);
  runs.push(Number(m[1]));
}
const median = [...runs].sort((a, b) => a - b)[Math.floor(RUNS / 2)];
const verdict = !LIMIT_MS ? 'no limit set' : median > LIMIT_MS ? `over the ${LIMIT_MS} ms limit` : `under the ${LIMIT_MS} ms limit`;
const line = `Worker startup CPU (wrangler check startup, median of ${RUNS}): ${median} ms (${runs.join(', ')}), ${verdict}`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
if (LIMIT_MS && median > LIMIT_MS) {
  console.error('Startup CPU grew past the limit. Look for heavy code imported at the top of a module the Worker loads at start, and load it on first use (`import()`), as PR #875 did. A profile: wrangler check startup --worker <bundle>.');
  process.exit(1);
}
