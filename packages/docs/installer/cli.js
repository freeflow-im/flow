#!/usr/bin/env node
// `npx @freeflow-im/mcp-docs`: install (or update) the MCP Docs desktop app from the latest GitHub release, then,
// for each coding agent found (Claude Code, Codex) that the person wants it for, the plugin that connects the agent
// to it: the claude-plugin folder of the same repository, which is both a Claude Code plugin (its marketplace is
// .claude-plugin/marketplace.json there) and a Codex plugin (.agents/plugins/marketplace.json). Any other MCP client
// can connect to the app's address itself. With --uninstall, remove all of it again: the app, its data and settings,
// and what it added to the agents.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REPO = 'freeflow-im/mcp-docs';
const APP_NAME = 'MCP Docs';
/** Windows (x64, which Windows on Arm runs too) or a Mac with Apple silicon. */
const WIN = process.platform === 'win32';
const ASSET = WIN ? /^MCP-Docs-(\d+\.\d+\.\d+)-win-x64-setup\.exe$/ : /^MCP-Docs-(\d+\.\d+\.\d+)-mac-arm64\.zip$/;
const EXE = `${APP_NAME}.exe`;
const MARKETPLACE = 'mcp-docs';
const PLUGIN = `mcp-docs@${MARKETPLACE}`;
/** The app's MCP server (desktop/main.js's fixed port), for any MCP client. */
const MCP_URL = 'http://127.0.0.1:39217/mcp';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);

if (flag('help') || flag('h') || args.some((a) => !a.startsWith('--'))) {
  console.log(`Usage: npx @freeflow-im/mcp-docs [--claude] [--codex] [--skip-app] [--skip-plugins] [--yes]
       npx @freeflow-im/mcp-docs --uninstall [--yes]

Installs the latest MCP Docs desktop app (on a Mac into /Applications or ~/Applications, on Windows into
%LOCALAPPDATA%\\Programs\\MCP Docs), and the mcp-docs plugin
into the coding agents you choose, Claude Code and Codex, which connects them to the app. It asks for each
agent it finds. Run it again to update them all. Any other MCP client can connect to the app at
${MCP_URL}.

  --claude        add the plugin to Claude Code (without asking; the other agents only if named too)
  --codex         add the plugin to Codex (likewise)
  --skip-app      only install or update the plugins
  --skip-plugins  only install or update the app
  --uninstall     remove the app, its data and settings (chats, API keys, connected agents), and the
                  mcp-docs plugin, marketplace and MCP server from Claude Code and Codex. Your documents,
                  in the folders you opened, are not touched. It lists what it will remove and asks first.
  --yes           do not ask: add the plugin to every agent found, or with --uninstall remove everything`);
  process.exit(args.some((a) => !a.startsWith('--')) ? 1 : 0);
}

const say = (msg) => console.log(msg);
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};
/** Run a program; its output is returned, not shown. */
const run = (cmd, argv) => spawnSync(cmd, argv, { encoding: 'utf8' });
/** Run a command found on the PATH, as a terminal would: on Windows the agents' commands are often `.cmd` scripts,
 * which only a shell runs (the arguments here have no spaces or quotes). */
const runCommand = (cmd, argv) => (WIN ? spawnSync([cmd, ...argv].join(' '), { encoding: 'utf8', shell: true }) : run(cmd, argv));

/** Where Windows installs the app: for the person (the installer's default), or for everyone. */
const winAppDirs = () => [path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'Programs', APP_NAME), path.join(process.env.ProgramFiles ?? 'C:\\Program Files', APP_NAME)];

/** Where the app goes: /Applications when it can be written to, else the person's own Applications folder. */
function appsDir() {
  try {
    accessSync('/Applications', constants.W_OK);
    return '/Applications';
  } catch {
    const own = path.join(homedir(), 'Applications');
    mkdirSync(own, { recursive: true });
    return own;
  }
}

