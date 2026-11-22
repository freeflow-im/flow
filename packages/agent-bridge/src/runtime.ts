// Runtime exec: spawn a coding-agent CLI headlessly.
//
// Claude runtime (primary) runs as a *persistent* process per conversation —
// see session.ts, which owns the lifecycle; this module supplies the pieces
// both paths share: the argv builder, the stream-json parser, and process-group
// bookkeeping. `runRuntime` below is the one-shot path, still used by the codex
// and demo runtimes and by voice calls (whose lifetime is the call, not the
// conversation).
// Codex runtime: `codex exec --json`, whose JSONL events give the status row
// its tool steps and the session its resumable thread id (see CodexJsonParser).
// The system prompt is folded into the first invocation of a session.
import { spawn } from 'node:child_process';
import { idleLimitSec, type RuntimeConfig } from './config.js';

export interface RunOpts {
  /** Prepared call images/PDF previews. Claude reads paths; Codex receives image inputs. */
  imagePaths?: string[] | undefined;
  /** Avoid OS command-line limits for document context and call transcripts. */
  stdinPrompt?: boolean;
  sessionId: string;
  /** false → --session-id (new session); true → --resume. */
  resume: boolean;
  /**
   * Codex only: resume this recorded session (`codex exec resume <id>`)
   * instead of starting fresh. Comes from a previous RunResult's
   * codexSessionId — codex names its own sessions, unlike claude where the
   * bridge chooses the id up front.
   */
  codexSessionId?: string | undefined;
  prompt: string;
  systemPrompt: string;
  /** Path to an MCP config JSON to pass via --mcp-config (claude only). */
  mcpConfigPath?: string | undefined;
  /**
   * Abort → end this turn now: the process group dies (SIGTERM first, so the
   * CLI still flushes its session transcript and the next turn can --resume)
   * and the run settles as `interrupted`. This is the Interrupt button.
   */
  signal?: AbortSignal | undefined;
  onToolStep(step: string): void;
  /** Each assistant text block as it is produced — the agent's narration (#162). */
  onText?(text: string): void;
  /** The run's model tokens, when the CLI reports them. */
  onUsage?(usage: TokenUsage): void;
  log(msg: string): void;
}

export interface RunResult {
  ok: boolean;
  /**
   * The reply on success. On failure, whatever could be salvaged — the last
   * thing the agent said before it died, which for an expired run is the only
   * record of the work it did.
   */
  text: string;
  error?: string;
  /**
   * The CLI created a session under this id, so the next turn can `--resume`
   * it with its context even though this turn failed. Any stream-json event
   * proves it: the CLI only starts emitting them once the session exists.
   */
  sawSession?: boolean;
  /**
   * The turn was stopped on purpose (Interrupt button / `/stop`), not by an
   * error or a timeout. The caller says so instead of apologising.
   */
  interrupted?: boolean;
  /**
   * Codex only: the session id this run recorded itself under (parsed from
   * the run header). Present on failures too — a run that got far enough to
   * print its header left a resumable session behind, whatever ended it.
   */
  codexSessionId?: string | undefined;
}

/**
 * Shell wrappers a CLI puts around the command it actually ran
 * (`/bin/zsh -lc 'pnpm test'`). The interesting word is inside the quotes, so
 * peel the wrapper before looking for it.
 */
const SHELL_WRAPPER_RE = /^\s*(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|fish)\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/;

/** `FOO=bar`, `PATH=/x:$PATH` — a prefix, never the command being run. */
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The first *command word* of a shell invocation — what the status row calls
 * the step. Peels shell wrappers, stops at the first separator (a pipeline's
 * head is what the step is "about"), skips env-var prefixes, and reduces a
 * path to its basename so `/usr/bin/sed` reads as `sed`. Returns '' when there
 * is nothing recognisable, which the caller renders as a bare `Bash`.
 */
