// `flow-agent-bridge app publish <dir>`: uploads a hosted FreeFlow app's folder as a new version
// (docs/specs/user-apps.md §14 phase 2, step 5). The folder holds:
//
//   freeflow-app.json   the manifest, with "server": { "hosted": true }
//   server.js           the server: one ES module
//   migrations/*.sql    its tables, applied in name order (0001_tasks.sql, 0002_labels.sql, …)
//   ui/**               its screen's static files, with ui/index.html when the manifest has "ui": { "hosted": true }
//
// The version runs nowhere until an owner or admin installs it in Organization settings → Apps. Signs in with the agent's
// config (--config, default ./agent.json) or FLOW_SERVER_URL and FLOW_TOKEN (a person's or an agent's token).
import fs from 'node:fs';
import path from 'node:path';
import { FlowApi } from './api.js';
import { loadConfig } from './config.js';

export class AppPublishUsageError extends Error {}

/** The most a version may hold (the server checks again). */
const MAX_BYTES = 5_000_000;

/** The files of an app folder that a version holds, by their path in it, and the manifest. */
export function collectAppFolder(dir: string): { manifest: unknown; files: Record<string, Buffer> } {
  const manifestPath = path.join(dir, 'freeflow-app.json');
  if (!fs.existsSync(manifestPath)) throw new AppPublishUsageError(`${dir} has no freeflow-app.json`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new AppPublishUsageError(`freeflow-app.json is not JSON: ${(err as Error).message}`);
  }
  const files: Record<string, Buffer> = {};
  const server = path.join(dir, 'server.js');
  if (fs.existsSync(server)) files['server.js'] = fs.readFileSync(server);
  const migrations = path.join(dir, 'migrations');
  if (fs.existsSync(migrations)) {
    for (const f of fs.readdirSync(migrations).sort()) if (f.endsWith('.sql')) files[`migrations/${f}`] = fs.readFileSync(path.join(migrations, f));
  }
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const p = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) files[p] = fs.readFileSync(path.join(dir, p));
    }
  };
  if (fs.existsSync(path.join(dir, 'ui'))) walk('ui');
  if (!files['server.js']) throw new AppPublishUsageError(`${dir} has no server.js`);
  const total = Object.values(files).reduce((n, b) => n + b.byteLength, 0);
  if (total > MAX_BYTES) throw new AppPublishUsageError(`the app's files are ${total} bytes; a version holds at most ${MAX_BYTES}`);
  return { manifest, files };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Who to sign in as: the agent's config, else FLOW_SERVER_URL and FLOW_TOKEN (or FLOW_AGENT_TOKEN). */
function clientOf(args: string[]): FlowApi {
  const config = flag(args, 'config') ?? (fs.existsSync('agent.json') ? 'agent.json' : undefined);
  if (config) {
    const cfg = loadConfig(config);
    return new FlowApi(cfg.serverUrl, cfg.agentToken);
  }
  const server = (flag(args, 'server') ?? process.env.FLOW_SERVER_URL ?? '').replace(/\/+$/, '');
  const token = process.env.FLOW_TOKEN ?? process.env.FLOW_AGENT_TOKEN ?? '';
  if (!server || !token) throw new AppPublishUsageError('sign in with --config <agent.json>, or set FLOW_SERVER_URL and FLOW_TOKEN');
  return new FlowApi(server, token);
}

/** `app publish <dir> [--workspace <id>] [--config <agent.json>] [--server <url>]`. */
export async function runAppPublish(args: string[]): Promise<void> {
  const dir = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--')));
  if (!dir) throw new AppPublishUsageError('usage: flow-agent-bridge app publish <dir> [--workspace <id>] [--config <agent.json>]');
  const { manifest, files } = collectAppFolder(dir);
  const api = clientOf(args);
  let workspace = flag(args, 'workspace');
  if (!workspace) {
    const mine = await api.myWorkspaces();
    if (mine.length !== 1) throw new AppPublishUsageError(`name the organization with --workspace: you are in ${mine.length} (${mine.map((w) => `${w.name} ${w.id}`).join(', ')})`);
    workspace = mine[0]!.id;
  }
  const encoded = Object.fromEntries(Object.entries(files).map(([p, b]) => [p, b.toString('base64')]));
  const up = await api.publishAppVersion(workspace, manifest, encoded);
  console.log(`uploaded ${up.name} version ${up.version} (${Object.keys(files).length} files).`);
  console.log('An owner or admin installs or updates to it in Organization settings → Apps.');
}
