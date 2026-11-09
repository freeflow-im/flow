#!/usr/bin/env node
// `mcp-docs-dev [folder]` (from a clone; the published `@freeflow-im/mcp-docs` package is the installer in installer/): open the desktop app on a folder (the current directory by default).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

// Required from Node, the electron package is the path of its executable.
const electron = createRequire(import.meta.url)('electron');
const main = path.join(import.meta.dirname, 'main.js');
const dir = path.resolve(process.argv[2] ?? process.cwd());

let child;
if (process.platform === 'darwin') {
  // Started through LaunchServices, the app is its own program to macOS's privacy rules: it is the one
  // asked for (and given) access to Downloads, Documents and Desktop. Started as a child of the terminal it
  // would need the terminal's access, and a folder the terminal may not read looks unreadable to the app.
  // The app does not get the terminal's environment this way, so what the assistant needs is passed on.
  const bundle = path.resolve(electron, '..', '..', '..');
  const env = ['ANTHROPIC_API_KEY', 'AGENT_MODEL'].flatMap((k) => (process.env[k] ? ['--env', `${k}=${process.env[k]}`] : []));
  child = spawn('open', ['-n', '-W', '-a', bundle, ...env, '--args', main, dir], { stdio: 'inherit' });
} else {
  child = spawn(electron, [main, dir], { stdio: 'inherit' });
}
child.on('exit', (code) => process.exit(code ?? 0));