export function bashCommandWord(command: unknown): string {
  let cmd = String(command ?? '').trim();
  // Nested wrappers are real: `zsh -lc "bash -c 'pnpm test'"`. Bounded, so a
  // pathological string can't spin here.
  for (let i = 0; i < 3; i++) {
    const m = SHELL_WRAPPER_RE.exec(cmd);
    if (!m) break;
    cmd = m[2]!.trim();
  }
  // First segment only — `cd x && pnpm test` is a `cd` step (#552 says the
  // first command is acceptable; it is also the one that has already started).
  const head = cmd.split(/\||&&|\|\||;|\n/)[0] ?? '';
  for (const raw of head.trim().split(/\s+/)) {
    let word = raw.replace(/^["']|["']$/g, '');
    if (!word) continue;
    if (ENV_ASSIGN_RE.test(word)) continue; // FOO=1 cmd …
    if (word === 'env' || word === 'command' || word === 'exec') continue;
    if (word.startsWith('(') || word.startsWith('{')) word = word.replace(/^[({]+/, '');
    if (!word) continue;
    const base = word.split('/').filter(Boolean).pop() ?? word;
    // A label, not an argument: cap it so a rogue command can't stretch the row.
    return base.length > 24 ? `${base.slice(0, 23)}…` : base;
  }
  return '';
}

/**
 * Tools that wrap something else and are worth naming: the status row says
 * which skill or which subagent, because "Skill" alone says nothing. Values
 * are the input keys to try, in order — the first non-empty one wins.
 */
const PRIMARY_ARG_KEYS: Record<string, readonly string[]> = {
  Skill: ['skill', 'name', 'command'],
  Task: ['subagent_type', 'agent_type'],
  Agent: ['subagent_type', 'agent_type'],
};

/** A sub-name is a label, not an argument: one short token, no paths, no spaces. */
function subName(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s || /[\s/\\]/.test(s)) return '';
  return s.length > 32 ? `${s.slice(0, 31)}…` : s;
}

/**
 * The compact label for one tool call, as shown in the `🤖 thinking…` status
 * row: the *kind* of step, never its arguments (#550, #552). A full path or a
 * command tail wraps over four lines on a phone and adds no scanning value —
 * transcripts and task channels still log the whole invocation.
 *
 *   Bash: sed -n 240,300p /tmp/…/runtime.ts   →  Bash(sed)
 *   mcp__flow__send_message                   →  flow: send_message
 *   Read / Edit / Grep / Write                →  Read / Edit / Grep / Write
 */
export function formatToolStep(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name.startsWith('mcp__')) {
    const [server, ...rest] = name.slice('mcp__'.length).split('__');
    const tool = rest.join('__');
    return server && tool ? `${server}: ${tool}` : (server ?? name);
  }
  if (name === 'Bash' || name === 'BashOutput') {
    const word = name === 'Bash' ? bashCommandWord(i.command) : '';
    return word ? `Bash(${word})` : name;
  }
  if (name === 'TodoWrite') return 'updating plan';
  // `Task` is what the CLI calls it; `Agent` is what a reader watching the row
  // calls it, and #552 spells it that way.
  const label = name === 'Task' ? 'Agent' : name;
  const keys = PRIMARY_ARG_KEYS[name];
  if (keys) {
    for (const key of keys) {
      const sub = subName(i[key]);
      if (sub) return `${label}(${sub})`;
    }
  }
  return label;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  message?: {
    content?: Array<{ type?: string; id?: string; name?: string; input?: unknown; text?: string; tool_use_id?: string }> | string;
    /** assistant: the model that answered. */
    model?: string;
  };
  /** system/background_tasks_changed: the complete set of tasks running right now. */
  tasks?: Array<{ task_id?: string; description?: string }>;
  /** system/task_started, system/task_notification. */
  task_id?: string;
  description?: string;
  tool_use_id?: string;
  is_backgrounded?: boolean;
  status?: string;
  summary?: string;
  /** result: the main loop's tokens for this turn alone (subagents and other calls left out). */
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  /**
   * result: each model's tokens since the process's previous result, subagents and every other call included. The
   * CLI's own advice: sum these, never subtract `modelUsage`, which runs on across turns. Absent on older CLIs.
   */
  model_usage_since_last_result?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
}

/**
 * A turn's model tokens on one model, reported to Flow (Admin › Members › Usage). Input comes in its three billing kinds:
 * `inputTokens` is the uncached input, apart from prompt-cache writes and reads. `model` is '' when the CLI did not say
 * (the bridge then names its configured model). `requests` is 1 on a turn's first entry and 0 on the others, so a turn
 * that used several models counts as one call.
 */
export interface TokenUsage { model: string; inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; requests: number }

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const any = (u: TokenUsage) => u.inputTokens + u.outputTokens + u.cacheWriteTokens + u.cacheReadTokens > 0;

/**
 * A `result` event's tokens, one entry per model: the per-model count since the previous result where the CLI gives
 * it, else the turn's main-loop usage on the model its last answer came from (`lastModel`). Empty when it used none.
 */
export function claudeUsage(ev: Pick<StreamEvent, 'usage' | 'model_usage_since_last_result'>, lastModel = ''): TokenUsage[] {
  const per = ev.model_usage_since_last_result;
  const list: TokenUsage[] = per && typeof per === 'object'
    ? Object.entries(per).map(([model, u]) => ({ model, inputTokens: n(u?.inputTokens), outputTokens: n(u?.outputTokens), cacheWriteTokens: n(u?.cacheCreationInputTokens), cacheReadTokens: n(u?.cacheReadInputTokens), requests: 0 }))
    : ev.usage
      ? [{ model: lastModel, inputTokens: n(ev.usage.input_tokens), outputTokens: n(ev.usage.output_tokens), cacheWriteTokens: n(ev.usage.cache_creation_input_tokens), cacheReadTokens: n(ev.usage.cache_read_input_tokens), requests: 0 }]
      : [];
  const used = list.filter(any);
  if (used[0]) used[0].requests = 1;
  return used;
}

/** A codex `turn.completed` usage as a TokenUsage: codex counts cached input inside input_tokens, and reports no writes. */
export function codexUsage(u: CodexEvent['usage']): TokenUsage | null {
  if (!u) return null;
  const cached = Math.min(n(u.cached_input_tokens), n(u.input_tokens));
  const usage = { model: '', inputTokens: n(u.input_tokens) - cached, outputTokens: n(u.output_tokens), cacheWriteTokens: 0, cacheReadTokens: cached, requests: 1 };
  return any(usage) ? usage : null;
}

/**
 * Turn-scoped signals a persistent session needs and a one-shot run doesn't:
 * where one turn ends and the next begins, and whether the agent still has
 * background work running (which is what holds the idle reaper off).
 */
export interface StreamHooks {
  /** A turn began — `system`/`init`, which the CLI re-emits for every turn. */
  onTurnStart?(): void;
  /** The turn's terminal `result` event; the parser's per-turn fields are set. */
  onResult?(): void;
  /** The count of open background tasks changed. */
  onPendingChange?(pending: number): void;
  /** A turn's tokens, from its `result` event (any turn: asked for, follow-up, or failed). */
  onUsage?(usage: TokenUsage): void;
}

/**
 * Feed stream-json stdout lines; emits tool steps and captures the final
 * result. Tolerant of non-JSON noise on stdout.
 */
export class StreamJsonParser {
  private buf = '';
  finalText = '';
  isError = false;
  sawResult = false;
  /**
   * The failing result's `subtype` (`error_max_turns`, `error_during_execution`,
   * …). Kept because the boolean alone can't tell an operator whether to raise a
   * cap or go read a stack trace.
   */
  errorSubtype = '';
  /** Any well-formed event — see RunResult.sawSession. */
  sawEvent = false;
  /**
   * The most recent assistant text block. A run killed mid-turn never gets its
   * terminal result event, so `finalText` stays empty and this is all there is
   * to show for it.
   */
  lastText = '';
  /** The model the latest answer came from: what an older CLI's result usage is put down to. */
  lastModel = '';

  /**
   * `onText` receives every assistant text block as it arrives — the agent's
   * running commentary, which used to be parsed and dropped on the floor
   * (#162). A block identical to the one before it is swallowed: relaying the
   * same sentence twice reads as a glitch, never as progress.
   */
  /**
   * Background work the agent started and has not finished — the reason a
   * session with no turn in flight is still not idle. Keyed by
   * `tool:<tool_use_id>` until the CLI gives the task an id of its own, then by
   * `task:<task_id>`; the value is a human description for the logs.
   */
  readonly pending = new Map<string, string>();
  /**
   * Tool calls of this turn that have started and not yet returned (their
   * tool_use ids). The CLI is silent while one runs, so the idle timer allows
   * longer then (idleLimitSec).
   */
  readonly running = new Set<string>();

  constructor(
    private readonly onToolStep: (step: string) => void,
    private readonly onText: (text: string) => void = () => {},
    private readonly hooks: StreamHooks = {},
  ) {}

  /**
   * Forget the last turn so the next one is judged on its own events. Only the
   * per-turn verdict is cleared: `sawEvent` (the session exists, so a respawn
   * can `--resume`) and `pending` (background work outlives the turn that
   * started it) are properties of the session, not of any one turn.
   */
  resetTurn(): void {
    this.finalText = '';
    this.isError = false;
    this.sawResult = false;
    this.errorSubtype = '';
    this.lastText = '';
    this.running.clear();
  }

  feed(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let ev: StreamEvent;
    try {
      ev = JSON.parse(line) as StreamEvent;
    } catch {
      return; // non-JSON noise
    }
    if (typeof ev.type === 'string') this.sawEvent = true;
    if (ev.type === 'system') return this.handleSystem(ev);
    const raw = ev.message?.content;
    const content = Array.isArray(raw) ? raw : [];
    if (ev.type === 'user') {
      for (const block of content) if (block.type === 'tool_result' && block.tool_use_id) this.running.delete(block.tool_use_id);
      return;
    }
    if (ev.type === 'assistant') {
      const model = ev.message?.model;
      if (typeof model === 'string' && model && !model.startsWith('<')) this.lastModel = model;
      for (const block of content) {
        if (block.type === 'tool_use' && block.name) {
          if (block.id) this.running.add(block.id);
          this.openIfBackgrounded(block.id, block.name, block.input);
          this.onToolStep(formatToolStep(block.name, block.input));
        }
        else if (block.type === 'text' && block.text?.trim()) {
          const text = block.text.trim();
          if (text !== this.lastText) this.onText(text);
          // Latest wins: on a dead run the newest one is "where it got to".
          this.lastText = text;
        }
      }
    } else if (ev.type === 'result') {
      this.running.clear();
      this.sawResult = true;
      this.isError = ev.is_error === true || (ev.subtype !== undefined && ev.subtype !== 'success');
      this.errorSubtype = this.isError ? (ev.subtype ?? '') : '';
      this.finalText = ev.result ?? '';
      for (const usage of claudeUsage(ev, this.lastModel)) this.hooks.onUsage?.(usage);
      this.hooks.onResult?.();
    }
  }

  /**
   * `system` events carry the session's out-of-band state: `init` opens every
   * turn (including the ones the SDK starts by itself when a background task
   * finishes), and the task events say what is still running.
   *
   * `background_tasks_changed` is a full snapshot and therefore authoritative —
   * it is what stops a task that never really started from pinning a session
   * open forever. The narrower events keep the count honest in between.
   */
  private handleSystem(ev: StreamEvent): void {
    const before = this.pending.size;
    switch (ev.subtype) {
      case 'init':
        this.hooks.onTurnStart?.();
        return;
      case 'background_tasks_changed': {
        for (const key of [...this.pending.keys()]) if (key.startsWith('task:')) this.pending.delete(key);
        for (const t of ev.tasks ?? []) if (t.task_id) this.pending.set(`task:${t.task_id}`, t.description ?? t.task_id);
        // Nothing is running, so no tool_use can still be waiting to start.
        if ((ev.tasks ?? []).length === 0) this.pending.clear();
        break;
      }
      case 'task_started': {
        if (ev.tool_use_id) this.pending.delete(`tool:${ev.tool_use_id}`);
        if (ev.is_backgrounded && ev.task_id) this.pending.set(`task:${ev.task_id}`, ev.description ?? ev.task_id);
        break;
      }
      case 'task_notification': {
        // Anything but "running" is terminal — completed, failed, killed.
        if (ev.status === 'running') break;
        if (ev.task_id) this.pending.delete(`task:${ev.task_id}`);
        if (ev.tool_use_id) this.pending.delete(`tool:${ev.tool_use_id}`);
        break;
      }
      default:
        return;
    }
    if (this.pending.size !== before) this.hooks.onPendingChange?.(this.pending.size);
  }

  /**
   * A `run_in_background` tool call opens a pending entry straight away, keyed
   * by the tool_use id: the task's own id only arrives with `task_started`, and
   * between those two events the reaper must already know work is starting.
   */
  private openIfBackgrounded(id: string | undefined, name: string, input: unknown): void {
    const i = (input ?? {}) as Record<string, unknown>;
    if (i.run_in_background !== true || !id) return;
    this.pending.set(`tool:${id}`, formatToolStep(name, input));
    this.hooks.onPendingChange?.(this.pending.size);
  }
}

/**
 * One `codex exec --json` event. Codex names its own vocabulary — a turn is a
 * sequence of *items* (a shell command, a message, a file edit) each announced
 * by `item.started` and closed by `item.completed`.
 */
interface CodexEvent {
  type?: string;
  /** thread.started: the session id, which `codex exec resume <id>` takes. */
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    /** command_execution: the full invocation, shell wrapper and all. */
    command?: string;
    /** agent_message: what the agent said. */
    text?: string;
  };
  /** turn.completed: the turn's tokens. */
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}

/**
 * Item types worth a status row of their own. Codex will grow more of them;
 * anything not named here is ignored rather than guessed at, so a new item
 * type is a silent no-op instead of a bad label or a crash.
 */
const CODEX_ITEM_LABELS: Record<string, string> = {
  file_change: 'Edit',
  web_search: 'WebSearch',
  todo_list: 'updating plan',
};

/**
 * The codex-side sibling of `StreamJsonParser`: same job, different dialect.
 * Feed it `codex exec --json` stdout and it emits terse tool steps, relays the
 * agent's narration, and picks up the thread id that makes the next turn
 * resumable (#552). Tolerant of non-JSON noise, exactly like its sibling —
 * codex prints the odd plain-text warning alongside the stream.
 */
export class CodexJsonParser {
  private buf = '';
  /** From `thread.started` — this run's resumable session id. */
  threadId: string | undefined;
  /**
   * The last `agent_message`. Codex narrates mid-turn with the same item type
   * it uses for the final answer, so latest-wins is both "the reply" and, on a
   * run that gets killed, the salvage — the mirror of `StreamJsonParser.lastText`.
   */
  lastText = '';
  /** Any well-formed event — proof the session exists. See RunResult.sawSession. */
  sawEvent = false;

  constructor(
    private readonly onToolStep: (step: string) => void,
    private readonly onText: (text: string) => void = () => {},
    private readonly onUsage: (usage: TokenUsage) => void = () => {},
  ) {}

  feed(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let ev: CodexEvent;
    try {
      ev = JSON.parse(line) as CodexEvent;
    } catch {
      return; // non-JSON noise
    }
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return;
    this.sawEvent = true;
    if (ev.type === 'thread.started') {
      if (typeof ev.thread_id === 'string' && ev.thread_id) this.threadId = ev.thread_id;
      return;
    }
    if (ev.type === 'turn.completed') {
      const usage = codexUsage(ev.usage);
      if (usage) this.onUsage(usage);
      return;
    }
    const item = ev.item;
    if (!item || typeof item.type !== 'string') return;
    if (item.type === 'agent_message') {
      const text = String(item.text ?? '').trim();
      if (!text) return;
      if (text !== this.lastText) this.onText(text);
      this.lastText = text;
      return;
    }
    // Steps are announced once, when the item starts — `item.completed` for the
    // same id would print the row a second time after the work is already done.
    if (ev.type !== 'item.started') return;
    if (item.type === 'command_execution') {
      const word = bashCommandWord(item.command);
      this.onToolStep(word ? `Bash(${word})` : 'Bash');
      return;
    }
    const label = CODEX_ITEM_LABELS[item.type];
    if (label) this.onToolStep(label);
  }
}

/** Just the fields the argv depends on — `RunOpts` satisfies it structurally. */
export interface ClaudeArgsOpts {
  sessionId: string;
  resume: boolean;
  prompt: string;
  systemPrompt: string;
  mcpConfigPath?: string | undefined;
  stdinPrompt?: boolean | undefined;
  /**
   * Persistent session: turns arrive as stream-json user messages on stdin, so
   * there is no prompt on the command line at all and the process outlives the
   * turn (see session.ts).
   */
  streamInput?: boolean | undefined;
}

export function buildClaudeArgs(cfg: RuntimeConfig, opts: ClaudeArgsOpts): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (opts.streamInput) args.push('--input-format', 'stream-json');
  args.push(opts.resume ? '--resume' : '--session-id', opts.sessionId);
  args.push('--append-system-prompt', opts.systemPrompt);
  args.push('--max-turns', String(cfg.maxTurns));
  if (cfg.model) args.push('--model', cfg.model);
  if (cfg.permissionMode) args.push('--permission-mode', cfg.permissionMode);
  // Default is full permissions (operator ruling): with neither permissionMode
  // nor allowedTools configured, the agent runs unrestricted in its cwd.
  // Setting either one opts into scoped permissions instead.
  else if (cfg.allowedTools.length === 0) args.push('--permission-mode', 'bypassPermissions');
  const allowed = [...cfg.allowedTools];
  if (opts.mcpConfigPath) {
    // = form: --mcp-config and --allowedTools are variadic in the claude CLI
    // and would otherwise swallow the trailing positional prompt
    args.push(`--mcp-config=${opts.mcpConfigPath}`);
    allowed.push('mcp__flow'); // pre-grant the flow tools — headless runs can't prompt
  }
  if (allowed.length) args.push(`--allowedTools=${allowed.join(',')}`);
  args.push(...cfg.extraArgs);
  if (!opts.stdinPrompt && !opts.streamInput) args.push(opts.prompt);
  return args;
}