/** The app already installed, in either place, and its version. On Windows `app` is its program. */
function installedApp() {
  if (WIN) {
    for (const dir of winAppDirs()) {
      const app = path.join(dir, EXE);
      if (!existsSync(app)) continue;
      let version = null;
      try {
        version = JSON.parse(readFileSync(path.join(dir, 'resources', 'app', 'package.json'), 'utf8')).version ?? null;
      } catch {
        // Unreadable: updated below as an older version.
      }
      return { app, version };
    }
    return null;
  }
  for (const dir of ['/Applications', path.join(homedir(), 'Applications')]) {
    const app = path.join(dir, `${APP_NAME}.app`);
    if (!existsSync(app)) continue;
    const r = run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]);
    return { app, version: r.status === 0 ? r.stdout.trim() : null };
  }
  return null;
}

/** The newest release of the desktop app: its version and the download of its zip. */
async function latestRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'mcp-docs-installer' } });
  if (!res.ok) fail(`Could not look up the latest release on GitHub (${res.status} ${res.statusText}).`);
  for (const release of await res.json()) {
    if (release.draft || release.prerelease) continue;
    for (const asset of release.assets ?? []) {
      const m = ASSET.exec(asset.name);
      if (m) return { version: m[1], url: asset.browser_download_url, name: asset.name, size: asset.size };
    }
  }
  fail(`No release of ${APP_NAME} for ${WIN ? 'Windows' : 'macOS'} was found on GitHub.`);
}

