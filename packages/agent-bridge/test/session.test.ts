// #519: the bridge keeps one CLI process alive per conversation, so background
// work the agent starts survives the turn that started it.
//
// The fake runtime in fixtures/session-runtime.mjs speaks the same stream-json
// protocol the real CLI does (event shapes verified against claude 2.1.250), so
// these exercise the actual wire contract rather than a mock of it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { RuntimeSession, SessionManager, type SessionHooks, type SessionOpts } from '../src/session.js';
import { StreamJsonParser, buildClaudeArgs, killAllRuntimes, type RunResult } from '../src/runtime.js';
import type { RuntimeConfig } from '../src/config.js';

const FAKE = fileURLToPath(new URL('./fixtures/session-runtime.mjs', import.meta.url));
const posix = process.platform !== 'win32';

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    kind: 'claude',
    command: FAKE,
    extraArgs: [],
    cwd: os.tmpdir(),
    allowedTools: [],
    maxTurns: 42,
    timeoutSec: 30,
    idleTimeoutSec: 10,
    sessionIdleSec: 600,
    sessionHardCapSec: 3600,
    mcp: false,
    ...over,
  };
}

interface Harness {
  session: RuntimeSession;
  ambientStarts: number;
  ambient: RunResult[];
  steps: string[];
  texts: string[];
  logs: string[];
  argv(): string[][];
  cleanups: number;
}

const open: RuntimeSession[] = [];

function harness(over: Partial<RuntimeConfig> = {}, opts: Partial<SessionOpts> = {}): Harness {
  const argvLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-session-')), 'argv.jsonl');
  process.env.FAKE_ARGV_LOG = argvLog;
  const h = {
    ambientStarts: 0,
    ambient: [] as RunResult[],
    steps: [] as string[],
    texts: [] as string[],
    logs: [] as string[],
    cleanups: 0,
    argv: () =>
      (fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean) : []).map(
        (l) => JSON.parse(l) as string[],
      ),
  };
  const hooks: SessionHooks = {
    onToolStep: (s) => h.steps.push(s),
    onText: (t) => h.texts.push(t),
    onAmbientStart: () => {
      h.ambientStarts += 1;
    },
    onAmbientEnd: (r) => {
      h.ambient.push(r);
    },
    log: (m) => h.logs.push(m),
  };
  const session = new RuntimeSession({
    cfg: cfg(over),
    sessionId: randomUUID(),
    resume: false,
    makeSpawn: () => ({
      systemPrompt: 'you are a test',
      cleanup: () => {
        h.cleanups += 1;
      },
    }),
    hooks,
    ...opts,
  });
  open.push(session);
  // Object.assign, not a spread: the counters are numbers, and a copy of them
  // would never move.
  return Object.assign(h, { session });
}

const alive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  for (const s of open.splice(0)) s.dispose('test over', 0);
  killAllRuntimes();
  delete process.env.FAKE_ARGV_LOG;
  delete process.env.FAKE_IGNORE_INTERRUPT;
  delete process.env.FAKE_SPAWN_FAILURE;
  delete process.env.FAKE_FAIL_ONCE_FILE;
});