export function buildCodexArgs(cfg: RuntimeConfig, opts: RunOpts): string[] {
  // stdout is a JSONL event stream (--json); the reply is its last agent_message.
  // Continuity comes from `codexSessionId`
  // — the id codex printed on an earlier run — which turns the invocation into
  // `codex exec resume <id>`, reloading that session's full context from
  // ~/.codex. Only then does the prompt carry just the new turn; a fresh run
  // still fronts the system prompt itself. Callers without an id fall back to
  // whatever continuity they packed into opts.prompt (e.g. voice transcripts).
  const resume = opts.codexSessionId !== undefined;
  const prompt = resume ? opts.prompt : `${opts.systemPrompt}\n\n${opts.prompt}`;
  const images = (opts.imagePaths ?? []).map((image) => `--image=${image}`);
  // --json turns stdout into the JSONL event stream CodexJsonParser reads: tool
  // steps for the status row, and the thread id that resumes the session (#552).
  return ['exec', ...(resume ? ['resume'] : []), '--json', '--skip-git-repo-check', ...images, ...cfg.extraArgs,
    ...(images.length || opts.stdinPrompt ? ['--'] : []),
    ...(resume ? [opts.codexSessionId as string] : []),
    opts.stdinPrompt ? '-' : prompt];
}

/**
 * Fallback session-id source: the header codex prints (`session id: <uuid>` —
 * stderr in non-tty runs). Under `--json` the id arrives structurally, as
 * `thread.started.thread_id`, and this header is not printed at all; the regex
 * stays because it costs two lines and is the only thing that would keep
 * resume working if a codex build ever refused the flag.
 */
