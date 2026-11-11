// Interactive first-run setup (AGENT_MEMBERS.md): onboard the agent with a
// one-time invite code and hand back a ready-to-run agent.json. The streamlined
// flow (phase 15) asks only what a person must decide — the invite code (usually
// passed as the positional arg), then agent name, handle, harness — and redeems
// the code to join immediately (no sponsor approval; the code carries the
// sponsor + workspace). Everything else (server URL, an existing token to
// reuse, a description, the working directory) has a sensible default and is
// overridable with a CLI flag. Advanced knobs (permissionMode, allowedTools,
// eventScope, …) are edited in the saved file.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { FlowApi, newAgentKey, redeemAgentInvite } from './api.js';
import { expandHome } from './config.js';

/** Optional values that skip their prompt when supplied as CLI flags. */
export interface SetupOptions {
  serverUrl?: string | undefined; // --server / --host
  token?: string | undefined; // --token: reuse an existing agent, skip onboarding
  invite?: string | undefined; // the invite code (positional arg or --invite)
  name?: string | undefined; // --name
  username?: string | undefined; // --username / --handle
  harness?: string | undefined; // --harness / --runtime
  description?: string | undefined; // --description
  cwd?: string | undefined; // --cwd
}

const HARNESSES = ['claude', 'codex', 'demo'];
const INVITE_CODE_RE = /^flow-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

async function ask(rl: readline.Interface, q: string, def?: string): Promise<string> {
  const suffix = def ? ` [${def}]` : '';
  const answer = (await rl.question(`${q}${suffix}: `)).trim();
  return answer || def || '';
}

/** Best-effort username from the display name: "Repo Bot!" → "repo-bot". */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 32);
}

/**
 * `agent.example.json` next to the target config: committed defaults for this
 * agent's home. Setup merges it under the freshly minted credentials, so a
 * folder can carry the whole persona (runtime.systemPromptExtra, eventScope,
 * respondToAgents, …) and the wizard fills in only what onboarding creates.
 * The extra keys `name`, `username`, and `description` seed the matching
 * prompts (making a bare `npx flow-agent-bridge <code>` fully non-interactive)
 * and are stripped from the written agent.json; `runtime.kind` and
 * `runtime.cwd` seed the harness and working-directory answers.
 */
export function loadTemplate(configPath: string): Record<string, unknown> | null {
  const p = path.join(path.dirname(path.resolve(configPath)), 'agent.example.json');
  if (!fs.existsSync(p)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`could not read ${p}: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${p} must contain a JSON object`);
  }
  return raw as Record<string, unknown>;
}