describe.skipIf(!posix)('persistent session', () => {
  // AC 1: two consecutive turns, one OS process, one spawn.
  it('serves consecutive turns from the same process', async () => {
    const h = harness();
    const first = await h.session.runTurn('done %PID%');
    const second = await h.session.runTurn('done %PID%');
    expect(first.ok && second.ok).toBe(true);
    expect(first.text).toBe(second.text);
    expect(first.text).toBe(String(h.session.pid));
    const spawns = h.argv();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toContain('--input-format');
    expect(spawns[0]).toContain('--session-id');
    expect(spawns[0]).not.toContain('--resume');
  });

  // AC 2: the task outlives the turn, and its completion produces a reply
  // nobody asked for.
  it('keeps a background task alive past the turn boundary and posts the follow-up', async () => {
    const h = harness();
    const result = await h.session.runTurn('bg 150 sleepy\ndone STARTED');
    expect(result.text).toBe('STARTED');
    // The turn is over but the work is not — so the session is not idle.
    expect(h.session.turnInFlight).toBe(false);
    expect(h.session.pendingTasks).toBe(1);
    expect(h.session.idle).toBe(false);

    await vi.waitFor(() => expect(h.ambient).toHaveLength(1), { timeout: 5000 });
    expect(h.ambientStarts).toBe(1);
    expect(h.ambient[0]!.ok).toBe(true);
    expect(h.ambient[0]!.text).toBe('sleepy finished');
    expect(h.session.pendingTasks).toBe(0);
    expect(h.session.idle).toBe(true);
    expect(h.argv()).toHaveLength(1); // still the same process
  });

  // AC 3 / 4: what the reaper is allowed to end, and when.
  it('is reapable when idle, held off by a pending task, and released at the hard cap', async () => {
    const h = harness();
    await h.session.runTurn('done ok');
    const now = Date.now();
    expect(h.session.reapReason(now, 600_000, 3_600_000)).toBeNull();
    expect(h.session.reapReason(now + 600_000, 600_000, 3_600_000)).toMatch(/idle for/);

    await h.session.runTurn('bg 60000 forever\ndone STARTED');
    const then = Date.now();
    expect(h.session.pendingTasks).toBe(1);
    // Ten minutes idle, but there is work outstanding — leave it alone.
    expect(h.session.reapReason(then + 600_000, 600_000, 3_600_000)).toBeNull();
    // An hour on, a wedged task no longer buys it any time.
    expect(h.session.reapReason(then + 3_600_000, 600_000, 3_600_000)).toMatch(/cap/);
  });

  it('never reaps a turn that is still running', async () => {
    const h = harness();
    const running = h.session.runTurn('hang');
    await vi.waitFor(() => expect(h.session.turnInFlight).toBe(true), { timeout: 5000 });
    expect(h.session.reapReason(Date.now() + 86_400_000, 600_000, 3_600_000)).toBeNull();
    h.session.interrupt();
    await running;
  });

  // AC 5: the interrupt ends the turn, not the session.
  it('interrupts a turn and keeps the session for the next message', async () => {
    const h = harness();
    const ctl = new AbortController();
    const running = h.session.runTurn('wait 30000\ndone LATE', ctl.signal);
    await vi.waitFor(() => expect(h.session.turnInFlight).toBe(true), { timeout: 5000 });
    const pid = h.session.pid;
    ctl.abort();
    const result = await running;
    expect(result.interrupted).toBe(true);
    expect(result.ok).toBe(false);
    expect(alive(pid)).toBe(true);

    const next = await h.session.runTurn('done %PID%');
    expect(next.ok).toBe(true);
    expect(next.text).toBe(String(pid));
    expect(h.argv()).toHaveLength(1); // no respawn
  });

  it('falls back to killing the process group when the interrupt is ignored', async () => {
    process.env.FAKE_IGNORE_INTERRUPT = '1';
    const h = harness({}, { interruptGraceMs: 300 });
    const ctl = new AbortController();
    const running = h.session.runTurn('wait 30000\ndone LATE', ctl.signal);
    await vi.waitFor(() => expect(h.session.turnInFlight).toBe(true), { timeout: 5000 });
    const pid = h.session.pid;
    ctl.abort();
    const result = await running;
    expect(result.interrupted).toBe(true);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 });
    // …and the conversation carries on: the next message respawns and resumes.
    const next = await h.session.runTurn('done again');
    expect(next.ok).toBe(true);
    const spawns = h.argv();
    expect(spawns).toHaveLength(2);
    expect(spawns[1]).toContain('--resume');
  });

  // The whole point of making the timers per-turn: quiet between turns is normal.
  it('does not expire a session for being silent between turns', async () => {
    const h = harness({ idleTimeoutSec: 1, timeoutSec: 2 });
    const first = await h.session.runTurn('done %PID%');
    await new Promise((r) => setTimeout(r, 2500));
    const second = await h.session.runTurn('done %PID%');
    expect(second.ok).toBe(true);
    expect(second.text).toBe(first.text);
    expect(h.argv()).toHaveLength(1);
  });

  it('still expires a turn that goes silent while it is running', async () => {
    const h = harness({ idleTimeoutSec: 1 });
    const result = await h.session.runTurn('say working\nhang');
    expect(result.ok).toBe(false);
    expect(result.interrupted).toBeFalsy();
    expect(result.error).toBe('no output for 1s');
    expect(result.text).toBe('working'); // salvage, as before
    expect(alive(h.session.pid)).toBe(true); // the session itself is fine
  });

  // The CLI prints nothing while a tool runs: a long build or a slow `gh` must not read as a wedged turn.
  it('allows the longer tool limit while a tool call is running', async () => {
    const h = harness({ idleTimeoutSec: 1, toolIdleTimeoutSec: 5 });
    const result = await h.session.runTurn('tool Bash pnpm test\nwait 2000\nresult\ndone finished');
    expect(result.ok).toBe(true);
    expect(result.text).toBe('finished');
  });

  it('still expires a tool call that hangs past the tool limit', async () => {
    const h = harness({ idleTimeoutSec: 1, toolIdleTimeoutSec: 2 });
    const result = await h.session.runTurn('say pushing\ntool Bash gh pr create\nhang');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no output for 2s');
    expect(result.text).toBe('pushing');
  });

  it('goes back to the short limit once the tool has returned', async () => {
    const h = harness({ idleTimeoutSec: 1, toolIdleTimeoutSec: 5 });
    const result = await h.session.runTurn('tool Bash ls\nresult\nhang');
    expect(result.error).toBe('no output for 1s');
  });

  // AC 8: the failure reporting a turn already had, unchanged.
  it('reports a max-turns result the way it always did', async () => {
    const h = harness();
    const result = await h.session.runTurn('say partial work\nfail error_max_turns');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('agent exceeded max turns (42)');
    expect(result.sawSession).toBe(true);
  });

  it('salvages the last thing the agent said when the CLI dies mid-turn', async () => {
    const h = harness();
    const result = await h.session.runTurn('say got this far\ndie');
    expect(result.ok).toBe(false);
    expect(result.text).toBe('got this far');
    expect(result.error).toMatch(/exited 9 without a result/);
    expect(result.sawSession).toBe(true);
  });

  it('retries a session-id collision with --resume, transparently', async () => {
    const once = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-collide-')), 'flag');
    process.env.FAKE_SPAWN_FAILURE = 'session id abc is already in use';
    process.env.FAKE_FAIL_ONCE_FILE = once;
    const h = harness();
    const result = await h.session.runTurn('done recovered');
    expect(result.ok).toBe(true);
    expect(result.text).toBe('recovered');
    const spawns = h.argv();
    expect(spawns).toHaveLength(2);
    expect(spawns[0]).toContain('--session-id');
    expect(spawns[1]).toContain('--resume');
  });

  it('drops the spawn scratch files when the session ends', async () => {
    const h = harness();
    await h.session.runTurn('done ok');
    expect(h.cleanups).toBe(0);
    h.session.dispose('test', 0);
    expect(h.cleanups).toBe(1);
  });
});

