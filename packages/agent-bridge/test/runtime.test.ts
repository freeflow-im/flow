import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CodexJsonParser,
  DEMO_REPLY,
  StreamJsonParser,
  buildClaudeArgs,
  buildCodexArgs,
  describeResultError,
  formatToolStep,
  parseCodexSessionId,
  runRuntime,
} from '../src/runtime.js';
import type { RuntimeConfig } from '../src/config.js';
import { expandHome, loadConfig } from '../src/config.js';

/**
 * Idle window for the tests that spawn a real script and wait to be reaped.
 * Wide enough to cover process spawn on a loaded box — at 0.4s these went red
 * whenever the rest of the suite was competing for cores, and a test that
 * measures the machine instead of the code is worse than a slower one.
 */
const IDLE = 1.5;

describe('StreamJsonParser', () => {
  it('collects tool steps and the final result across chunk boundaries', () => {
    const steps: string[] = [];
    const p = new StreamJsonParser((s) => steps.push(s));
    const line1 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }] },
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'thinking' }, { type: 'tool_use', name: 'Read', input: { file_path: '/a/b/c.ts' } }] },
    });
    const line3 = JSON.stringify({ type: 'result', subtype: 'success', result: 'all done', is_error: false });
    const raw = `${line1}\n${line2}\n${line3}\n`;
    // feed in awkward chunks
    p.feed(raw.slice(0, 20));
    p.feed(raw.slice(20, 21));
    p.feed(raw.slice(21));
    expect(steps).toEqual(['Bash(pnpm)', 'Read']);
    expect(p.sawResult).toBe(true);
    expect(p.isError).toBe(false);
    expect(p.finalText).toBe('all done');
    expect(p.sawEvent).toBe(true);
    expect(p.lastText).toBe('thinking'); // salvage for a run that never reaches a result
  });

  it('keeps the newest assistant text and ignores empty blocks', () => {
    const p = new StreamJsonParser(() => {});
    const say = (text: string): string =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    p.feed(`${say('first pass')}\n${say('   ')}\n${say('second pass')}\n`);
    expect(p.lastText).toBe('second pass');
    expect(p.sawResult).toBe(false); // no result event — but the session exists
    expect(p.sawEvent).toBe(true);
  });

  it('does not mistake non-JSON noise for a live session', () => {
    const p = new StreamJsonParser(() => {});
    p.feed('claude: command not found\n');
    expect(p.sawEvent).toBe(false);
  });

  it('ignores non-JSON noise and flags error results', () => {
    const p = new StreamJsonParser(() => {});
    p.feed('not json at all\n');
    p.feed(`${JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: 'ran out' })}\n`);
    expect(p.sawResult).toBe(true);
    expect(p.isError).toBe(true);
    expect(p.errorSubtype).toBe('error_max_turns');
    expect(p.finalText).toBe('ran out');
  });

  it('keeps no subtype for a successful result', () => {
    const p = new StreamJsonParser(() => {});
    p.feed(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'fine', is_error: false })}\n`);
    expect(p.errorSubtype).toBe('');
  });

  // #162: the text blocks used to be parsed and dropped, so every normal turn
  // discarded the agent's running commentary.
  it('emits every assistant text block as it arrives', () => {
    const said: string[] = [];
    const p = new StreamJsonParser(
      () => {},
      (t) => said.push(t),
    );
    const say = (text: string): string =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    p.feed(`${say('  reading the parser  ')}\n${say('')}\n${say('now writing the test')}\n`);
    expect(said).toEqual(['reading the parser', 'now writing the test']);
  });

  it('emits text in the order it appears alongside tool calls', () => {
    const events: string[] = [];
    const p = new StreamJsonParser(
      (s) => events.push(`step:${s}`),
      (t) => events.push(`text:${t}`),
    );
    p.feed(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'let me check the tests' },
            { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
          ],
        },
      })}\n`,
    );
    expect(events).toEqual(['text:let me check the tests', 'step:Bash(pnpm)']);
  });

  it('swallows a block identical to the one before it', () => {
    // Relaying the same sentence twice reads as a glitch, not as progress.
    const said: string[] = [];
    const p = new StreamJsonParser(
      () => {},
      (t) => said.push(t),
    );
    const say = (text: string): string =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    p.feed(`${say('on it')}\n${say('on it')}\n${say('still on it')}\n`);
    expect(said).toEqual(['on it', 'still on it']);
    expect(p.lastText).toBe('still on it');
  });

  it('needs no text callback — the salvage path still works', () => {
    const p = new StreamJsonParser(() => {});
    p.feed(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'got here' }] } })}\n`);
    expect(p.lastText).toBe('got here');
  });
});

describe('describeResultError', () => {
  // The turn cap is the common failure and the one an operator can fix, so it
  // has to be nameable from the chat message alone.
  it('names the turn cap and carries its value', () => {
    expect(describeResultError('error_max_turns', 200)).toBe('agent exceeded max turns (200)');
  });

  it('passes any other subtype through rather than swallowing it', () => {
    expect(describeResultError('error_during_execution', 200)).toBe('runtime reported error_during_execution');
  });

  it('falls back when the runtime flagged an error with no subtype', () => {
    expect(describeResultError('', 200)).toBe('runtime reported an error');
  });
});

// #550/#552: the status row names the *kind* of step, never its arguments —
// a full path wraps over four lines on a phone and says nothing extra.
describe('formatToolStep', () => {
  it('reduces a tool call to its bare name', () => {
    expect(formatToolStep('Read', { file_path: '/tmp/deep/nested/runtime.ts' })).toBe('Read');
    expect(formatToolStep('Edit', { file_path: '/tmp/a.ts' })).toBe('Edit');
    expect(formatToolStep('Grep', { pattern: 'foo.*bar' })).toBe('Grep');
    expect(formatToolStep('WebFetch', { url: 'https://example.com/x' })).toBe('WebFetch');
    expect(formatToolStep('SomethingNew', { whatever: 1 })).toBe('SomethingNew');
    expect(formatToolStep('Read', undefined)).toBe('Read');
  });

  it('names the sub-command for Bash', () => {
    expect(formatToolStep('Bash', { command: 'ls   -la' })).toBe('Bash(ls)');
    expect(formatToolStep('Bash', { command: 'sed -n 240,300p /tmp/wt/packages/agent-bridge/src/runtime.ts' })).toBe('Bash(sed)');
    expect(formatToolStep('Bash', { command: '/usr/bin/git status' })).toBe('Bash(git)');
  });

  it('skips env-var prefixes ahead of the command', () => {
    expect(formatToolStep('Bash', { command: 'FOO=1 BAR=baz pnpm test' })).toBe('Bash(pnpm)');
    expect(formatToolStep('Bash', { command: 'env NODE_ENV=test npx vitest run' })).toBe('Bash(npx)');
  });

  it('takes the head of a compound or piped command', () => {
    expect(formatToolStep('Bash', { command: 'cd x && pnpm test' })).toBe('Bash(cd)');
    expect(formatToolStep('Bash', { command: 'cat big.log | grep -i error | head -20' })).toBe('Bash(cat)');
    expect(formatToolStep('Bash', { command: 'make build; make test' })).toBe('Bash(make)');
  });

  it('unwraps a shell -c wrapper to the command inside it', () => {
    expect(formatToolStep('Bash', { command: "/bin/zsh -lc 'echo hello-from-codex'" })).toBe('Bash(echo)');
    expect(formatToolStep('Bash', { command: '/bin/bash -c "pnpm -r build"' })).toBe('Bash(pnpm)');
  });

  it('falls back to a bare Bash when there is no command word', () => {
    expect(formatToolStep('Bash', {})).toBe('Bash');
    expect(formatToolStep('Bash', { command: '   ' })).toBe('Bash');
  });

  it('shortens MCP tool ids to server: tool', () => {
    expect(formatToolStep('mcp__flow__send_message', {})).toBe('flow: send_message');
    expect(formatToolStep('mcp__github__create_pull_request', {})).toBe('github: create_pull_request');
  });

  it('names the skill or subagent for wrapper tools', () => {
    expect(formatToolStep('Skill', { skill: 'commit-helper', args: '--all' })).toBe('Skill(commit-helper)');
    expect(formatToolStep('Task', { subagent_type: 'Explore', prompt: 'find the thing' })).toBe('Agent(Explore)');
    expect(formatToolStep('Agent', { subagent_type: 'Explore' })).toBe('Agent(Explore)');
    // No usable sub-name (or one that is really an argument) → still just the name.
    expect(formatToolStep('Skill', { skill: '/tmp/some/path' })).toBe('Skill');
    expect(formatToolStep('Task', { prompt: 'do a thing' })).toBe('Agent');
  });

  it('never leaks arguments or paths into the row', () => {
    const rows = [
      formatToolStep('Bash', { command: 'sed -n 240,300p /tmp/flow-wt/packages/agent-bridge/src/runtime.ts' }),
      formatToolStep('Read', { file_path: '/tmp/flow-wt/packages/agent-bridge/src/runtime.ts' }),
      formatToolStep('Grep', { pattern: '/tmp/secret' }),
      formatToolStep('WebFetch', { url: 'https://example.com/a/b' }),
    ];
    for (const row of rows) {
      expect(row).not.toContain('/');
      expect(row.length).toBeLessThanOrEqual(24);
    }
  });
});

describe('buildClaudeArgs permissions', () => {
  const base: RuntimeConfig = {
    kind: 'claude', command: 'claude', extraArgs: [], cwd: '/tmp',
    permissionMode: undefined, allowedTools: [], maxTurns: 100, timeoutSec: 300, idleTimeoutSec: 120, sessionIdleSec: 600, sessionHardCapSec: 3600,
    mcp: false, systemPromptExtra: undefined,
  };
  const opts = { sessionId: 's', resume: false, prompt: 'p', systemPrompt: '', onToolStep: () => {}, log: () => {} };

  it('defaults to bypassPermissions (allow everything)', () => {
    const args = buildClaudeArgs(base, opts);
    expect(args.join(' ')).toContain('--permission-mode bypassPermissions');
    expect(args.join(' ')).not.toContain('--allowedTools');
  });

  it('allowedTools opts into scoped permissions (no bypass)', () => {
    const args = buildClaudeArgs({ ...base, allowedTools: ['Read'] }, opts);
    expect(args.join(' ')).not.toContain('bypassPermissions');
    expect(args.join(' ')).toContain('--allowedTools=Read');
  });

  it('explicit permissionMode always wins', () => {
    const args = buildClaudeArgs({ ...base, permissionMode: 'acceptEdits' }, opts);
    expect(args.join(' ')).toContain('--permission-mode acceptEdits');
    expect(args.join(' ')).not.toContain('bypassPermissions');
  });

  it('runtime.model passes --model; unset omits it', () => {
    expect(buildClaudeArgs({ ...base, model: 'opus' }, opts).join(' ')).toContain('--model opus');
    expect(buildClaudeArgs(base, opts).join(' ')).not.toContain('--model');
  });
});

describe('buildCodexArgs', () => {
  const config: RuntimeConfig = {
    kind: 'codex', command: 'codex', extraArgs: [], cwd: '/tmp',
    permissionMode: undefined, allowedTools: [], maxTurns: 100, timeoutSec: 300, idleTimeoutSec: 120, sessionIdleSec: 600, sessionHardCapSec: 3600,
    mcp: false, systemPromptExtra: undefined,
  };

  it('carries the voice/system instructions into the authenticated CLI invocation', () => {
    const args = buildCodexArgs(config, {
      sessionId: 'unused',
      resume: false,
      prompt: 'Mahad: fix the PR',
      systemPrompt: 'You are the same Flow agent in a live Huddle.',
      onToolStep: () => {},
      log: () => {},
    });

    expect(args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      'You are the same Flow agent in a live Huddle.\n\nMahad: fix the PR',
    ]);
  });

  // A stored session id flips the invocation to `exec resume <id>`: codex
  // reloads the session's context itself, so the prompt carries only the new
  // turn and the system prompt (already in the session) is not re-sent.
  it('resumes a recorded session with only the new turn as the prompt', () => {
    const args = buildCodexArgs({ ...config, extraArgs: ['--dangerously-bypass-approvals-and-sandbox'] }, {
      sessionId: 'unused',
      resume: true,
      codexSessionId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
      prompt: 'Mahad: now fix the tests',
      systemPrompt: 'You are the same Flow agent in a live Huddle.',
      onToolStep: () => {},
      log: () => {},
    });

    expect(args).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
      'Mahad: now fix the tests',
    ]);
    expect(args.join(' ')).not.toContain('You are the same Flow agent');
  });

  it('keeps images and the stdin sentinel after the session id', () => {
    const args = buildCodexArgs(config, {
      sessionId: 'unused',
      resume: true,
      codexSessionId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
      imagePaths: ['/tmp/shot.png'],
      stdinPrompt: true,
      prompt: 'look at this',
      systemPrompt: 'sys',
      onToolStep: () => {},
      log: () => {},
    });
    expect(args).toEqual([
      'exec', 'resume', '--json', '--skip-git-repo-check', '--image=/tmp/shot.png', '--',
      '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000', '-',
    ]);
  });
});

// The `session id:` header is the fallback now — `--json` reports the id as
// `thread.started.thread_id` and prints no header at all (#552).
describe('parseCodexSessionId', () => {
  const header = [
    'model: gpt-6-astra',
    'provider: openai',
    'session id: 01a0881d-f3ff-76d2-958e-071dbc29616a',
    '--------',
  ].join('\n');

  it('reads the id from the run header (stderr in non-tty runs)', () => {
    expect(parseCodexSessionId(header, 'the reply')).toBe('01a0881d-f3ff-76d2-958e-071dbc29616a');
  });

  it('falls back to stdout, and stderr wins when both carry one', () => {
    expect(parseCodexSessionId('', header)).toBe('01a0881d-f3ff-76d2-958e-071dbc29616a');
    const other = 'session id: 99999999-0000-7000-8000-000000000000';
    expect(parseCodexSessionId(header, other)).toBe('01a0881d-f3ff-76d2-958e-071dbc29616a');
  });

  it('never matches prose that mentions a session id without the header shape', () => {
    expect(parseCodexSessionId('I lost the session id: sorry', '')).toBeUndefined();
    expect(parseCodexSessionId('', 'session id: not-a-uuid')).toBeUndefined();
  });
});

// A run ends when it goes quiet, not when it gets long: these drive real
// spawns through fake runtime scripts, so the timers, the process-group kill
// and the stdout rearm are all exercised for real.
// These fixtures require /bin/sh and POSIX process groups. Cross-platform
// subprocess input is covered separately in huddle-integration.test.ts.
describe.skipIf(process.platform === 'win32')('run expiry (POSIX)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-runtime-'));
  const TICK = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"tick"}}]}}';
  const DONE = '{"type":"result","subtype":"success","result":"done","is_error":false}';

  /** A fake `claude` — it ignores the CLI flags buildClaudeArgs passes it. */
  function script(name: string, body: string): string {
    const p = path.join(dir, `${name}.sh`);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  }
  function cfg(command: string, over: Partial<RuntimeConfig> = {}): RuntimeConfig {
    return {
      kind: 'claude', command, extraArgs: [], cwd: dir, permissionMode: undefined,
      allowedTools: [], maxTurns: 10, timeoutSec: 30, idleTimeoutSec: IDLE, sessionIdleSec: 600, sessionHardCapSec: 3600,
      mcp: false, systemPromptExtra: undefined, ...over,
    };
  }
  const run = (c: RuntimeConfig): ReturnType<typeof runRuntime> =>
    runRuntime(c, { sessionId: 's', resume: false, prompt: 'p', systemPrompt: '', onToolStep: () => {}, log: () => {} });

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a one-shot run allows the tool limit while a tool call is running, and the short one after', async () => {
    const use = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"pnpm test"}}]}}';
    const back = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}';
    const slow = await run(cfg(script('slow-tool', `echo '${use}'; sleep 3; echo '${back}'; echo '${DONE}'`), { toolIdleTimeoutSec: 10 }));
    expect(slow).toMatchObject({ ok: true, text: 'done' });
    const after = await run(cfg(script('after-tool', `echo '${use}'; echo '${back}'; sleep 60`), { toolIdleTimeoutSec: 10 }));
    expect(after).toMatchObject({ ok: false, error: `no output for ${IDLE}s` });
  }, 15_000); // two runs: a 3 s tool, then a 1.5 s expiry

  // The whole point of the subtype: the reply has to name the cap, and the cap
  // it names has to be the one this run was actually given.
  it('reports a turn-cap failure by name, with the run’s own cap', async () => {
    const capped = '{"type":"result","subtype":"error_max_turns","result":"Now a unit test:","is_error":true}';
    // A real idle window: this run is about its *result*, and on a busy box the
    // 0.4s default expired it before the script got a chance to print.
    const res = await run(cfg(script('capped', `echo '${TICK}'; echo '${capped}'`), { maxTurns: 200, idleTimeoutSec: 10 }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('agent exceeded max turns (200)');
    expect(res.text).toBe('Now a unit test:'); // partial work still rides along as salvage
  });

  it('kills a run that goes silent', async () => {
    const res = await run(cfg(script('silent', 'sleep 30')));
    expect(res.ok).toBe(false);
    expect(res.error).toBe(`no output for ${IDLE}s`);
  });

  it('lets a chatty run outlive the idle window — output rearms it', async () => {
    // 12 ticks × 100ms ≈ 1.2s of work under a 0.4s idle window: a fixed
    // wall-clock timeout of the same length would have killed this.
    const p = script('chatty', `i=0\nwhile [ $i -lt 12 ]; do\n  echo '${TICK}'\n  sleep 0.1\n  i=$((i+1))\ndone\necho '${DONE}'`);
    const res = await run(cfg(p));
    expect(res).toMatchObject({ ok: true, text: 'done', sawSession: true });
  });

  it('salvages the last thing the agent said, and reports the session as resumable', () => {
    // The regression: hours of work vanished into an error string because the
    // terminal result event never arrives for a killed run.
    const say = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Found the leak in the WS reconnect path.' }] },
    }).replace(/'/g, `'\\''`);
    const p = script('salvage', `echo '${say}'\nsleep 30`);
    return run(cfg(p)).then((res) => {
      expect(res.ok).toBe(false);
      expect(res.error).toBe(`no output for ${IDLE}s`);
      expect(res.text).toBe('Found the leak in the WS reconnect path.');
      expect(res.sawSession).toBe(true); // → the bridge keeps the session id
    });
  });

  it('reports no session when the CLI dies before emitting anything', async () => {
    const res = await run(cfg(script('stillborn', 'echo "boom" >&2\nexit 1')));
    expect(res.ok).toBe(false);
    expect(res.sawSession).toBe(false); // → the bridge rerolls to a fresh id
    expect(res.text).toBe('');
  });

  it('still enforces the absolute run cap on a runaway', async () => {
    const p = script('forever', `while true; do\n  echo '${TICK}'\n  sleep 0.1\ndone`);
    const res = await run(cfg(p, { idleTimeoutSec: 30, timeoutSec: 0.5 }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('hit the 0.5s run cap');
  });

  it('takes the whole process group down, not just the CLI', async () => {
    // The regression: a bare child.kill() left Bash-tool grandchildren (builds,
    // test runs, dev servers) orphaned and running after the turn was killed.
    const pidFile = path.join(dir, 'grandchild.pid');
    const p = script('grandchild', `sleep 60 &\necho $! > ${pidFile}\necho starting\nsleep 60`);
    const res = await run(cfg(p));
    expect(res.ok).toBe(false);
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    // Long enough to cover the SIGTERM→SIGKILL escalation (5s), not just the
    // SIGTERM: waiting only 2s made this fail whenever the box was busy.
    for (let i = 0; i < 130 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  });
});

// #552: codex speaks its own JSONL dialect — a turn is a sequence of items.
// Sample events below are copied from a live codex-cli 0.153.4 run.
describe('CodexJsonParser', () => {
  const make = (): { p: CodexJsonParser; steps: string[]; texts: string[] } => {
    const steps: string[] = [];
    const texts: string[] = [];
    return { p: new CodexJsonParser((s) => steps.push(s), (t) => texts.push(t)), steps, texts };
  };
  const ID = '01a08d6d-2df6-7ba1-935c-2718689dbaa5';

  it('reads a whole turn: thread id, tool steps, and the reply', () => {
    const { p, steps, texts } = make();
    p.feed([
      JSON.stringify({ type: 'thread.started', thread_id: ID }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I’ll run the command.' } }),
      JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'echo hello-from-codex'", status: 'in_progress' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'echo hello-from-codex'", exit_code: 0, aggregated_output: 'hello-from-codex\n' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'It printed: hello-from-codex' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 32071 } }),
      '',
    ].join('\n'));

    expect(p.threadId).toBe(ID);
    // Announced once, when the command starts — not again on completion.
    expect(steps).toEqual(['Bash(echo)']);
    expect(texts).toEqual(['I’ll run the command.', 'It printed: hello-from-codex']);
    // Latest agent_message wins: the reply, and the salvage on a killed run.
    expect(p.lastText).toBe('It printed: hello-from-codex');
    expect(p.sawEvent).toBe(true);
  });

  it('names the command inside the shell wrapper, not the wrapper', () => {
    const { p, steps } = make();
    p.feed(`${JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: '/bin/zsh -lc \'sed -n 1,80p /tmp/wt/src/runtime.ts\'' } })}\n`);
    expect(steps).toEqual(['Bash(sed)']);
  });

  it('ignores unknown item types and non-JSON noise instead of failing', () => {
    const { p, steps, texts } = make();
    p.feed([
      'codex: warning: something plain-text',
      '{ not json at all',
      JSON.stringify({ type: 'item.started', item: { type: 'reasoning', text: 'thinking' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'some_future_thing', payload: 42 } }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'nope' } }),
      '',
    ].join('\n'));
    expect(steps).toEqual([]);
    expect(texts).toEqual([]);
    expect(p.lastText).toBe('');
  });

  it('survives events split across chunk boundaries', () => {
    const { p, steps } = make();
    const line = JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'pnpm test' } });
    p.feed(line.slice(0, 20));
    p.feed(`${line.slice(20)}\n`);
    expect(steps).toEqual(['Bash(pnpm)']);
    // An unterminated trailing line stays buffered until its newline arrives.
    p.feed(JSON.stringify({ type: 'thread.started', thread_id: ID }));
    expect(p.threadId).toBeUndefined();
    p.feed('\n');
    expect(p.threadId).toBe(ID);
  });

  it('labels the item types it knows and skips the rest', () => {
    const { p, steps } = make();
    p.feed([
      JSON.stringify({ type: 'item.started', item: { type: 'file_change', changes: [{ path: '/tmp/a.ts' }] } }),
      JSON.stringify({ type: 'item.started', item: { type: 'web_search', query: 'flow bridge' } }),
      '',
    ].join('\n'));
    expect(steps).toEqual(['Edit', 'WebSearch']);
    for (const s of steps) expect(s).not.toContain('/');
  });
});

