// Persistent agent session: one CLI process per conversation (#519).
//
// The bridge used to spawn a `claude` process per turn and kill it the moment
// the turn's `result` event arrived. That took the agent's background work with
// it — a backgrounded Bash task, a subagent, a pending wakeup — so an agent
// could not do anything asynchronous at all.
//
// Here the process is spawned once per conversation and kept alive:
// `--input-format stream-json` with stdin held open, each Flow message written
// as a user message, each `result` event a turn boundary rather than the end of
// the process. Background tasks then survive the boundary, and when one
// finishes the SDK re-invokes the agent inside the same process — a turn nobody
// sent a message for, whose reply is posted like any other (`onAmbientEnd`).
//
// What this buys costs a lifecycle to manage, which is the rest of this file:
// per-turn timers (silence *between* turns is normal and must expire nothing),
// an idle reaper that a pending background task holds off up to a hard cap, and
// an interrupt that ends the turn without ending the session.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { idleLimitSec, type RuntimeConfig } from './config.js';
import {
  StreamJsonParser,
  buildClaudeArgs,
  describeResultError,
  killGroup,
  registerGroup,
  unregisterGroup,
  type RunResult,
  type TokenUsage,
} from './runtime.js';

/** What an interrupted turn resolves to — no CLI error, just a stopped run. */
const INTERRUPTED = 'interrupted';

/**
 * How long a turn we asked to stop gets to produce its `result` before we stop
 * asking and kill the process group. The control request is the good path (it
 * leaves the session and its background tasks alive); this is the backstop for
 * a CLI too wedged to answer it.
 */
const INTERRUPT_GRACE_MS = 10_000;

/** SIGTERM → SIGKILL grace on a reap, long enough to flush the transcript. */
const REAP_GRACE_MS = 5_000;

/** Everything the CLI needs at spawn time and cannot be changed afterwards. */
export interface SessionSpawn {
  systemPrompt: string;
  mcpConfigPath?: string | undefined;
  /** Drop the scratch files this spawn owns (the per-session MCP config). */
  cleanup?: (() => void) | undefined;
}

export interface SessionHooks {
  /** Tool calls and text for whichever turn is running — solicited or not. */
  onToolStep(step: string): void;
  onText(text: string): void;
  /**
   * A turn began that no Flow message asked for: the SDK re-invoked the agent
   * because a background task finished. The bridge opens a progress row for it.
   */
  onAmbientStart(): void;
  /** …and it ended — post its reply to the conversation like any other. */
  onAmbientEnd(result: RunResult): void;
  /** A turn's model tokens (any turn), for Flow's usage count. */
  onUsage?(usage: TokenUsage): void;
  log(msg: string): void;
}

export interface SessionOpts {
  cfg: RuntimeConfig;
  /** The CLI session id this conversation owns; stable across respawns. */
  sessionId: string;
  /** true → the CLI already has a transcript under that id, so `--resume` it. */
  resume: boolean;
  /** Called for every spawn, so a respawn picks up current conversation context. */
  makeSpawn(): SessionSpawn;
  hooks: SessionHooks;
  /** Override the interrupt→kill grace. Tests only; production takes the default. */
  interruptGraceMs?: number;
}

/** A turn in flight. Solicited turns have a `resolve`; ambient ones do not. */
interface ActiveTurn {
  ambient: boolean;
  resolve: ((result: RunResult) => void) | null;
  /**
   * Set once we have asked the CLI to end this turn (interrupt, or a per-turn
   * timer firing). The `result` it produces is an error result either way, and
   * this is what tells us to report it as a stop rather than as a failure.
   */
  ending: { error: string; interrupted: boolean } | null;
  idleTimer: NodeJS.Timeout | null;
  capTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
}

/**
 * One conversation's CLI process. Turns are serialised: a message arriving
 * while a turn (of either kind) is running waits for it, exactly as messages
 * queued behind a running turn did before.
 */
