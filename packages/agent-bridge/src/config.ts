// Bridge configuration (AGENTS_DESIGN.md): JSON file, one agent per config.
// (The spec allows "agent.toml or JSON"; the bridge ships JSON — no TOML
// parser in Node's stdlib, and one less dependency.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** "~" / "~/x" → the user's home (shells don't expand ~ inside JSON configs or wizard answers). */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

export type ProgressMode = 'thinking' | 'typing' | 'silent';
export type EventScope = 'mentions' | 'all';
export type RuntimeKind = 'claude' | 'codex' | 'demo';

export interface VoiceConfig {
  /** Answer DM huddle invites as this agent. */
  enabled: boolean;
  /** LiveKit Inference speech-to-text model. */
  sttModel: string;
  /** LiveKit Inference text-to-speech model. */
  ttsModel: string;
  /** Voice understood by the selected text-to-speech model. */
  ttsVoice: string;
  /** LiveKit Cloud agent inference gateway. */
  inferenceUrl: string;
  /** Hard ceiling for one live call. */
  maxSessionMinutes: number;
  /** Extra voice-only persona or conversational guidance. */
  instructions?: string | undefined;
}

export function defaultVoiceConfig(): VoiceConfig {
  return {
    enabled: true,
    sttModel: process.env.FLOW_VOICE_STT_MODEL?.trim() || 'deepgram/flux-general-en',
    ttsModel: process.env.FLOW_VOICE_TTS_MODEL?.trim() || 'inworld/inworld-tts-2',
    ttsVoice: process.env.FLOW_VOICE_TTS_VOICE?.trim() || 'Ashley',
    inferenceUrl:
      process.env.FLOW_VOICE_INFERENCE_URL?.trim() || 'https://agent-gateway.livekit.cloud/v1',
    maxSessionMinutes: 60,
  };
}

export interface RuntimeConfig {
  /**
   * 'claude' (rich: sessions, stream-json thinking steps, MCP),
   * 'codex' (baseline stdout contract; voice supplies transcript continuity), or
   * 'demo' (no CLI at all — always replies "Your message was received";
   * exercises the full event→reply pipeline for local testing).
   */
  kind: RuntimeKind;
  /** Executable override (default: the kind's CLI name). A fake runtime script works here for tests. */
  command: string;
  /** --model passthrough (claude), e.g. "sonnet", "opus", "haiku", or a full model id. Unset = the CLI's default. */
  model?: string | undefined;
  /** Extra args appended verbatim before the prompt. */
  extraArgs: string[];
  /** Working directory the CLI runs in — the agent's identity (a repo checkout). */
  cwd: string;
  /** --permission-mode passthrough (claude). Headless runs use pre-granted permissions — scope them. */
  permissionMode?: string | undefined;
  /** --allowedTools passthrough (claude), e.g. ["Read", "Bash(pnpm test)"]. */
  allowedTools: string[];
  /** --max-turns cap (claude). */
  maxTurns: number;
  /**
   * Absolute wall-clock cap per run, seconds — the runaway backstop, not the
   * normal way a long turn ends (see idleTimeoutSec).
   */
  timeoutSec: number;
  /** Kill a run after this many seconds with no output of any kind. */
  idleTimeoutSec: number;
  /**
   * Persistent sessions (#519): end a conversation's CLI process after this
   * many seconds with no turn running *and* no background task open. The next
   * message respawns it with `--resume`, so reaping costs context nothing —
   * only the background work it was holding, which is why a pending task holds
   * the reaper off (up to sessionHardCapSec).
   */
  sessionIdleSec: number;
  /**
   * …and the ceiling on that reprieve, counted from the end of the last turn:
   * a background task that never finishes cannot pin a session open forever.
   */
  sessionHardCapSec: number;
  /** MCP rich mode: expose the flow MCP server to the runtime (claude only). */
  mcp: boolean;
  /** Extra text appended to the Flow system prompt. */
  systemPromptExtra?: string | undefined;
}

