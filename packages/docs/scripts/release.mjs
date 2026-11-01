#!/usr/bin/env node
// Starts a desktop release: `npm run release -- 0.3.0`.
// Sets the version of the app, the Claude Code and Codex plugin, its Claude marketplace entry and the installer, commits that with
// the release notes (release-notes/<version>.md, which you write first) and tags it desktop-v<version>. Pushing the
// tag runs .github/workflows/desktop-release.yml, which builds the app, makes the GitHub release and publishes the
// installer to npm.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail('Usage: npm run release -- <version>   (for example 0.3.0)');
const tag = `desktop-v${version}`;
const notes = `release-notes/${version}.md`;
if (!existsSync(path.join(root, notes))) fail(`Write the release notes first: ${notes} (what is new, as a Markdown list).`);
if (git('tag', '--list', tag)) fail(`${tag} already exists.`);
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('Release from main.');
if (git('status', '--porcelain', '--untracked-files=no')) fail('Commit or stash your changes first.');

// Only the version strings change, so each file keeps its own layout.
function setVersion(file, count = 1) {
  const p = path.join(root, file);
  let left = count;
  const text = readFileSync(p, 'utf8').replace(/("version": ")[^"]*(")/g, (m, a, b) => (left-- > 0 ? a + version + b : m));
  if (left > 0) fail(`Found fewer than ${count} versions in ${file}.`);
  writeFileSync(p, text);
}
setVersion('package.json');
setVersion('package-lock.json', 2); // the lock file's own and the root package's
setVersion('claude-plugin/.claude-plugin/plugin.json');
setVersion('claude-plugin/.codex-plugin/plugin.json');
setVersion('.claude-plugin/marketplace.json'); // its one plugin, mcp-docs
setVersion('installer/package.json');

git('add', 'package.json', 'package-lock.json', 'claude-plugin/.claude-plugin/plugin.json', 'claude-plugin/.codex-plugin/plugin.json', '.claude-plugin/marketplace.json', 'installer/package.json', notes);
git('commit', '-q', '-m', `Desktop ${version}, plugin ${version}`);
git('tag', tag);
console.log(`Committed and tagged ${tag}. To publish it:\n\n  git push origin main ${tag}\n`);