export class RuntimeSession {
  private readonly cfg: RuntimeConfig;
  private readonly hooks: SessionHooks;
  private readonly makeSpawn: () => SessionSpawn;
  private readonly sessionId: string;
  private readonly interruptGraceMs: number;
  private child: ChildProcess | null = null;
  private parser: StreamJsonParser;
  private resume: boolean;
  private spawnCleanup: (() => void) | null = null;
  private turn: ActiveTurn | null = null;
  private stderrTail = '';
  /** Set by the close handler when the CLI refused our `--session-id`. */
  private collided = false;
  private disposed = false;
  /** Serialises runTurn callers against each other. */
  private gate: Promise<unknown> = Promise.resolve();
  private idleWaiters: Array<() => void> = [];
  /** When the last turn of any kind ended — what both reaper clocks measure. */
  private lastTurnEndAt = Date.now();

  constructor(opts: SessionOpts) {
    this.cfg = opts.cfg;
    this.hooks = opts.hooks;
    this.makeSpawn = opts.makeSpawn;
    this.sessionId = opts.sessionId;
    this.resume = opts.resume;
    this.interruptGraceMs = opts.interruptGraceMs ?? INTERRUPT_GRACE_MS;
    this.parser = this.newParser();
  }

  /** The CLI has produced events under this session id, so a respawn resumes it. */
  get sawSession(): boolean {
    return this.parser.sawEvent || this.resume;
  }

  get turnInFlight(): boolean {
    return this.turn !== null;
  }

  /** Background work the agent started and hasn't finished. */
  get pendingTasks(): number {
    return this.parser.pending.size;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /**
   * Idle = nothing to wait for: no turn running and no background task open.
   * Only an idle session is reapable on the short clock.
   */
  get idle(): boolean {
    return this.turn === null && this.parser.pending.size === 0;
  }

  /**
   * Reap when the session has been quiet past its clock. A pending background
   * task buys time — up to the hard cap, so a wedged task cannot pin a session
   * open forever — but a turn in flight is never interrupted by the reaper.
   */
  reapReason(now: number, idleMs: number, hardCapMs: number): string | null {
    if (this.child === null || this.turn !== null) return null;
    const quiet = now - this.lastTurnEndAt;
    if (this.parser.pending.size === 0) {
      return quiet >= idleMs ? `idle for ${Math.round(quiet / 1000)}s` : null;
    }
    return quiet >= hardCapMs
      ? `hit the ${Math.round(hardCapMs / 1000)}s cap with ${this.parser.pending.size} background task(s) still open`
      : null;
  }

  /**
   * Run one turn. Spawns the process if this conversation hasn't got one (first
   * message, or the first after a reap or a crash), then writes the message and
   * resolves when that turn's `result` arrives.
   */
  async runTurn(prompt: string, signal?: AbortSignal): Promise<RunResult> {
    const run = this.gate.then(async () => {
      if (signal?.aborted) return { ok: false, text: '', error: INTERRUPTED, interrupted: true };
      await this.waitForNoTurn(signal);
      // Stopped while it queued behind another turn (#522): it never reached the
      // CLI, so there is nothing to interrupt — just say it was stopped.
      if (signal?.aborted) return { ok: false, text: '', error: INTERRUPTED, interrupted: true };
      let result = await this.attempt(prompt, signal);
      // Session-id collision (a previous process died after the CLI created the
      // session): the session exists — flip to --resume and retry this same
      // message transparently, exactly as the per-turn runtime used to.
      if (this.collided) {
        this.collided = false;
        this.resume = true;
        this.hooks.log('session collision — retrying this message with --resume');
        result = await this.attempt(prompt, signal);
      }
      return result;
    });
    // The gate must advance even when a turn throws, or the conversation wedges.
    this.gate = run.catch(() => {});
    return run;
  }

  /** Interrupt button / `/stop`: end the turn, keep the session. */
  interrupt(): void {
    this.endTurnEarly(INTERRUPTED, true);
  }

  /** Reap or shut down: the process and everything it started go away. */
  dispose(reason: string, graceMs = REAP_GRACE_MS): void {
    this.disposed = true;
    const pid = this.child?.pid;
    if (pid) {
      this.hooks.log(`ending the session process (pid ${pid}): ${reason}`);
      killGroup(pid, graceMs);
      unregisterGroup(pid);
    }
    this.child = null;
    this.spawnCleanup?.();
    this.spawnCleanup = null;
    // A turn still waiting settles from the close handler; if the process was
    // already gone, settle it here so no caller hangs.
    if (this.turn) this.settleTurn(this.buildResult(`session ended: ${reason}`));
  }

  // ---- internals -----------------------------------------------------------

  private newParser(): StreamJsonParser {
    return new StreamJsonParser(
      (step) => this.hooks.onToolStep(step),
      (text) => this.hooks.onText(text),
      {
        onTurnStart: () => this.onTurnStart(),
        onResult: () => this.onResult(),
        onUsage: (usage) => this.hooks.onUsage?.(usage),
        onPendingChange: (pending) =>
          this.hooks.log(`background tasks open: ${pending}`),
      },
    );
  }

  /** Resolves once no turn is running — ambient turns queue new messages too —
   * or as soon as the waiting turn is stopped. */
  private waitForNoTurn(signal?: AbortSignal): Promise<void> {
    if (this.turn === null) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  private async attempt(prompt: string, signal?: AbortSignal): Promise<RunResult> {
    const spawnError = this.ensureProcess();
    if (spawnError) return { ok: false, text: '', error: spawnError };
    return new Promise<RunResult>((resolve) => {
      const turn = this.startTurn(false, resolve);
      turn.signal = signal;
      turn.onAbort = () => this.endTurnEarly(INTERRUPTED, true);
      signal?.addEventListener('abort', turn.onAbort);
      if (signal?.aborted) return turn.onAbort();
      const line = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      });
      try {
        this.child!.stdin!.write(`${line}\n`);
      } catch (err) {
        this.settleTurn({ ok: false, text: '', error: `could not write to the session: ${(err as Error).message}` });
      }
    });
  }

