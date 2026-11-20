#!/usr/bin/env node
// A fake `claude --input-format stream-json` CLI for the persistent-session
// tests: it speaks the same stream-json protocol the real one does (verified
// against claude 2.1.250), and each user message is a tiny script of directives
// telling it what to emit.
//
//   say <text>        one assistant text block
//   tool <name> <arg> one tool_use block
//   result            the tool_result of the last tool_use (it returned)
//   bg <ms> <desc>    background a task: tool_use(run_in_background) +
//                     task_started now, and <ms> later the completion events
//                     followed by a *self-started* turn, exactly as the SDK's
//                     re-invocation looks on the wire
//   bgslow <ms> <followMs> <desc>
//                     like bg, but the self-started turn runs a tool and works
//                     for <followMs> before it answers — room for a message to
//                     land mid-follow-up-turn
//   wait <ms>         pause mid-turn (rearms the caller's idle timer meanwhile)
//   hang              never finish this turn (idle-timeout tests)
//   fail <subtype>    end the turn with an error result
//   die               exit mid-turn without ever producing a result
//   done <text>       end the turn; %PID% expands to this process's pid
import fs from 'node:fs';

if (process.env.FAKE_ARGV_LOG) {
  fs.appendFileSync(process.env.FAKE_ARGV_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
}
// One-shot spawn failure: with FAKE_FAIL_ONCE_FILE set, only the first spawn
// dies — which is how a session-id collision looks (the retry must succeed).
if (process.env.FAKE_SPAWN_FAILURE) {
  const once = process.env.FAKE_FAIL_ONCE_FILE;
  if (!once || !fs.existsSync(once)) {
    if (once) fs.writeFileSync(once, 'failed');
    process.stderr.write(process.env.FAKE_SPAWN_FAILURE);
    process.exit(3);
  }
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const session = 'fake-session';
const tasks = new Map(); // task_id -> description
let turn = null;
let seq = 0;

const snapshot = () =>
  out({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [...tasks].map(([task_id, description]) => ({ task_id, description, task_type: 'local_bash' })),
    session_id: session,
  });

const wait = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    turn.cancel = () => {
      clearTimeout(t);
      resolve();
    };
  });

function endTurn(text, subtype = 'success') {
  const isError = subtype !== 'success';
  turn = null;
  out({ type: 'result', subtype, is_error: isError, result: text, session_id: session });
}

function background(ms, desc, followMs = 0) {
  // Number('60_000') is NaN (numeric separators are a source-literal feature),
  // and setTimeout(fn, NaN) fires immediately — which once turned a "60s" task
  // into an instant completion whose empty snapshot raced the test's
  // pendingTasks read. A bad duration must fail the run, not shorten it.
  if (!Number.isFinite(ms)) throw new Error(`bg: unparseable duration ${ms}`);
  const id = `t${++seq}`;
  const toolUseId = `toolu_${id}`;
  out({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: desc, run_in_background: true } }] },
  });
  tasks.set(id, desc);
  snapshot();
  out({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: toolUseId, description: desc, is_backgrounded: true, session_id: session });
  setTimeout(() => {
    tasks.delete(id);
    snapshot();
    out({ type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: toolUseId, status: 'completed', summary: `${desc} completed`, session_id: session });
    // The SDK re-invokes the agent in this same process — a turn nobody asked for.
    const work = followMs > 0 ? `tool Bash checking ${desc}\nwait ${followMs}\n` : '';
    void runTurn(`${work}say ${desc} is done\ndone ${desc} finished`);
  }, ms).unref?.();
}

async function runTurn(script) {
  turn = { cancelled: false, cancel: null };
  out({ type: 'system', subtype: 'init', session_id: session });
  for (const line of script.split('\n')) {
    if (!turn || turn.cancelled) return;
    const [cmd, ...rest] = line.trim().split(' ');
    const arg = rest.join(' ');
    switch (cmd) {
      case 'say':
        out({ type: 'assistant', message: { content: [{ type: 'text', text: arg }] } });
        break;
      case 'tool':
        out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `toolu_${++seq}`, name: rest[0], input: { command: rest.slice(1).join(' ') } }] } });
        break;
      case 'result':
        out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${seq}`, content: 'ok' }] } });
        break;
      case 'bg':
        background(Number(rest[0]), rest.slice(1).join(' ') || 'background work');
        break;
      case 'bgslow':
        background(Number(rest[0]), rest.slice(2).join(' ') || 'background work', Number(rest[1]));
        break;
      case 'wait':
        await wait(Number(arg));
        break;
      case 'hang':
        await new Promise((resolve) => { turn.cancel = resolve; });
        break;
      case 'fail':
        return endTurn('', arg);
      case 'die': // the CLI drops dead mid-turn; the caller salvages the last text
        return process.exit(9);
      case 'done':
        return endTurn(arg.replaceAll('%PID%', String(process.pid)));
      default:
        break;
    }
  }
  if (turn && !turn.cancelled) endTurn('ok');
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'control_request' && ev.request?.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response: { still_queued: [] } } });
      if (process.env.FAKE_IGNORE_INTERRUPT) continue; // wedged CLI: the caller must fall back to a kill
      if (turn) {
        turn.cancelled = true;
        turn.cancel?.();
        endTurn('', 'error_during_execution');
      }
      continue;
    }
    if (ev.type === 'user') {
      const text = (ev.message?.content ?? []).map((b) => b.text ?? '').join('');
      void runTurn(text);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