const CODEX_SESSION_ID_RE = /^session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/im;

export function parseCodexSessionId(stderr: string, stdout: string): string | undefined {
  return (CODEX_SESSION_ID_RE.exec(stderr) ?? CODEX_SESSION_ID_RE.exec(stdout))?.[1];
}

/** Demo mode: static canned reply, no CLI spawn. */
export const DEMO_REPLY = 'Your message was received';

/** Process-group ids of in-flight runtime spawns, for shutdown cleanup. */
const liveGroups = new Set<number>();

/**
 * Take down a runtime and everything it started. The negative pid targets the
 * whole process group: a bare `child.kill()` reaches only the CLI, leaving its
 * Bash-tool grandchildren (builds, test runs, dev servers) orphaned and running
 * unsupervised. SIGTERM first so the CLI can flush its session transcript —
 * that transcript is what makes the next turn resumable.
 */
export function killGroup(pid: number, graceMs: number): void {
  const send = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      // already exited, or never got its own group — nothing to do
    }
  };
  send('SIGTERM');
  if (graceMs <= 0) {
    send('SIGKILL');
    return;
  }
  const t = setTimeout(() => send('SIGKILL'), graceMs);
  t.unref();
}

/** Persistent sessions join the same registry, so shutdown reaches them too. */
export function registerGroup(pid: number): void {
  liveGroups.add(pid);
}