  private startTurn(ambient: boolean, resolve: ((r: RunResult) => void) | null): ActiveTurn {
    this.parser.resetTurn();
    const turn: ActiveTurn = {
      ambient,
      resolve,
      ending: null,
      idleTimer: null,
      capTimer: null,
      killTimer: null,
    };
    this.turn = turn;
    // Per-turn, not per-process: between turns a session is *meant* to be
    // silent, and a lifetime timer would kill it for being well behaved.
    turn.capTimer = setTimeout(
      () => this.endTurnEarly(`hit the ${this.cfg.timeoutSec}s run cap`),
      this.cfg.timeoutSec * 1000,
    );
    turn.capTimer.unref();
    this.bumpIdle();
    return turn;
  }

  /**
   * `system`/`init` with nothing in flight means the SDK started a turn on its
   * own — a background task finished and it re-invoked the agent. Announce it
   * so the conversation gets a progress row and, at the end, a reply.
   */
  private onTurnStart(): void {
    if (this.turn !== null) return;
    this.hooks.log('agent re-invoked itself (a background task finished) — following turn');
    this.startTurn(true, null);
    this.hooks.onAmbientStart();
  }

  private onResult(): void {
    if (!this.turn) return;
    this.settleTurn(this.buildResult());
  }

  /** Shape a finished turn's result exactly as the per-turn runtime did. */
  private buildResult(hardError?: string): RunResult {
    const turn = this.turn;
    if (turn?.ending) {
      // A stopped turn never reaches its own conclusion, so the salvage is the
      // last thing the agent said — the only record of the work it did.
      return {
        ok: false,
        text: this.parser.lastText,
        error: turn.ending.error,
        sawSession: this.sawSession,
        interrupted: turn.ending.interrupted,
      };
    }
    if (hardError) {
      return { ok: false, text: this.parser.finalText || this.parser.lastText, error: hardError, sawSession: this.sawSession };
    }
    if (this.parser.sawResult && !this.parser.isError) {
      return { ok: true, text: this.parser.finalText, sawSession: true };
    }
    return {
      ok: false,
      text: this.parser.finalText || this.parser.lastText,
      error: describeResultError(this.parser.errorSubtype, this.cfg.maxTurns),
      sawSession: this.sawSession,
    };
  }