describe.skipIf(!posix)('SessionManager', () => {
  const managers: SessionManager[] = [];
  const make = (idleMs: number, hardCapMs: number): SessionManager => {
    const m = new SessionManager({ cfg: cfg(), idleMs, hardCapMs, log: () => {}, sweepMs: 3_600_000 });
    managers.push(m);
    return m;
  };
  afterEach(() => {
    for (const m of managers.splice(0)) m.killAll();
  });

  const opts = (): SessionOpts => ({
    cfg: cfg(),
    sessionId: randomUUID(),
    resume: false,
    makeSpawn: () => ({ systemPrompt: 'test' }),
    hooks: { onToolStep: () => {}, onText: () => {}, onAmbientStart: () => {}, onAmbientEnd: () => {}, log: () => {} },
  });

  // AC 3: reaped when idle, and the next message just works.
  it('reaps an idle session and respawns it with --resume on the next message', async () => {
    const argvLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-mgr-')), 'argv.jsonl');
    process.env.FAKE_ARGV_LOG = argvLog;
    const m = make(600_000, 3_600_000);
    const spec = opts();
    const first = m.session('c1', () => spec);
    await first.runTurn('done ok');
    const pid = first.pid;

    m.sweep(Date.now() + 600_000);
    expect(m.size).toBe(0);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 });

    const again = m.session('c1', () => ({ ...opts(), sessionId: 'reused', resume: true }));
    const result = await again.runTurn('done back');
    expect(result.text).toBe('back');
    const spawns = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]).toContain('--resume');
    delete process.env.FAKE_ARGV_LOG;
  });

  // AC 4: a pending task holds the reaper off, then the cap lets go.
  it('leaves a session with a pending task alone until the hard cap', async () => {
    const m = make(600_000, 3_600_000);
    const s = m.session('c2', opts);
    await s.runTurn('bg 60000 long job\ndone STARTED');
    expect(s.pendingTasks).toBe(1);
    m.sweep(Date.now() + 600_000);
    expect(m.size).toBe(1);
    m.sweep(Date.now() + 3_600_000);
    expect(m.size).toBe(0);
  });

  // AC 6: shutdown takes every live session process with it.
  it('kills every live session process on shutdown', async () => {
    const m = make(600_000, 3_600_000);
    const a = m.session('c3', opts);
    const b = m.session('c4', opts);
    await Promise.all([a.runTurn('done a'), b.runTurn('done b')]);
    const pids = [a.pid, b.pid];
    expect(pids.every(alive)).toBe(true);
    m.killAll();
    expect(m.size).toBe(0);
    await vi.waitFor(() => expect(pids.some(alive)).toBe(false), { timeout: 5000 });
  });

  it('ends the process on /reset so the next message starts clean', async () => {
    const m = make(600_000, 3_600_000);
    const s = m.session('c5', opts);
    await s.runTurn('done ok');
    const pid = s.pid;
    m.dispose('c5', 'context reset');
    expect(m.size).toBe(0);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 });
  });
});