export function unregisterGroup(pid: number): void {
  liveGroups.delete(pid);
}

/**
 * Shutdown hook: runtimes are spawned detached (own process group), so they no
 * longer die with the bridge on Ctrl-C — the daemon has to end them itself.
 * Covers persistent sessions as well as one-shot runs (AC 6 of #519).
 */
export function killAllRuntimes(): void {
  for (const pid of liveGroups) killGroup(pid, 0);
  liveGroups.clear();
}

/**
 * Turn a failing `result` event into something an operator can act on. The turn
 * cap is by far the most common failure and its fix is a config change, so it
 * says so by name — and carries the cap, because "raise it" needs a number.
 */
export function describeResultError(subtype: string, maxTurns: number): string {
  if (subtype === 'error_max_turns') return `agent exceeded max turns (${maxTurns})`;
  if (subtype) return `runtime reported ${subtype}`;
  return 'runtime reported an error';
}

/** What an interrupted turn resolves to — no CLI error, just a stopped run. */
const INTERRUPTED = 'interrupted';

export async function runRuntime(cfg: RuntimeConfig, opts: RunOpts): Promise<RunResult> {
  if (opts.signal?.aborted) return { ok: false, text: '', error: INTERRUPTED, interrupted: true };
  if (cfg.kind === 'demo') {
    // Brief pause so the typing indicator is visible in clients — and long
    // enough to be interruptible, which is what makes demo mode testable.
    const stopped = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 500);
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    if (stopped) return { ok: false, text: '', error: INTERRUPTED, interrupted: true };
    return { ok: true, text: DEMO_REPLY };
  }
  const args = cfg.kind === 'claude' ? buildClaudeArgs(cfg, opts) : buildCodexArgs(cfg, opts);
  return new Promise((resolve) => {
    const child = spawn(cfg.command, args, {
      cwd: cfg.cwd,
      stdio: [opts.stdinPrompt ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      // Own process group, so expiry can kill the agent's whole subprocess tree
      // rather than just the CLI. Costs us the automatic teardown on bridge
      // exit — killAllRuntimes() covers that.
      detached: true,
    });
    if (child.pid) liveGroups.add(child.pid);
    if (opts.stdinPrompt && child.stdin) {
      child.stdin.on('error', () => { /* Spawn/exit handlers report a failed CLI. */ });
      // A resumed codex session already holds its system prompt; only a fresh
      // run needs it fronted (mirrors the argv form in buildCodexArgs).
      const freshCodex = cfg.kind === 'codex' && opts.codexSessionId === undefined;
      child.stdin.end(freshCodex ? `${opts.systemPrompt}\n\n${opts.prompt}` : opts.prompt);
    }
    const parser = new StreamJsonParser(opts.onToolStep, (t) => opts.onText?.(t), { onUsage: (u) => opts.onUsage?.(u) });
    const codex = new CodexJsonParser(opts.onToolStep, (t) => opts.onText?.(t), (u) => opts.onUsage?.(u));
    let stdout = '';
    let stderr = '';
    /** The id to resume this codex session by, structural source first. */
    const codexId = (): string | undefined =>
      cfg.kind === 'codex' ? (codex.threadId ?? parseCodexSessionId(stderr, stdout)) : undefined;
    /**
     * What codex has said so far. `--json` gives us the agent's own messages;
     * raw stdout is the fallback for a build that ignored the flag and printed
     * plain text instead.
     */
    const codexText = (): string => codex.lastText || stdout.trim();
    let settled = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let capTimer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      if (capTimer) clearTimeout(capTimer);
      if (child.pid) liveGroups.delete(child.pid);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    /**
     * End the run early. An expiry and an interrupt take the same path — kill
     * the process group, salvage whatever the agent said — and differ only in
     * how the caller reports it.
     */
    const expire = (error: string, interrupted = false): void => {
      if (settled) return;
      settled = true;
      cleanup();
      opts.log(interrupted ? 'run interrupted — killing the process group' : `runtime expired: ${error} — killing the process group`);
      if (child.pid) killGroup(child.pid, 5000);
      // The terminal result event will never arrive, so salvage the last thing
      // the agent said (codex has no events — its raw stdout is the contract).
      const codexSessionId = codexId();
      resolve({
        ok: false,
        text: cfg.kind === 'claude' ? parser.lastText : codexText(),
        error,
        sawSession: cfg.kind === 'codex' ? codexSessionId !== undefined : parser.sawEvent,
        interrupted,
        codexSessionId,
      });
    };
    function onAbort(): void {
      expire(INTERRUPTED, true);
    }
    opts.signal?.addEventListener('abort', onAbort);
    /**
     * Rearmed by every byte the runtime emits. A turn that is still working
     * narrates itself (stream-json emits an event per tool call), so it never
     * expires no matter how long it runs; only genuine silence does.
     */
    const bumpIdle = (): void => {
      if (settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      const limit = idleLimitSec(cfg, cfg.kind === 'claude' && parser.running.size > 0);
      idleTimer = setTimeout(() => expire(`no output for ${limit}s`), limit * 1000);
    };
    capTimer = setTimeout(() => expire(`hit the ${cfg.timeoutSec}s run cap`), cfg.timeoutSec * 1000);
    bumpIdle();

    child.stdout!.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stdout += s;
      if (cfg.kind === 'claude') parser.feed(s);
      else if (cfg.kind === 'codex') codex.feed(s);
      // After the feed, so a tool call that just started gets the longer limit.
      bumpIdle();
    });
    child.stderr!.on('data', (d: Buffer) => {
      bumpIdle();
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false, text: '', error: `could not spawn ${cfg.command}: ${err.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      parser.feed('\n'); // flush a trailing unterminated line
      codex.feed('\n');
      if (cfg.kind === 'claude') {
        if (parser.sawResult && !parser.isError) return resolve({ ok: true, text: parser.finalText, sawSession: true });
        // Error text stays short: the runtime's own words ride along as
        // salvage instead of being spliced in truncated at 300 chars. The
        // subtype is the exception — it's the one word that says what to do.
        const error = parser.sawResult
          ? describeResultError(parser.errorSubtype, cfg.maxTurns)
          : `runtime exited ${code} without a result${stderr ? `: ${stderr.slice(-300)}` : ''}`;
        return resolve({
          ok: false,
          text: parser.finalText || parser.lastText,
          error,
          sawSession: parser.sawEvent,
        });
      }
      // the reply is the turn's last agent_message (raw stdout if there were none)
      const codexSessionId = codexId();
      const sawSession = codexSessionId !== undefined;
      if (code === 0) return resolve({ ok: true, text: codexText(), sawSession, codexSessionId });
      return resolve({
        ok: false,
        text: '',
        error: `runtime exited ${code}${stderr ? `: ${stderr.slice(-300)}` : ''}`,
        sawSession,
        codexSessionId,
      });
    });
  });
}
