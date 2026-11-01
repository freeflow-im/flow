// Check for Updates… (the app menu on macOS, Help on Windows): looks up the newest release on GitHub, downloads it
// and installs it over the running app, as `npx @freeflow-im/mcp-docs` does (installer/cli.js), then starts it again.
// The Mac app is not signed with a Developer ID, so Electron's own updater (Squirrel) cannot be used: on macOS the
// new app is unpacked beside the old one and swapped in by a small script once the app has quit; on Windows the
// release's setup program runs without its questions and starts the app when it is done.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REPO = 'freeflow-im/mcp-docs';
const APP_NAME = 'MCP Docs';

/** The release file for a platform: the Mac zip (Apple silicon) or the Windows setup program. */
export const assetPattern = (platform) => (platform === 'win32' ? /^MCP-Docs-(\d+\.\d+\.\d+)-win-x64-setup\.exe$/ : /^MCP-Docs-(\d+\.\d+\.\d+)-mac-arm64\.zip$/);

/** Whether version `a` (x.y.z) is newer than `b`. */
export function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/**
 * The newest release with a file for `platform`, from GitHub's list of releases (newest first), or null.
 * @returns {{ version: string, url: string, name: string, size: number, page: string } | null}
 */
export function latestFor(releases, platform) {
  const pattern = assetPattern(platform);
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    for (const asset of release.assets ?? []) {
      const m = pattern.exec(asset.name);
      if (m) return { version: m[1], url: asset.browser_download_url, name: asset.name, size: asset.size, page: release.html_url };
    }
  }
  return null;
}

/**
 * The updater, over Electron's `app`, `dialog` and `shell`. `onProgress` is told the download's progress (0 to 1),
 * and null when it is over, for the menu and the windows' progress bars.
 * @param {{ app: Electron.App, dialog: Electron.Dialog, shell: Electron.Shell, onProgress: (fraction: number | null) => void }} electron
 */
export function createUpdater({ app, dialog, shell, onProgress }) {
  let busy = false;
  const mac = process.platform === 'darwin';
  const message = (options) => dialog.showMessageBox({ title: APP_NAME, ...options });

  async function latest() {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'mcp-docs-app' } });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}.`);
    return latestFor(await res.json(), process.platform);
  }

  /** Download `release`'s file to `file`, telling `onProgress` as it goes. */
  async function download(release, file) {
    const res = await fetch(release.url);
    if (!res.ok || !res.body) throw new Error(`The download failed (${res.status} ${res.statusText}).`);
    const total = Number(res.headers.get('content-length')) || release.size;
    let got = 0;
    let shown = -1;
    const count = new Transform({
      transform(chunk, _enc, done) {
        got += chunk.length;
        const pct = Math.floor((got / total) * 100);
        if (pct !== shown) onProgress(Math.min(1, got / total));
        shown = pct;
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), count, createWriteStream(file));
  }

  /** The app bundle this copy runs from (…/MCP Docs.app), on macOS. */
  const bundle = () => path.resolve(app.getPath('exe'), '..', '..', '..');

  /**
   * Unpack the downloaded zip beside the running app, then quit; a detached script swaps it in once the app has
   * gone and opens it. Nothing changes if the app does not quit within a minute (a window refused to close).
   */
  function installMac(zip) {
    const current = bundle();
    const dir = path.dirname(current);
    const stage = path.join(dir, `.${APP_NAME} update`);
    rmSync(stage, { recursive: true, force: true });
    const r = spawnSync('ditto', ['-x', '-k', zip, stage], { encoding: 'utf8' });
    const unpacked = path.join(stage, `${APP_NAME}.app`);
    if (r.status !== 0 || !existsSync(unpacked)) {
      rmSync(stage, { recursive: true, force: true });
      throw new Error(`The download could not be unpacked${r.stderr ? `: ${r.stderr.trim()}` : '.'}`);
    }
    // Not notarized: without the quarantine mark macOS opens it without asking (a download made here has none).
    spawnSync('xattr', ['-dr', 'com.apple.quarantine', unpacked]);
    const script = [
      'for i in $(seq 1 600); do kill -0 "$1" 2>/dev/null || break; sleep 0.1; done',
      'if kill -0 "$1" 2>/dev/null; then rm -rf "$3"; exit 1; fi',
      'rm -rf "$2" && mv "$3/MCP Docs.app" "$2"',
      'rm -rf "$3"',
      'open "$2"',
    ].join('\n');
    spawn('/bin/sh', ['-c', script, 'mcp-docs-update', String(process.pid), current, stage], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
  }

  /** Run the setup program without its questions (for everyone, which Windows asks permission for, when the app is
   * installed so), and quit for it; `--force-run` has it start the app when it is done. */
  function installWindows(setup) {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const forAll = app.getPath('exe').toLowerCase().startsWith(programFiles.toLowerCase() + path.sep);
    spawn(setup, ['/S', '--force-run', ...(forAll ? ['/allusers'] : [])], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
  }

  /** Whether this copy can replace itself: the installed app, in a folder it can write to (macOS). */
  function canInstall() {
    if (!app.isPackaged) return 'This copy of the app runs from its project folder: update it there (git pull, npm run desktop).';
    if (mac) {
      if (!bundle().endsWith('.app')) return 'The app could not find where it is installed.';
      try {
        accessSync(path.dirname(bundle()), constants.W_OK);
      } catch {
        return `The app cannot write to ${path.dirname(bundle())}, where it is installed.`;
      }
    }
    return null;
  }

  /** Check for a newer release and, if the person wants, download and install it. */
  async function check() {
    if (busy) return;
    busy = true;
    try {
      const current = app.getVersion();
      let release;
      try {
        release = await latest();
      } catch (e) {
        await message({ type: 'error', message: 'Could not check for updates.', detail: String(e.message ?? e) });
        return;
      }
      if (!release || !isNewer(release.version, current)) {
        await message({ type: 'info', message: `${APP_NAME} is up to date.`, detail: `You have version ${current}, the newest.` });
        return;
      }
      const cannot = canInstall();
      const size = `${Math.round(release.size / 1e6)} MB`;
      const ask = await message({
        type: 'info',
        message: `${APP_NAME} ${release.version} is available.`,
        detail: `You have version ${current}.${cannot ? `\n\n${cannot}` : ` Download it (${size}) and restart ${APP_NAME} to install it? Your files are saved as you go.`}`,
        buttons: cannot ? ['Release Notes', 'Close'] : ['Download and Install', 'Release Notes', 'Later'],
        defaultId: 0,
        cancelId: cannot ? 1 : 2,
      });
      const notes = cannot ? 0 : 1;
      if (ask.response === notes) void shell.openExternal(release.page);
      if (cannot || ask.response !== 0) return;

      const work = path.join(app.getPath('temp'), 'mcp-docs-update');
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      const file = path.join(work, release.name);
      try {
        onProgress(0);
        await download(release, file);
      } catch (e) {
        await message({ type: 'error', message: 'The update could not be downloaded.', detail: String(e.message ?? e) });
        return;
      } finally {
        onProgress(null);
      }
      const go = await message({
        type: 'info',
        message: `${APP_NAME} ${release.version} is ready to install.`,
        detail: `${APP_NAME} quits, installs it and starts again.`,
        buttons: ['Restart Now', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      if (go.response !== 0) return;
      try {
        if (mac) installMac(file);
        else installWindows(file);
      } catch (e) {
        await message({ type: 'error', message: 'The update could not be installed.', detail: String(e.message ?? e) });
      }
    } finally {
      busy = false;
    }
  }

  return { check };
}