  private settleTurn(result: RunResult): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    this.lastTurnEndAt = Date.now();
    if (turn.idleTimer) clearTimeout(turn.idleTimer);
    if (turn.capTimer) clearTimeout(turn.capTimer);
    if (turn.killTimer) clearTimeout(turn.killTimer);
    if (turn.onAbort) turn.signal?.removeEventListener('abort', turn.onAbort);
    if (result.sawSession) this.resume = true;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
    if (turn.ambient) this.hooks.onAmbientEnd(result);
    else turn.resolve?.(result);
  }

  /**
   * Ask the CLI to end the current turn. The control request is the good path —
   * it stops the turn and leaves the session, and its background tasks, alive.
   * If no `result` follows within the grace we fall back to the process-group
   * kill this used to do unconditionally.
   */
  private endTurnEarly(error: string, interrupted = false): void {
    const turn = this.turn;
    if (!turn || turn.ending) return;
    turn.ending = { error, interrupted };
    if (turn.idleTimer) clearTimeout(turn.idleTimer);
    if (turn.capTimer) clearTimeout(turn.capTimer);
    this.hooks.log(interrupted ? 'run interrupted — asking the session to stop this turn' : `turn expired: ${error} — asking the session to stop it`);
    const request = {
      type: 'control_request',
      request_id: `req_${randomUUID()}`,
      request: { subtype: 'interrupt' },
    };
    const stdin = this.child?.stdin;
    try {
      if (!stdin) throw new Error('no session process');
      stdin.write(`${JSON.stringify(request)}\n`);
    } catch {
      return this.killForStuckTurn();
    }
    turn.killTimer = setTimeout(() => this.killForStuckTurn(), this.interruptGraceMs);
    turn.killTimer.unref();
  }

  /** The interrupt didn't take. Kill the group; the close handler settles. */
  private killForStuckTurn(): void {
    if (!this.turn) return;
    this.hooks.log('the session did not answer the interrupt — killing the process group');
    const pid = this.child?.pid;
    this.child = null;
    this.spawnCleanup?.();
    this.spawnCleanup = null;
    if (pid) {
      killGroup(pid, REAP_GRACE_MS);
      unregisterGroup(pid);
      return; // the close handler settles the turn
    }
    this.settleTurn(this.buildResult('the session process was gone'));
  }

  /**
   * Rearmed by every byte the session emits *while a turn is running*. A turn
   * that is still working narrates itself, so it never expires however long it
   * runs; only genuine mid-turn silence does.
   */
  private bumpIdle(): void {
    const turn = this.turn;
    if (!turn || turn.ending) return;
    if (turn.idleTimer) clearTimeout(turn.idleTimer);
    const limit = idleLimitSec(this.cfg, this.parser.running.size > 0);
    turn.idleTimer = setTimeout(() => this.endTurnEarly(`no output for ${limit}s`), limit * 1000);
    turn.idleTimer.unref();
  }

  /** Spawn if needed. Returns an error string when the spawn itself failed. */
  private ensureProcess(): string | null {
    if (this.child) return null;
    this.disposed = false;
    this.parser = this.newParser();
    this.stderrTail = '';
    const spec = this.makeSpawn();
    const args = buildClaudeArgs(this.cfg, {
      sessionId: this.sessionId,
      resume: this.resume,
      prompt: '',
      systemPrompt: spec.systemPrompt,
      mcpConfigPath: spec.mcpConfigPath,
      streamInput: true,
    });
    let child: ChildProcess;
    try {
      child = spawn(this.cfg.command, args, {
        cwd: this.cfg.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        // Own process group, so a reap or a shutdown takes the agent's whole
        // subprocess tree — background tasks included — and not just the CLI.
        detached: true,
      });
    } catch (err) {
      spec.cleanup?.();
      return `could not spawn ${this.cfg.command}: ${(err as Error).message}`;
    }
    this.child = child;
    this.spawnCleanup = spec.cleanup ?? null;
    if (child.pid) registerGroup(child.pid);
    this.hooks.log(
      `session process ${child.pid} started (${this.resume ? '--resume' : '--session-id'} ${this.sessionId})`,
    );
    child.stdin?.on('error', () => {
      /* the close handler reports a dead CLI */
    });
    child.stdout?.on('data', (d: Buffer) => {
      this.parser.feed(d.toString('utf8'));
      // After the feed, so a tool call that just started gets the longer limit.
      this.bumpIdle();
    });
    child.stderr?.on('data', (d: Buffer) => {
      this.bumpIdle();
      this.stderrTail = `${this.stderrTail}${d.toString('utf8')}`.slice(-2000);
    });
    child.on('error', (err) => this.onExit(null, `could not spawn ${this.cfg.command}: ${err.message}`, child));
    child.on('close', (code) => this.onExit(code, null, child));
    return null;
  }

  /**
   * The process is gone. Any turn waiting on it fails as it did before; the
   * next message respawns and `--resume`s, so the conversation carries on.
   */
  private onExit(code: number | null, spawnError: string | null, child: ChildProcess): void {
    if (this.child !== null && this.child !== child) return; // a later spawn owns us now
    const pid = child.pid;
    if (pid) unregisterGroup(pid);
    this.child = null;
    this.spawnCleanup?.();
    this.spawnCleanup = null;
    this.parser.feed('\n'); // flush a trailing unterminated line
    if (this.sawSession) this.resume = true;
    // Background tasks died with the process — nothing is pending any more, so
    // the reaper isn't held off by ghosts.
    this.parser.pending.clear();
    if (!this.turn) {
      if (!this.disposed) this.hooks.log(`session process ${pid ?? '?'} exited (${spawnError ?? `code ${code}`})`);
      return;
    }
    if (!this.resume && this.stderrTail.includes('already in use')) this.collided = true;
    const error =
      spawnError ??
      (this.parser.sawResult
        ? describeResultError(this.parser.errorSubtype, this.cfg.maxTurns)
        : `runtime exited ${code} without a result${this.stderrTail ? `: ${this.stderrTail.slice(-300)}` : ''}`);
    this.settleTurn(this.buildResult(error));
  }
}

