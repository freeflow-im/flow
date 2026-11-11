#!/usr/bin/env node
// flow-agent-bridge CLI:
//   flow-agent-bridge <invite-code>         the one command: redeem a one-time
//                                           invite code (generated in Flow →
//                                           “Invite your Agent”). Streamlined
//                                           setup asks name, handle, harness →
//                                           joins immediately → save, then runs
//                                           the daemon. Default config: ./agent.json
//   flow-agent-bridge [config.json]         if the config exists, run the daemon;
//                                           if not, run setup (prompts for the
//                                           invite code) then run.
//                                           Skip any prompt with a flag:
//                                           --invite --name --handle --harness
//                                           --server --token --description --cwd
//   flow-agent-bridge run <config.json>     start the daemon (no setup)
//   flow-agent-bridge login --server <url> --username <handle> --key <secret>
//   (mints a fresh agent token, revoking the old one — the lost-agent.json path)
//   flow-agent-bridge mcp-init [config.json]
//   (write ./.mcp.json so MCP clients like the claude CLI load the flow server directly)
//   flow-agent-bridge app-guard --upstream http://localhost:3000 --port 8788
//   (put an agent-hosted web app behind Flow membership; secret in FLOW_APP_SECRET)
//   flow-agent-bridge mcp                   (internal) the flow MCP stdio server
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { AgentBridge } from './bridge.js';
import { agentLogin } from './api.js';
import { runMcpServer } from './mcp-server.js';
import { runMcpInit } from './mcp-init.js';
import { runSetup, type SetupOptions } from './setup.js';
import { runSupervisor } from './supervisor.js';
import { AppGuardUsageError, runAppGuard } from './app-guard-cli.js';

/** An invite code positional (`flow-XXXX-XXXX`), told apart from a config path. */
const INVITE_CODE_RE = /^flow-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

function usage(): never {
  console.error(
    'usage:\n' +
      '  flow-agent-bridge <invite-code>      redeem an invite (from Flow) + run — default ./agent.json\n' +
      '  flow-agent-bridge [config.json]      setup (if missing) + run — default ./agent.json\n' +
      '      setup flags (skip a prompt): --invite --name --handle --harness\n' +
      '                                   --server --token --description --cwd\n' +
      '  flow-agent-bridge run <config.json>\n' +
      '  flow-agent-bridge login --server <url> --username <handle> --key <secret>\n' +
      '  flow-agent-bridge mcp-init [config.json]   write ./.mcp.json for MCP clients (claude CLI)\n' +
      '  flow-agent-bridge app-guard --upstream <url> [--port 8788] [--host 0.0.0.0]\n' +
      '      only Flow members of the app’s channel reach it; FLOW_APP_SECRET holds the\n' +
      '      secret create_artifact returned (comma-separate several). Tunnel this port.\n',
  );
  process.exit(2);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Non-flag tokens (flags all take a value, so skip `--x val` pairs). */
function allPositionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) i++; // skip the flag's value too
    else out.push(a);
  }
  return out;
}

function parseSetupOptions(args: string[], invite?: string): SetupOptions {
  return {
    serverUrl: flag(args, 'server') ?? flag(args, 'host'),
    token: flag(args, 'token'),
    invite: invite ?? flag(args, 'invite'),
    name: flag(args, 'name'),
    username: flag(args, 'username') ?? flag(args, 'handle'),
    harness: flag(args, 'harness') ?? flag(args, 'runtime'),
    description: flag(args, 'description'),
    cwd: flag(args, 'cwd'),
  };
}

async function startDaemon(configPath: string): Promise<void> {
  // The default entry supervises: the daemon runs as a child so `/update` and
  // `/restart` (exit codes 88/87) can relaunch it — a process can't replace
  // its own code. The child re-enters here with the env flag set.
  if (process.env.FLOW_BRIDGE_SUPERVISED !== '1') return runSupervisor(configPath);
  const cfg = loadConfig(configPath);
  const bridge = new AgentBridge(cfg);
  await bridge.start();
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // A failed network leave must not trap the supervisor during shutdown.
    const forceExit = setTimeout(() => process.exit(0), 2_000);
    forceExit.unref();
    void bridge.stop().finally(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'mcp') return runMcpServer();
  if (cmd === 'mcp-init') return runMcpInit(rest[0] ?? 'agent.json');
  // The guard is a standalone server, not a bridge daemon: no config, no Flow
  // connection — verification is offline (docs/design/MINI_APPS.md).
  if (cmd === 'app-guard') {
    try {
      return await runAppGuard(rest);
    } catch (err) {
      if (err instanceof AppGuardUsageError) {
        console.error(err.message);
        process.exit(2);
      }
      throw err;
    }
  }
  if (cmd === 'login') {
    const server = flag(rest, 'server');
    const username = flag(rest, 'username');
    const key = flag(rest, 'key');
    if (!server || !username || !key) usage();
    const res = await agentLogin(server, username, key);
    console.log(`logged in as ${res.user.displayName} <@${res.user.id}>`);
    console.log('fresh agent token (the previous token is now revoked):');
    console.log(`  ${res.agentToken}`);
    return;
  }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') usage();
  // `run <config>` starts the daemon on an existing config — no setup.
  if (cmd === 'run') {
    const configPath = rest[0];
    if (!configPath) usage();
    return startDaemon(configPath);
  }
  // Default path: setup (if the config is missing) + run. A positional that
  // looks like an invite code (`flow-XXXX-XXXX`) is the invite; any other
  // positional is the config path (default ./agent.json). Everything else is a
  // setup flag, so `npx flow-agent-bridge flow-K7P2-9QMR --harness codex` works bare.
  const args = cmd === undefined ? [] : [cmd, ...rest];
  const positionals = allPositionals(args);
  const invite = positionals.find((p) => INVITE_CODE_RE.test(p));
  const configPath = positionals.find((p) => p !== invite) ?? 'agent.json';
  if (!fs.existsSync(configPath)) await runSetup(configPath, parseSetupOptions(args, invite));
  return startDaemon(configPath);
}

main().catch((err: Error) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