// Real spawns against a fake `codex`. The JSONL stream on stdout is the live
// contract; the `session id:` header tests below pin the fallback path, which
// is what a codex build that ignored `--json` would leave us with.
describe.skipIf(process.platform === 'win32')('codex session capture (POSIX)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-codex-'));
  const ID = '01a0881d-f3ff-76d2-958e-071dbc29616a';

  function script(name: string, body: string): string {
    const p = path.join(dir, `${name}.sh`);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  }
  function cfg(command: string): RuntimeConfig {
    return {
      kind: 'codex', command, extraArgs: [], cwd: dir, permissionMode: undefined,
      allowedTools: [], maxTurns: 10, timeoutSec: 30, idleTimeoutSec: 5, sessionIdleSec: 600, sessionHardCapSec: 3600,
      mcp: false, systemPromptExtra: undefined,
    };
  }
  const run = (c: RuntimeConfig, codexSessionId?: string, onToolStep: (s: string) => void = () => {}): ReturnType<typeof runRuntime> =>
    runRuntime(c, { sessionId: 's', resume: false, codexSessionId, prompt: 'p', systemPrompt: 'sys', onToolStep, log: () => {} });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('hands the header id back beside the stdout reply', async () => {
    const p = script('ok', `echo "session id: ${ID}" >&2; echo "the reply"`);
    const res = await run(cfg(p));
    expect(res).toMatchObject({ ok: true, text: 'the reply', sawSession: true, codexSessionId: ID });
  });

  it('a failed run that recorded itself is still marked resumable', async () => {
    const p = script('fail', `echo "session id: ${ID}" >&2; echo "credit limit" >&2; exit 1`);
    const res = await run(cfg(p));
    expect(res.ok).toBe(false);
    expect(res.codexSessionId).toBe(ID);
    expect(res.sawSession).toBe(true);
  });

  it('a run that died before the header proves no session', async () => {
    const p = script('early', `echo "spawn error" >&2; exit 1`);
    const res = await run(cfg(p));
    expect(res.ok).toBe(false);
    expect(res.codexSessionId).toBeUndefined();
    expect(res.sawSession).toBe(false);
  });

  it('an expired run still salvages the id it printed', async () => {
    const p = script('hang', `echo "session id: ${ID}" >&2; echo "partial"; sleep 60`);
    const c = { ...cfg(p), idleTimeoutSec: IDLE };
    const res = await run(c);
    expect(res.ok).toBe(false);
    expect(res.codexSessionId).toBe(ID);
    expect(res.text).toBe('partial');
  });

  it('resume passes the id through to the CLI argv', async () => {
    const p = script('argv', `echo "$@" >&2; echo "resumed"`);
    const res = await run(cfg(p), ID);
    expect(res.ok).toBe(true);
    expect(res.text).toBe('resumed');
  });

  // The live path: `--json`, so the id is structural and the steps are real.
  const jsonl = (lines: object[]): string =>
    lines.map((l) => `echo '${JSON.stringify(l).replace(/'/g, "'\\''")}'`).join('\n');

  it('takes the session id from thread.started and the reply from the last agent_message', async () => {
    const steps: string[] = [];
    const p = script('json-ok', jsonl([
      { type: 'thread.started', thread_id: ID },
      { type: 'item.completed', item: { type: 'agent_message', text: 'working on it' } },
      { type: 'item.started', item: { type: 'command_execution', command: "/bin/zsh -lc 'pnpm -r build'" } },
      { type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'the build is green' } },
      { type: 'turn.completed', usage: {} },
    ]));
    const res = await run(cfg(p), undefined, (s) => steps.push(s));
    expect(res).toMatchObject({ ok: true, text: 'the build is green', sawSession: true, codexSessionId: ID });
    expect(steps).toEqual(['Bash(pnpm)']);
  });

  it('passes --json to the CLI', async () => {
    const p = script('json-argv', `echo "$@" > "${'$'}{0%/*}/argv.txt"`);
    await run(cfg(p));
    expect(fs.readFileSync(path.join(dir, 'argv.txt'), 'utf8')).toContain('--json');
  });

  it('an expired json run salvages the last agent_message and the thread id', async () => {
    const p = script('json-hang', `${jsonl([
      { type: 'thread.started', thread_id: ID },
      { type: 'item.completed', item: { type: 'agent_message', text: 'got this far' } },
    ])}\nsleep 60`);
    const res = await run({ ...cfg(p), idleTimeoutSec: IDLE });
    expect(res.ok).toBe(false);
    expect(res.text).toBe('got this far');
    expect(res.codexSessionId).toBe(ID);
    expect(res.sawSession).toBe(true);
  });
});