export interface BridgeConfig {
  serverUrl: string;
  agentToken: string;
  /**
   * Which workspace this process serves, by slug (#357). Agents can belong to
   * several workspaces now, and one bridge process serves exactly one: events
   * from anywhere else are ignored and the MCP tools are scoped to it.
   *
   * Optional, and only meaningful when the agent is in more than one workspace
   * — a single-workspace agent needs no config edit and behaves as it always
   * did. Several configs may name different workspaces while sharing the same
   * credentials (username + key + token); only `login` mints and revokes
   * tokens, so starting a second process never disturbs the first.
   */
  workspace: string | null;
  /**
   * Log file (every line the daemon prints, same timestamped format).
   * Default: <config name>.log next to the config (agent.json → agent.log).
   * Explicit JSON null disables file logging; `~` expands.
   */
  logFile: string | null;
  runtime: RuntimeConfig;
  /** Default 'mentions': @-mentions + DMs only. 'all' adds full traffic of channels the agent is in. */
  eventScope: EventScope;
  /** Never respond to other agents (loop safety). Default false. */
  respondToAgents: boolean;
  /**
   * With respondToAgents on: an agent-authored message must @-mention me
   * (<@userId>) to trigger a run — even in DMs and group DMs, where every
   * message is otherwise in scope. Stops two agents' stray final replies from
   * ping-ponging. Default false.
   */
  agentMentionsOnly: boolean;
  /**
   * Circuit breaker: after this many consecutive agent-authored messages in a
   * channel with no human speaking, stop responding there until a human posts.
   * Instructions ask agents not to loop; this makes a loop mechanically
   * impossible to sustain. 0 disables. Default 6.
   */
  agentChainLimit: number;
  /**
   * The breaker's limit for agent messages that explicitly <@mention> me — a
   * deliberate hand-off, not chatter, so it trips later (#583). Never below
   * agentChainLimit; ignored when that is 0. Default 4× agentChainLimit.
   * Optional for source-level callers; loadConfig always fills it.
   */
  agentMentionChainLimit?: number;
  /** Max conversations processed concurrently (serial within one conversation). */
  concurrency: number;
  progress: ProgressMode;
  /**
   * Relay the agent's interim text into the conversation as it arrives (#162),
   * rather than only its final reply. Default true, and only meaningful under
   * `progress: "thinking"` — `typing` and `silent` post nothing mid-turn by
   * definition. Set false for the pre-#162 quiet turn (tool status row only).
   */
  relayText: boolean;
  /** Live audio in the existing Flow Huddle. Optional for source-level
   * callers that construct BridgeConfig directly; loadConfig always fills it. */
  voice?: VoiceConfig | undefined;
  /**
   * What the bridge remembers across restarts: the ids of the last messages it
   * answered, so a catch-up after a restart never answers one twice. Beside the
   * config (agent.json → state.json, other.json → other.state.json); absent or
   * null keeps it in memory only.
   */
  stateFile?: string | null;
}

/** The state file beside a config: `state.json` for `agent.json`, else `<name>.state.json`. */
export function stateFileFor(configPath: string): string {
  const abs = path.resolve(configPath);
  const base = path.basename(abs).replace(/\.json$/i, '');
  return path.join(path.dirname(abs), base === 'agent' ? 'state.json' : `${base}.state.json`);
}

interface RawConfig {
  serverUrl?: string;
  agentToken?: string;
  workspace?: string;
  logFile?: string | null;
  runtime?: Partial<RuntimeConfig> & { kind?: string };
  eventScope?: string;
  respondToAgents?: boolean;
  agentMentionsOnly?: boolean;
  agentChainLimit?: number;
  agentMentionChainLimit?: number;
  concurrency?: number;
  progress?: string;
  relayText?: boolean;
  voice?: Partial<VoiceConfig>;
}

