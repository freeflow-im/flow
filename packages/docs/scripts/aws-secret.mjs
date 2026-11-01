#!/usr/bin/env node
// Copies variables from the local .env to the AWS deployment's secrets: `npm run aws:secret -- ANTHROPIC_API_KEY MAIL_FROM`.
// Each becomes the SecureString parameter /mcpdocs/<NAME> in us-west-2 (replacing one already there), which
// deploy/aws's deploy.sh hands the app as that variable on the next deploy. Uses the AWS CLI with your credentials;
// values are passed in a private temporary file, never on the command line or the screen.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGION = 'us-west-2';
const PREFIX = '/mcpdocs/';
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const names = process.argv.slice(2);
if (!names.length) fail('Usage: npm run aws:secret -- <NAME> [NAME ...]   (names from .env)');

// NAME=value lines, optionally `export`ed, with the value optionally in single or double quotes.
const env = new Map();
for (const line of readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (!m) continue;
  let value = m[2];
  if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
  else value = value.replace(/\s+#.*$/, '');
  env.set(m[1], value);
}

const missing = names.filter((n) => !env.get(n));
if (missing.length) fail(`Not set in .env: ${missing.join(', ')}`);

const dir = mkdtempSync(path.join(tmpdir(), 'aws-secret-'));
try {
  for (const name of names) {
    const input = path.join(dir, 'input.json');
    writeFileSync(input, JSON.stringify({ Name: PREFIX + name, Value: env.get(name), Type: 'SecureString', Overwrite: true }), { mode: 0o600 });
    execFileSync('aws', ['ssm', 'put-parameter', '--region', REGION, '--cli-input-json', `file://${input}`], { stdio: ['ignore', 'ignore', 'inherit'] });
    console.log(`${PREFIX}${name} set`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('The app gets them on the next deploy (or run /opt/mcpdocs/deploy.sh latest on the instance).');