describe('loadConfig', () => {
  it('applies defaults and resolves cwd relative to the config file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cfg-'));
    const p = path.join(dir, 'agent.json');
    fs.mkdirSync(path.join(dir, 'work'));
    fs.writeFileSync(
      p,
      JSON.stringify({ serverUrl: 'http://127.0.0.1:8787/', agentToken: 'flow-agent-token-x', runtime: { cwd: 'work' } }),
    );
    const cfg = loadConfig(p);
    expect(cfg.serverUrl).toBe('http://127.0.0.1:8787'); // trailing slash stripped
    expect(cfg.runtime.kind).toBe('claude');
    expect(cfg.runtime.command).toBe('claude');
    expect(cfg.runtime.cwd).toBe(path.join(dir, 'work'));
    expect(cfg.eventScope).toBe('mentions');
    expect(cfg.progress).toBe('thinking');
    expect(cfg.respondToAgents).toBe(false);
    expect(cfg.concurrency).toBe(4);
    expect(cfg.runtime.mcp).toBe(true);
    expect(cfg.runtime.maxTurns).toBe(200); // a runaway backstop, not a work limit
    expect(cfg.runtime.idleTimeoutSec).toBe(120);
    expect(cfg.runtime.toolIdleTimeoutSec).toBe(660);
    // #519: reaper defaults — 10 minutes idle, an hour of held-off cap.
    expect(cfg.runtime.sessionIdleSec).toBe(600);
    expect(cfg.runtime.sessionHardCapSec).toBe(3600);
    expect(cfg.runtime.timeoutSec).toBe(3600); // backstop only — idle is the real limit
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a non-positive timeout (it would expire every run instantly)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cfg-'));
    const p = path.join(dir, 'agent.json');
    const base = { serverUrl: 'http://x', agentToken: 't', runtime: { kind: 'demo' } };
    fs.writeFileSync(p, JSON.stringify({ ...base, runtime: { kind: 'demo', idleTimeoutSec: 0 } }));
    expect(() => loadConfig(p)).toThrow(/idleTimeoutSec must be a positive number/);
    fs.writeFileSync(p, JSON.stringify({ ...base, runtime: { kind: 'demo', sessionIdleSec: 0 } }));
    expect(() => loadConfig(p)).toThrow(/sessionIdleSec must be a positive number/);
    fs.writeFileSync(p, JSON.stringify({ ...base, runtime: { kind: 'demo', sessionHardCapSec: -1 } }));
    expect(() => loadConfig(p)).toThrow(/sessionHardCapSec must be a positive number/);
    fs.writeFileSync(p, JSON.stringify({ ...base, runtime: { kind: 'demo', timeoutSec: -1 } }));
    expect(() => loadConfig(p)).toThrow(/timeoutSec must be a positive number/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts the demo runtime (no CLI, MCP off)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cfg-'));
    const p = path.join(dir, 'agent.json');
    fs.writeFileSync(
      p,
      JSON.stringify({ serverUrl: 'http://x', agentToken: 't', runtime: { kind: 'demo' } }),
    );
    const cfg = loadConfig(p);
    expect(cfg.runtime.kind).toBe('demo');
    expect(cfg.runtime.mcp).toBe(false);
    const res = await runRuntime(cfg.runtime, {
      sessionId: 's',
      resume: false,
      prompt: 'hello',
      systemPrompt: '',
      onToolStep: () => {},
      log: () => {},
    });
    expect(res).toEqual({ ok: true, text: DEMO_REPLY });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults logFile to <config>.log; null disables; paths resolve + expand', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cfg-'));
    const p = path.join(dir, 'agent.json');
    const base = { serverUrl: 'http://x', agentToken: 't', runtime: { kind: 'demo' } };
    fs.writeFileSync(p, JSON.stringify(base));
    expect(loadConfig(p).logFile).toBe(path.join(dir, 'agent.log'));
    fs.writeFileSync(p, JSON.stringify({ ...base, logFile: null }));
    expect(loadConfig(p).logFile).toBeNull();
    fs.writeFileSync(p, JSON.stringify({ ...base, logFile: 'logs/x.log' }));
    expect(loadConfig(p).logFile).toBe(path.join(dir, 'logs/x.log'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('expands ~ in cwd and rejects a nonexistent cwd for spawning runtimes', () => {
    expect(expandHome('~')).toBe(os.homedir());
    expect(expandHome('~/projects')).toBe(path.join(os.homedir(), 'projects'));
    expect(expandHome('/abs/path')).toBe('/abs/path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cfg-'));
    const p = path.join(dir, 'agent.json');
    fs.writeFileSync(
      p,
      JSON.stringify({ serverUrl: 'http://x', agentToken: 't', runtime: { cwd: '/does/not/exist-xyz' } }),
    );
    expect(() => loadConfig(p)).toThrow(/cwd does not exist/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects bad values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cfg-'));
    const p = path.join(dir, 'agent.json');
    fs.writeFileSync(p, JSON.stringify({ serverUrl: 'http://x', agentToken: 't', eventScope: 'sometimes' }));
    expect(() => loadConfig(p)).toThrow(/eventScope/);
    fs.writeFileSync(p, JSON.stringify({ agentToken: 't' }));
    delete process.env.FLOW_SERVER_URL;
    expect(() => loadConfig(p)).toThrow(/serverUrl/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('token usage (Admin › Members › Usage)', () => {
  const feed = (p: StreamJsonParser, ev: unknown) => p.feed(`${JSON.stringify(ev)}\n`);

  it('reports each model’s tokens since the last result, subagents included, as one call', () => {
    const seen: unknown[] = [];
    const p = new StreamJsonParser(() => {}, () => {}, { onUsage: (u) => seen.push(u) });
    feed(p, {
      type: 'result', subtype: 'success', result: 'ok',
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: { 'claude-opus-5-5': { inputTokens: 999999, outputTokens: 999999, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      model_usage_since_last_result: {
        'claude-opus-5-5': { inputTokens: 10, outputTokens: 45, cacheReadInputTokens: 2000, cacheCreationInputTokens: 300 },
        'claude-haiku-5-5': { inputTokens: 500, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        'claude-idle': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    });
    feed(p, { type: 'result', subtype: 'success', result: 'none', model_usage_since_last_result: {} });
    expect(seen).toEqual([
      { model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 45, cacheWriteTokens: 300, cacheReadTokens: 2000, requests: 1 },
      { model: 'claude-haiku-5-5', inputTokens: 500, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 0, requests: 0 },
    ]);
  });

  it('on an older CLI, puts the turn’s usage down to the model of its last answer', () => {
    const seen: unknown[] = [];
    const p = new StreamJsonParser(() => {}, () => {}, { onUsage: (u) => seen.push(u) });
    feed(p, { type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'hi' }] } });
    feed(p, { type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens: 45 } });
    feed(p, { type: 'result', subtype: 'success', result: 'none' });
    expect(seen).toEqual([{ model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 45, cacheWriteTokens: 300, cacheReadTokens: 2000, requests: 1 }]);
  });

  it('reports a codex turn’s tokens, cached input as cache reads, the model left to the bridge', () => {
    const seen: unknown[] = [];
    const p = new CodexJsonParser(() => {}, () => {}, (u) => seen.push(u));
    p.feed(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 900, cached_input_tokens: 800, output_tokens: 12 } })}\n`);
    expect(seen).toEqual([{ model: '', inputTokens: 100, outputTokens: 12, cacheWriteTokens: 0, cacheReadTokens: 800, requests: 1 }]);
  });
});