describe('background-task tracking in the stream', () => {
  const parse = (events: object[]): StreamJsonParser => {
    const p = new StreamJsonParser(() => {});
    for (const e of events) p.feed(`${JSON.stringify(e)}\n`);
    return p;
  };

  it('opens a pending entry on a run_in_background tool call', () => {
    const p = parse([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 90', run_in_background: true } }] },
      },
    ]);
    expect(p.pending.size).toBe(1);
  });

  it('leaves a foreground tool call out of it', () => {
    const p = parse([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } },
    ]);
    expect(p.pending.size).toBe(0);
  });

  it('closes the entry when the task reports it is done', () => {
    const p = parse([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 90', run_in_background: true } }] },
      },
      { type: 'system', subtype: 'task_started', task_id: 'bg1', tool_use_id: 'toolu_1', is_backgrounded: true },
      { type: 'system', subtype: 'task_notification', task_id: 'bg1', tool_use_id: 'toolu_1', status: 'completed' },
    ]);
    expect(p.pending.size).toBe(0);
  });

  it('takes the tasks snapshot as the truth, so a task that never starts cannot pin a session', () => {
    const p = parse([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 90', run_in_background: true } }] },
      },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
    ]);
    expect(p.pending.size).toBe(0);
  });

  it('counts several tasks and clears them as they finish', () => {
    const p = parse([
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a', description: 'one' }, { task_id: 'b', description: 'two' }] },
    ]);
    expect(p.pending.size).toBe(2);
    p.feed(`${JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'a', status: 'completed' })}\n`);
    expect(p.pending.size).toBe(1);
  });

  it('keeps pending work across a turn reset, and forgets the turn verdict', () => {
    const p = parse([
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a', description: 'one' }] },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'started it' }] } },
      { type: 'result', subtype: 'error_max_turns', result: 'nope' },
    ]);
    expect(p.sawResult).toBe(true);
    p.resetTurn();
    expect(p.sawResult).toBe(false);
    expect(p.isError).toBe(false);
    expect(p.lastText).toBe('');
    expect(p.sawEvent).toBe(true); // the session still exists
    expect(p.pending.size).toBe(1); // and its background work still runs
  });

  it('reports turn boundaries so a self-started turn can be told apart', () => {
    const starts: number[] = [];
    const results: number[] = [];
    const p = new StreamJsonParser(() => {}, () => {}, {
      onTurnStart: () => starts.push(1),
      onResult: () => results.push(1),
    });
    p.feed(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);
    p.feed(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'a' })}\n`);
    p.feed(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);
    p.feed(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'b' })}\n`);
    expect(starts).toHaveLength(2);
    expect(results).toHaveLength(2);
  });
});

describe('claude argv for a persistent session', () => {
  it('asks for stream-json input and leaves the prompt off the command line', () => {
    const args = buildClaudeArgs(cfg(), {
      sessionId: 'sid',
      resume: false,
      prompt: 'never on the command line',
      systemPrompt: 'sys',
      streamInput: true,
    });
    expect(args.join(' ')).toContain('--input-format stream-json');
    expect(args).not.toContain('never on the command line');
    expect(args).toContain('--session-id');
  });

  it('still builds the one-shot form for the runtimes that use it', () => {
    const args = buildClaudeArgs(cfg(), { sessionId: 'sid', resume: true, prompt: 'hello', systemPrompt: 'sys' });
    expect(args).not.toContain('--input-format');
    expect(args).toContain('--resume');
    expect(args[args.length - 1]).toBe('hello');
  });
});