export interface SessionManagerOpts {
  cfg: RuntimeConfig;
  /** Reap a session with nothing in flight and nothing pending after this long. */
  idleMs: number;
  /** …and reap one held open only by background tasks after this long. */
  hardCapMs: number;
  log(msg: string): void;
  /** Overridable for tests; the reaper otherwise wakes on its own timer. */
  sweepMs?: number;
  /** A conversation's session went away — reap, `/reset`, or shutdown. */
  onDispose?(key: string): void;
}

/** How often the reaper looks, unless a caller says otherwise. */
const DEFAULT_SWEEP_MS = 30_000;

/** The live sessions, one per conversation, plus the reaper that ends them. */
export class SessionManager {
  private readonly sessions = new Map<string, RuntimeSession>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: SessionManagerOpts) {
    const every = opts.sweepMs ?? DEFAULT_SWEEP_MS;
    this.sweepTimer = setInterval(() => this.sweep(), every);
    this.sweepTimer.unref();
  }

  /** The session for a conversation, created (not spawned) on first use. */
  session(key: string, make: () => SessionOpts): RuntimeSession {
    let s = this.sessions.get(key);
    if (!s) {
      s = new RuntimeSession(make());
      this.sessions.set(key, s);
    }
    return s;
  }

  get(key: string): RuntimeSession | undefined {
    return this.sessions.get(key);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** `/reset`, or a conversation going away: end the process and forget it. */
  dispose(key: string, reason: string): void {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    s.dispose(reason, 0);
    this.opts.onDispose?.(key);
  }

  /** Bridge shutdown: every live session process dies with us (AC 6). */
  killAll(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    const keys = [...this.sessions.keys()];
    for (const [key, s] of this.sessions) s.dispose(`bridge shutting down (${key})`, 0);
    this.sessions.clear();
    for (const key of keys) this.opts.onDispose?.(key);
  }

  /** One reaper pass — exported behaviour, so tests can drive it directly. */
  sweep(now = Date.now()): void {
    for (const [key, s] of this.sessions) {
      const reason = s.reapReason(now, this.opts.idleMs, this.opts.hardCapMs);
      if (!reason) continue;
      this.opts.log(`reaping the session for ${key}: ${reason} — the next message resumes it`);
      this.sessions.delete(key);
      // SIGTERM first: the CLI flushes its transcript, so `--resume` works.
      s.dispose(reason);
      this.opts.onDispose?.(key);
    }
  }
}