export function loadConfig(configPath: string): BridgeConfig {
  const abs = path.resolve(configPath);
  let raw: RawConfig;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8')) as RawConfig;
  } catch (err) {
    throw new Error(`could not read config ${abs}: ${(err as Error).message}`);
  }
  const serverUrl = (raw.serverUrl ?? process.env.FLOW_SERVER_URL ?? '').replace(/\/+$/, '');
  if (!serverUrl) throw new Error('config: serverUrl is required (or FLOW_SERVER_URL)');
  const agentToken = raw.agentToken ?? process.env.FLOW_AGENT_TOKEN ?? '';
  if (!agentToken) throw new Error('config: agentToken is required (or FLOW_AGENT_TOKEN)');

  const kind = (raw.runtime?.kind ?? 'claude') as RuntimeKind;
  if (kind !== 'claude' && kind !== 'codex' && kind !== 'demo')
    throw new Error(`config: unknown runtime.kind "${kind}"`);
  const r = raw.runtime ?? {};
  const runtime: RuntimeConfig = {
    kind,
    command: r.command ?? (kind === 'codex' ? 'codex' : 'claude'),
    model: r.model,
    extraArgs: r.extraArgs ?? [],
    cwd: path.resolve(path.dirname(abs), expandHome(r.cwd ?? '.')),
    permissionMode: r.permissionMode,
    allowedTools: r.allowedTools ?? [],
    // Real coding tasks blow past small caps: 25 wedged first turns, and 100 cut
    // a build off mid-tool-loop after 19 productive minutes. Silence, not turn
    // count, is what idleTimeoutSec is for — this is only a runaway backstop.
    maxTurns: r.maxTurns ?? 200,
    // A run dies when it goes *quiet*, not when it gets long. stream-json
    // narrates every tool call, so silence — not elapsed time — is what
    // distinguishes a wedged turn from a productive one; a fixed wall-clock cap
    // killed real multi-hour work at exactly 10 minutes. timeoutSec remains as
    // an absolute runaway backstop, set far above any healthy turn.
    idleTimeoutSec: r.idleTimeoutSec ?? 120,
    timeoutSec: r.timeoutSec ?? 3600,
    // Ten minutes of true quiet is plenty: a resumed session is indistinguishable
    // from one that never stopped, so the only cost of reaping early is losing
    // background work — and that is exactly what the pending check prevents.
    sessionIdleSec: r.sessionIdleSec ?? 600,
    sessionHardCapSec: r.sessionHardCapSec ?? 3600,
    mcp: r.mcp ?? (kind === 'claude'),
    systemPromptExtra: r.systemPromptExtra,
  };

  // Zero or negative would expire every run the instant it starts.
  for (const k of ['timeoutSec', 'idleTimeoutSec', 'sessionIdleSec', 'sessionHardCapSec'] as const) {
    if (!(runtime[k] > 0)) throw new Error(`config: runtime.${k} must be a positive number`);
  }

  // A missing cwd would otherwise surface as a misleading "spawn <cli> ENOENT"
  // (node reports ENOENT for a bad working directory too). Demo never spawns.
  if (kind !== 'demo' && !fs.existsSync(runtime.cwd)) {
    throw new Error(`config: runtime.cwd does not exist: ${runtime.cwd}`);
  }

  const eventScope = (raw.eventScope ?? 'mentions') as EventScope;
  if (eventScope !== 'mentions' && eventScope !== 'all') throw new Error(`config: bad eventScope "${eventScope}"`);
  const progress = (raw.progress ?? 'thinking') as ProgressMode;
  if (!['thinking', 'typing', 'silent'].includes(progress)) throw new Error(`config: bad progress "${progress}"`);

  const logFile =
    raw.logFile === null
      ? null
      : raw.logFile !== undefined
        ? path.resolve(path.dirname(abs), expandHome(raw.logFile))
        : abs.replace(/\.json$/i, '') + '.log';

  const voiceDefaults = defaultVoiceConfig();
  const voice: VoiceConfig = {
    enabled: raw.voice?.enabled ?? voiceDefaults.enabled,
    sttModel: raw.voice?.sttModel?.trim() || voiceDefaults.sttModel,
    ttsModel: raw.voice?.ttsModel?.trim() || voiceDefaults.ttsModel,
    ttsVoice: raw.voice?.ttsVoice?.trim() || voiceDefaults.ttsVoice,
    inferenceUrl: raw.voice?.inferenceUrl?.trim() || voiceDefaults.inferenceUrl,
    maxSessionMinutes: raw.voice?.maxSessionMinutes ?? voiceDefaults.maxSessionMinutes,
    instructions: raw.voice?.instructions?.trim() || undefined,
  };
  if (!(voice.maxSessionMinutes > 0)) {
    throw new Error('config: voice.maxSessionMinutes must be a positive number');
  }

  const agentChainLimit = Math.max(0, raw.agentChainLimit ?? 6);
  return {
    serverUrl,
    agentToken,
    workspace: raw.workspace?.trim() || null,
    logFile,
    runtime,
    eventScope,
    respondToAgents: raw.respondToAgents ?? false,
    agentMentionsOnly: raw.agentMentionsOnly ?? false,
    agentChainLimit,
    agentMentionChainLimit: mentionChainLimit(agentChainLimit, raw.agentMentionChainLimit),
    concurrency: Math.max(1, raw.concurrency ?? 4),
    progress,
    relayText: raw.relayText ?? true,
    voice,
    stateFile: stateFileFor(abs),
  };
}

/**
 * The effective mention limit: unset means 4× the chain limit, 0 means the
 * same as it, and it never undercuts it — a mention can only buy more room.
 */
export function mentionChainLimit(chainLimit: number, mentionLimit: number | undefined): number {
  if (chainLimit <= 0) return 0;
  const limit = mentionLimit === undefined ? chainLimit * 4 : mentionLimit;
  return Math.max(chainLimit, limit);
}

/** The minimum a workspace must expose for `resolveWorkspace` to pick between them. */
export interface WorkspaceChoice {
  id: string;
  slug: string;
  name: string;
}

/**
 * Which of the agent's workspaces this process serves (#357).
 *
 * One workspace: that one, config field or not — the overwhelmingly common
 * case, and it must keep working with no config edit. More than one: the
 * `workspace` slug decides, and its absence is a startup error that lists the
 * slugs, because silently picking the first would have the agent answering in
 * a room its operator never pointed it at.
 */
export function resolveWorkspace<T extends WorkspaceChoice>(all: T[], slug: string | null): T {
  if (all.length === 0) throw new Error('agent belongs to no workspace');
  if (slug) {
    const want = slug.toLowerCase();
    const found = all.find((w) => w.slug.toLowerCase() === want);
    if (found) return found;
    throw new Error(
      `config: workspace "${slug}" is not one this agent belongs to — ` +
        `available: ${all.map((w) => w.slug).join(', ')}`,
    );
  }
  if (all.length === 1) return all[0]!;
  throw new Error(
    `this agent belongs to ${all.length} workspaces — set "workspace" in agent.json to one of: ` +
      `${all.map((w) => w.slug).join(', ')} (one bridge process per workspace)`,
  );
}