export async function runSetup(configPath: string, opts: SetupOptions = {}): Promise<string> {
  const template = loadTemplate(configPath);
  const t = (k: string): string | undefined =>
    typeof template?.[k] === 'string' ? (template[k] as string) : undefined;
  const tRuntime = (template?.runtime && typeof template.runtime === 'object' ? template.runtime : {}) as Record<
    string,
    unknown
  >;
  const tr = (k: string): string | undefined => (typeof tRuntime[k] === 'string' ? (tRuntime[k] as string) : undefined);
  const serverUrl = (opts.serverUrl ?? process.env.FLOW_SERVER_URL ?? t('serverUrl') ?? 'https://app.freeflow.im').replace(/\/+$/, '');
  const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;

  // A required value: take the flag if given (validated), otherwise prompt.
  // Without a TTY and without the flag there is no way to obtain it.
  async function required(
    provided: string | undefined,
    label: string,
    opt: { def?: string; normalize?: (s: string) => string; validate?: (s: string) => boolean } = {},
  ): Promise<string> {
    const norm = opt.normalize ?? ((s: string) => s);
    if (provided !== undefined) {
      const v = norm(provided);
      if (opt.validate && !opt.validate(v)) throw new Error(`invalid value for ${label}: "${provided}"`);
      return v;
    }
    if (!rl) throw new Error(`no config at ${configPath} and stdin is not a TTY — pass the setup flags or run interactively`);
    let v = '';
    do {
      v = norm(await ask(rl, label, opt.def));
    } while (!v || (opt.validate ? !opt.validate(v) : false));
    return v;
  }

  try {
    console.log('Setting up your Flow agent.\n');
    if (template) console.log('Using defaults from agent.example.json.\n');

    let agentToken: string;
    let agentUsername: string | undefined;
    let agentKey: string | undefined;
    let kind: string;
    // #357: the slug of the workspace this config serves, written into agent.json.
    let workspaceSlug: string | undefined;

    if (opts.token) {
      // Reuse an existing agent: validate the token and skip registration.
      console.log('Verifying the agent token…');
      const api = new FlowApi(serverUrl, opts.token);
      const [me, wss] = await Promise.all([api.me(), api.myWorkspaces()]);
      console.log(`Reconnecting as existing agent ${me.displayName} <@${me.id}>.\n`);
      // One process serves one workspace (#357). With exactly one there is
      // nothing to choose; with several, say so rather than picking silently —
      // the daemon would refuse to start on an unset `workspace` anyway.
      if (wss.length === 1) workspaceSlug = wss[0]!.slug;
      else if (wss.length > 1) {
        console.log(
          `This agent is in ${wss.length} workspaces (${wss.map((w) => w.slug).join(', ')}) — ` +
            `set "workspace" in the saved config to the one this process should serve.\n`,
        );
      }
      agentToken = opts.token;
      kind = await required(opts.harness ?? tr('kind'), 'Agent harness — claude, codex, or demo', {
        def: 'claude',
        normalize: (s) => s.toLowerCase(),
        validate: (s) => HARNESSES.includes(s),
      });
    } else {
      // Redeem a one-time invite code (phase 15). The code (usually the
      // positional arg) carries the sponsor + workspace; ask only name, handle,
      // and harness, then join immediately — no approval.
      const code = await required(opts.invite, 'Invite code (generate one in Flow → “Invite your Agent”)', {
        normalize: (s) => s.trim(),
        validate: (s) => INVITE_CODE_RE.test(s),
      });
      const name = await required(opts.name ?? t('name'), 'Agent name (shown in Flow, e.g. RepoBot)');
      const username = await required(opts.username ?? t('username'), 'Handle (the agent’s @username — its durable login)', {
        def: slugify(name),
        normalize: (s) => s.toLowerCase(),
        validate: (s) => /^[a-z0-9][a-z0-9._-]{2,31}$/.test(s),
      });
      kind = await required(opts.harness ?? tr('kind'), 'Agent harness — claude, codex, or demo', {
        def: 'claude',
        normalize: (s) => s.toLowerCase(),
        validate: (s) => HARNESSES.includes(s),
      });
      const description = opts.description ?? t('description') ?? '';

      const key = newAgentKey();
      console.log('\nJoining the workspace…');
      const res = await redeemAgentInvite(serverUrl, {
        code,
        username,
        key,
        name,
        ...(description ? { description } : {}),
      });
      console.log(`\njoined as ${res.user.displayName} <@${res.user.id}> in workspace "${res.workspace.name}"\n`);
      agentToken = res.agentToken;
      agentUsername = username;
      agentKey = key;
      workspaceSlug = res.workspace.slug;
    }

    // Template values first, credentials and resolved answers on top — so an
    // agent.example.json carries everything but what onboarding mints.
    const config: Record<string, unknown> = {
      ...(template ?? {}),
      serverUrl,
      agentToken,
      // username + key are the agent's durable credentials: `flow-agent-bridge
      // login` re-mints a token from them if agent.json's token is ever lost.
      ...(agentUsername ? { agentUsername } : {}),
      ...(agentKey ? { agentKey } : {}),
      // #357: name the workspace this process serves. Harmless while the agent
      // is in one, and the thing that stops startup failing the day someone
      // invites it into a second from its profile popup.
      ...(workspaceSlug ? { workspace: workspaceSlug } : {}),
      runtime: { ...tRuntime, kind } as Record<string, unknown>,
    };
    // Prompt-seed keys, not config keys.
    delete config.name;
    delete config.username;
    delete config.description;
    if (kind !== 'demo') {
      // Optional; defaults to the template's runtime.cwd, then to where
      // `npx flow-agent-bridge` was run (usually the repo checkout that IS the
      // agent's identity). --cwd overrides.
      const cwd = path.resolve(expandHome(opts.cwd ?? tr('cwd') ?? '.'));
      if (!fs.existsSync(cwd)) throw new Error(`working directory does not exist: ${cwd} (pass --cwd)`);
      (config.runtime as Record<string, unknown>).cwd = cwd;
      // No allowedTools written: the default is full permissions in the cwd
      // (operator ruling) — add allowedTools/permissionMode to the saved config
      // to scope the agent down.
    }

    const abs = path.resolve(configPath);
    fs.writeFileSync(abs, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    console.log(`Saved ${abs} (contains the agent token and key — keep it private).`);
    console.log('Starting the agent — edit the config any time for permissions, scope, etc. (see AGENT_MEMBERS.md).\n');
    return abs;
  } finally {
    rl?.close();
  }
}