const appPids = (app) => {
  if (WIN) {
    // Every MCP Docs.exe, the app and the servers it starts for its folders (one installed copy is assumed).
    const r = run('tasklist', ['/FI', `IMAGENAME eq ${EXE}`, '/FO', 'CSV', '/NH']);
    return r.status === 0 ? [...r.stdout.matchAll(/^"[^"]+","(\d+)"/gm)].map((m) => m[1]) : [];
  }
  const r = run('pgrep', ['-f', `${app}/Contents/MacOS/`]);
  return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
};

/** Quit the running app (it saves as it goes) so it can be replaced or removed; waits up to 15 seconds. */
async function quitApp(app, why = 'to update it') {
  if (!appPids(app).length) return false;
  say(`  Quitting ${APP_NAME} ${why}…`);
  // On Windows its windows are asked to close, and it quits (and stops its servers) when the last one has.
  if (WIN) run('taskkill', ['/IM', EXE]);
  else run('osascript', ['-e', `tell application "${app}" to quit`]);
  for (let i = 0; i < 30 && appPids(app).length; i++) await new Promise((r) => setTimeout(r, 500));
  if (appPids(app).length) fail(`${APP_NAME} is still running. Quit it and run this again.`);
  return true;
}

async function installApp() {
  say(`\n${APP_NAME} app`);
  const latest = await latestRelease();
  const current = installedApp();
  if (current?.version === latest.version) {
    say(`  ${APP_NAME} ${latest.version} is installed (${current.app}).`);
    return current.app;
  }
  say(current ? `  Updating ${current.version ?? 'an older version'} to ${latest.version}…` : `  Installing ${APP_NAME} ${latest.version}…`);
  const work = mkdtempSync(path.join(tmpdir(), 'mcp-docs-'));
  try {
    const zip = path.join(work, latest.name);
    say(`  Downloading ${latest.name} (${Math.round(latest.size / 1e6)} MB)…`);
    const res = await fetch(latest.url);
    if (!res.ok || !res.body) fail(`The download failed (${res.status} ${res.statusText}).`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
    if (WIN) return await runWindowsSetup(zip, latest.version, current);
    const out = path.join(work, 'app');
    if (run('ditto', ['-x', '-k', zip, out]).status !== 0) fail('The download could not be unpacked.');
    const unpacked = path.join(out, `${APP_NAME}.app`);
    if (!existsSync(unpacked)) fail(`The download does not hold ${APP_NAME}.app.`);

    const app = current?.app ?? path.join(appsDir(), `${APP_NAME}.app`);
    const wasRunning = current ? await quitApp(app) : false;
    rmSync(app, { recursive: true, force: true });
    const copied = run('ditto', [unpacked, app]);
    if (copied.status !== 0) fail(`Could not put the app in ${path.dirname(app)}: ${copied.stderr.trim()}`);
    // Not notarized: without the quarantine mark macOS opens it without asking (a download made by this
    // script has none, but one copied over from a browser's download might).
    run('xattr', ['-dr', 'com.apple.quarantine', app]);
    say(`  Installed ${APP_NAME} ${latest.version} in ${path.dirname(app)}.`);
    if (wasRunning) say('  It was running: it starts again below.');
    return app;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Install the downloaded Windows setup program without its questions: for the person, or over the copy installed for
 * everyone (which asks Windows for permission). It closes a running app itself; returns the installed program.
 */
async function runWindowsSetup(setup, version, current) {
  const forAll = current && path.dirname(current.app) === winAppDirs()[1];
  const wasRunning = current ? await quitApp(current.app) : false;
  say('  Running the setup program…');
  const r = run(setup, ['/S', ...(forAll ? ['/allusers'] : [])]);
  const app = installedApp();
  if (r.status !== 0 || app?.version !== version) fail(`The setup program did not install ${APP_NAME} ${version}${r.status ? ` (exit code ${r.status})` : ''}. Run ${path.basename(setup)} from the release yourself: github.com/${REPO}/releases/latest`);
  say(`  Installed ${APP_NAME} ${version} in ${path.dirname(app.app)}.`);
  if (wasRunning) say('  It was running: it starts again below.');
  return app.app;
}

/** Run `claude` with these arguments, showing what it says when it fails. */
function claude(argv) {
  const r = runCommand('claude', argv);
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** Run `codex` with these arguments, as `claude` above. */
function codex(argv) {
  const r = runCommand('codex', argv);
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/**
 * The coding agents the plugin is for: their command, how to install it there (which says whether it was 'installed'
 * or 'updated'), and what to do next. An update keeps the agent's sign-in; only a new install needs one.
 */
const AGENTS = [
  {
    key: 'claude',
    name: 'Claude Code',
    found: () => runCommand('claude', ['--version']).status === 0,
    install: installClaudePlugin,
    next: {
      installed: 'In Claude Code: restart it (or start a new session) to load the plugin, then run /mcp, choose plugin:mcp-docs:mcp-docs and sign in.',
      updated: 'In Claude Code: restart it (or start a new session) to load the new version.',
    },
  },
  {
    key: 'codex',
    name: 'Codex',
    found: () => runCommand('codex', ['--version']).status === 0,
    install: installCodexPlugin,
    next: {
      installed: 'In Codex: sign in once with `codex mcp login mcp-docs`, then start a new session.',
      updated: 'In Codex: start a new session to load the new version.',
    },
  },
];

/** Ask a yes-or-no question; Enter is yes. */
async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return answer === '' || answer === 'y' || answer === 'yes';
}

/**
 * The agents to add the plugin to: the ones named (--claude, --codex), else each one found that the person
 * says yes to (all of them with --yes, or when there is no one to ask).
 */
async function chooseAgents() {
  const named = AGENTS.filter((a) => flag(a.key));
  const candidates = named.length ? named : AGENTS;
  const chosen = [];
  for (const agent of candidates) {
    if (!agent.found()) {
      if (named.length) say(`\n${agent.name} was not found (the \`${agent.key}\` command). Install it, then run \`npx @freeflow-im/mcp-docs --skip-app --${agent.key}\`.`);
      continue;
    }
    if (named.length || flag('yes') || !process.stdin.isTTY || (await confirm(`\nAdd the MCP Docs plugin to ${agent.name}?`))) chosen.push(agent);
  }
  return chosen;
}

function installClaudePlugin() {
  say('\nClaude Code plugin');
  const listed = claude(['plugin', 'marketplace', 'list', '--json']);
  let known = false;
  try {
    known = JSON.parse(listed.out).some((m) => m.name === MARKETPLACE);
  } catch {
    // Not JSON (an older Claude Code): add it, which says so if it is there already.
  }
  if (known) {
    const up = claude(['plugin', 'marketplace', 'update', MARKETPLACE]);
    if (!up.ok) say(`  Could not refresh the ${MARKETPLACE} marketplace: ${up.out}`);
  } else {
    // Only the plugin's folders are checked out, not the whole app.
    const add = claude(['plugin', 'marketplace', 'add', REPO, '--sparse', '.claude-plugin', 'claude-plugin']);
    if (!add.ok && !/already/i.test(add.out)) fail(`Could not add the ${MARKETPLACE} marketplace to Claude Code:\n${add.out}`);
  }

  const plugins = claude(['plugin', 'list', '--json']);
  let installed = false;
  try {
    installed = JSON.parse(plugins.out).some((p) => p.id === PLUGIN || `${p.name}@${p.marketplace}` === PLUGIN);
  } catch {
    installed = plugins.out.includes(PLUGIN);
  }
  const step = installed ? claude(['plugin', 'update', PLUGIN]) : claude(['plugin', 'install', PLUGIN]);
  if (!step.ok) fail(`Could not ${installed ? 'update' : 'install'} the ${PLUGIN} plugin:\n${step.out}`);
  say(`  ${installed ? 'Updated' : 'Installed'} the ${PLUGIN} plugin.`);

  // A server added by hand earlier (File › Connect an Agent's command) would be a second copy of the plugin's.
  if (claude(['mcp', 'get', 'mcp-docs']).ok) {
    say('  You also added the mcp-docs server by hand before. The plugin has its own now; remove that one with:');
    say('    claude mcp remove mcp-docs --scope user');
  }
  return installed ? 'updated' : 'installed';
}

function installCodexPlugin() {
  say('\nCodex plugin');
  let known = false;
  try {
    known = JSON.parse(codex(['plugin', 'marketplace', 'list', '--json']).out).marketplaces.some((m) => m.name === MARKETPLACE);
  } catch {
    // Unreadable: add it, which says so if it is there already.
  }
  if (known) {
    const up = codex(['plugin', 'marketplace', 'upgrade', MARKETPLACE]);
    if (!up.ok) say(`  Could not refresh the ${MARKETPLACE} marketplace: ${up.out}`);
  } else {
    // Only the plugin's folders are checked out, not the whole app.
    const add = codex(['plugin', 'marketplace', 'add', REPO, '--sparse', '.agents', '--sparse', 'claude-plugin']);
    if (!add.ok && !/already/i.test(add.out)) fail(`Could not add the ${MARKETPLACE} marketplace to Codex:\n${add.out}`);
  }
  let installed = false;
  try {
    installed = JSON.parse(codex(['plugin', 'list', '--json']).out).installed.some((p) => p.pluginId === PLUGIN);
  } catch {
    // Added below either way: adding it again installs the marketplace's version.
  }
  const step = codex(['plugin', 'add', PLUGIN]);
  if (!step.ok) fail(`Could not ${installed ? 'update' : 'install'} the ${PLUGIN} plugin in Codex:\n${step.out}`);
  say(`  ${installed ? 'Updated' : 'Installed'} the ${PLUGIN} plugin.`);
  return installed ? 'updated' : 'installed';
}

// --- Uninstall ------------------------------------------------------------------------------------------

/**
 * Where the app keeps its own things: its data folder (chats, settings with the API keys, connected agents'
 * tokens, each folder's index, deleted files), under each name it has had, and macOS's files for it.
 */
function appData() {
  if (WIN) {
    const roaming = process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming');
    return ['MCP Docs', 'Universal Docs', 'FreeFlow Docs'].map((name) => path.join(roaming, name)).filter((p) => existsSync(p));
  }
  const lib = path.join(homedir(), 'Library');
  const BUNDLE_ID = 'im.freeflow.docs';
  return [
    ...['MCP Docs', 'Universal Docs', 'FreeFlow Docs'].map((name) => path.join(lib, 'Application Support', name)),
    path.join(lib, 'Preferences', `${BUNDLE_ID}.plist`),
    path.join(lib, 'Saved Application State', `${BUNDLE_ID}.savedState`),
    path.join(lib, 'Caches', BUNDLE_ID),
    path.join(lib, 'HTTPStorages', BUNDLE_ID),
    path.join(lib, 'Logs', APP_NAME),
  ].filter((p) => existsSync(p));
}

/** The apps installed, in either place (on Windows, their programs). */
const installedApps = () =>
  (WIN ? winAppDirs().map((dir) => path.join(dir, EXE)) : ['/Applications', path.join(homedir(), 'Applications')].map((dir) => path.join(dir, `${APP_NAME}.app`))).filter((p) => existsSync(p));

/** What it added to Claude Code: the plugin, its marketplace, and an MCP server added by hand (by either name it has had). */
function claudeThings() {
  if (runCommand('claude', ['--version']).status !== 0) return { plugin: false, marketplace: false, servers: [] };
  let plugin = false;
  let marketplace = false;
  try {
    plugin = JSON.parse(claude(['plugin', 'list', '--json']).out).some((p) => p.id === PLUGIN);
  } catch {
    // An older Claude Code: tried below anyway.
    plugin = true;
  }
  try {
    marketplace = JSON.parse(claude(['plugin', 'marketplace', 'list', '--json']).out).some((m) => m.name === MARKETPLACE);
  } catch {
    marketplace = true;
  }
  const servers = ['mcp-docs', 'universal-local'].filter((name) => claude(['mcp', 'get', name]).ok);
  return { plugin, marketplace, servers };
}

/** What it added to Codex: the plugin and its marketplace. */
function codexThings() {
  if (runCommand('codex', ['--version']).status !== 0) return { plugin: false, marketplace: false };
  let plugin = false;
  let marketplace = false;
  try {
    plugin = JSON.parse(codex(['plugin', 'list', '--json']).out).installed.some((p) => p.pluginId === PLUGIN);
  } catch {
    plugin = false;
  }
  try {
    marketplace = JSON.parse(codex(['plugin', 'marketplace', 'list', '--json']).out).marketplaces.some((m) => m.name === MARKETPLACE);
  } catch {
    marketplace = false;
  }
  return { plugin, marketplace };
}

async function uninstall() {
  const apps = installedApps();
  const data = appData();
  const fromClaude = claudeThings();
  const fromCodex = codexThings();
  const lines = [
    ...apps.map((a) => `  the app: ${a}`),
    ...data.map((d) => `  its data: ${d.replace(homedir(), '~')}`),
    ...(fromClaude.plugin ? [`  the ${PLUGIN} plugin in Claude Code`] : []),
    ...(fromClaude.marketplace ? [`  the ${MARKETPLACE} plugin marketplace in Claude Code`] : []),
    ...fromClaude.servers.map((s) => `  the ${s} MCP server in Claude Code`),
    ...(fromCodex.plugin ? [`  the ${PLUGIN} plugin in Codex`] : []),
    ...(fromCodex.marketplace ? [`  the ${MARKETPLACE} plugin marketplace in Codex`] : []),
  ];
  if (!lines.length) {
    say(`\nThere is nothing of ${APP_NAME} to remove.`);
    return;
  }
  say(`\nThis removes:\n${lines.join('\n')}\n\nThe data holds your assistant chats, settings (API keys too) and connected agents. Your documents, in the folders you opened, are not touched.`);
  if (!flag('yes')) {
    if (!process.stdin.isTTY) fail('Run it with --yes to remove these without being asked.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('\nRemove them? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      say('Nothing was removed.');
      return;
    }
  }

  for (const app of apps) {
    await quitApp(app, 'to remove it');
    if (WIN) {
      // Its own uninstaller, which also takes it off Settings › Apps and the Start menu.
      const dir = path.dirname(app);
      const r = run(path.join(dir, `Uninstall ${APP_NAME}.exe`), ['/S', ...(dir === winAppDirs()[1] ? ['/allusers'] : [])]);
      say(r.status === 0 ? `  Removed ${dir}` : `  Could not remove ${dir}: uninstall ${APP_NAME} in Settings › Apps instead.`);
      continue;
    }
    rmSync(app, { recursive: true, force: true });
    say(`  Removed ${app}`);
  }
  for (const d of data) {
    rmSync(d, { recursive: true, force: true });
    say(`  Removed ${d.replace(homedir(), '~')}`);
  }
  if (fromClaude.plugin) {
    const r = claude(['plugin', 'uninstall', PLUGIN]);
    say(r.ok ? `  Uninstalled the ${PLUGIN} plugin from Claude Code` : `  Could not uninstall the ${PLUGIN} plugin from Claude Code: ${r.out}`);
  }
  if (fromClaude.marketplace) {
    const r = claude(['plugin', 'marketplace', 'remove', MARKETPLACE]);
    say(r.ok ? `  Removed the ${MARKETPLACE} marketplace from Claude Code` : `  Could not remove the ${MARKETPLACE} marketplace from Claude Code: ${r.out}`);
  }
  for (const s of fromClaude.servers) {
    // Added for the user (File › Connect an Agent's command), or for one project.
    const r = claude(['mcp', 'remove', s, '--scope', 'user']).ok ? { ok: true } : claude(['mcp', 'remove', s]);
    say(r.ok ? `  Removed the ${s} MCP server` : `  Could not remove the ${s} MCP server: ${r.out}`);
  }
  if (fromCodex.plugin) {
    const r = codex(['plugin', 'remove', PLUGIN]);
    say(r.ok ? `  Uninstalled the ${PLUGIN} plugin from Codex` : `  Could not uninstall the ${PLUGIN} plugin from Codex: ${r.out}`);
  }
  if (fromCodex.marketplace) {
    const r = codex(['plugin', 'marketplace', 'remove', MARKETPLACE]);
    say(r.ok ? `  Removed the ${MARKETPLACE} marketplace from Codex` : `  Could not remove the ${MARKETPLACE} marketplace from Codex: ${r.out}`);
  }
  say(`\n${APP_NAME} is uninstalled. Restart Claude Code and Codex to let go of the plugin.`);
}

if (!WIN && (process.platform !== 'darwin' || process.arch !== 'arm64')) {
  fail(`${APP_NAME} is only available for Windows and Macs with Apple silicon so far.`);
}

if (flag('uninstall')) {
  say(`MCP Docs uninstaller (${REPO})`);
  await uninstall();
  process.exit(0);
}

say(`MCP Docs installer (${REPO})`);
const app = flag('skip-app') ? installedApp()?.app : await installApp();
// --skip-plugin is the flag's name before Codex.
const agents = flag('skip-plugins') || flag('skip-plugin') ? [] : await chooseAgents();
const done = agents.map((agent) => ({ agent, step: agent.install() }));

if (app && !appPids(app).length) {
  // The MCP server is the running app.
  if (WIN) spawn(app, [], { detached: true, stdio: 'ignore' }).unref();
  else run('open', ['-a', app]);
  say(`\nStarted ${APP_NAME}.`);
}
say(`
While ${APP_NAME} is running, its MCP server is at ${MCP_URL}. Any MCP client on this computer that
supports streamable HTTP and OAuth can connect to it there; ${APP_NAME} asks you to allow each one.`);
if (done.length) say(`\nNext:\n${done.map(({ agent, step }) => `  - ${agent.next[step]}`).join('\n')}`);
