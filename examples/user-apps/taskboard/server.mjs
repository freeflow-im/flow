#!/usr/bin/env node
// Taskboard: an example external user app for FreeFlow (docs/specs/user-apps.md §3, phase 1). One file, no dependencies.
//
//   GET  /freeflow-app.json   the manifest an admin installs from (Admin → Apps → Install an app)
//   POST /freeflow            the tool calls FreeFlow sends, signed with the install's secret (§5)
//   GET  /                    the board, the screen the Tasks tab frames (put the bridge's app-guard in front of it)
//   POST /tasks               the screen's "New task" form
//
// It keeps its tasks in memory and sends its events to FreeFlow, signed (§5.1). Run it:
//
//   PORT=8790 PUBLIC_URL=https://tasks.example.com node server.mjs
//
// then, after installing it, restart it with the secret Admin showed once and the events address:
//
//   FREEFLOW_APP_SECRET=<secret> FREEFLOW_EVENTS_URL=https://app.freeflow.im/v1/apps/<org>/taskboard/events node server.mjs
//
// The screen: run `FLOW_APP_SECRET=<secret> npx flow-agent-bridge app-guard --upstream http://localhost:8790 --port 8791`
// and set UI_URL to the guard's public address. The guard checks the one-use door key of each person who opens the tab
// and passes who they are in X-Flow-* headers. See README.md.
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8790);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const UI_URL = process.env.UI_URL ?? `${PUBLIC_URL}/`;
const SECRET = process.env.FREEFLOW_APP_SECRET ? Buffer.from(process.env.FREEFLOW_APP_SECRET, 'base64url') : null;
const EVENTS_URL = process.env.FREEFLOW_EVENTS_URL ?? '';
const STATUSES = ['Backlog', 'Ready', 'In progress', 'Review', 'Done'];

export const manifest = {
  name: 'taskboard',
  label: 'Tasks',
  icon: '🗂️',
  description: 'Cards with a description, labels, a status and comments. Agents find tasks, claim them and work on them.',
  kinds: [{ kind: 'task', label: 'Task' }],
  scopes: [
    { id: 'taskboard:read', label: 'See tasks, labels and comments', read: true },
    { id: 'taskboard:write', label: 'Add and change tasks, and comment' },
  ],
  tools: [
    {
      name: 'list_tasks',
      description: `Finds tasks on the board. Statuses: ${STATUSES.join(', ')}. assignee "me" is the caller. Returns each task's id, title, status, labels and assignee (an account id).`,
      input: { type: 'object', properties: { status: { type: 'string', enum: STATUSES }, label: { type: 'string' }, assignee: { type: 'string', description: 'An account id, or "me".' }, text: { type: 'string', description: 'Words in the title or description.' } } },
      scopes: ['taskboard:read'],
    },
    {
      name: 'get_task',
      description: 'One task with its description and comments.',
      input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      scopes: ['taskboard:read'],
    },
    {
      name: 'create_task',
      description: 'Adds a card. Status defaults to Backlog.',
      input: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: STATUSES } }, required: ['title'] },
      scopes: ['taskboard:write'],
    },
    {
      name: 'update_task',
      description: 'Changes a task: title, description, labels, status, or assignee (an account id, "me", or null for nobody).',
      input: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: STATUSES }, assignee: { type: ['string', 'null'] } }, required: ['id'] },
      scopes: ['taskboard:write'],
    },
    {
      name: 'claim_task',
      description: 'Takes a task for the caller and moves it to In progress, only if nobody else has it. Claim a task before working on it.',
      input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      scopes: ['taskboard:write'],
    },
    {
      name: 'add_comment',
      description: 'Comments on a task: progress, a question, a link to the result.',
      input: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
      scopes: ['taskboard:write'],
    },
  ],
  events: ['task.created', 'task.assigned', 'task.status_changed', 'task.commented'],
  server: { url: `${PUBLIC_URL}/freeflow` },
  ui: { url: UI_URL },
};

// ---- the board, in memory ----

const tasks = new Map();
let seq = 0;
/** Goes up on every change: the board asks for it every few seconds and reloads when it moves. */
let version = 0;

class Refusal extends Error {}

function taskOf(id) {
  const t = tasks.get(String(id ?? ''));
  if (!t) throw new Refusal(`no task ${id}`);
  return t;
}
const brief = (t) => ({ id: t.id, title: t.title, status: t.status, labels: t.labels, assignee: t.assignee });
const who = (caller, value) => (value === 'me' ? caller.accountId : value);
const status = (s) => {
  if (s === undefined) return undefined;
  if (!STATUSES.includes(s)) throw new Refusal(`status is one of ${STATUSES.join(', ')}`);
  return s;
};

/** Runs one tool for a caller FreeFlow vouched for; returns the result and the events it caused. */
export function runTool(tool, input, caller) {
  const events = [];
  if (tool !== 'list_tasks' && tool !== 'get_task') version++;
  const ref = (t) => ({ kind: 'task', id: t.id });
  const moved = (t, from) => { if (t.status !== from) events.push({ type: 'task.status_changed', data: { id: t.id, title: t.title, from, to: t.status }, ref: ref(t) }); };
  const assigned = (t, from) => { if (t.assignee && t.assignee !== from) events.push({ type: 'task.assigned', data: { id: t.id, title: t.title, assignee: t.assignee, by: caller.accountId }, ref: ref(t), about: [t.assignee] }); };
  switch (tool) {
    case 'list_tasks': {
      const assignee = who(caller, input.assignee);
      const text = String(input.text ?? '').toLowerCase();
      const found = [...tasks.values()].filter((t) =>
        (!input.status || t.status === input.status) && (!input.label || t.labels.includes(input.label)) && (!assignee || t.assignee === assignee) &&
        (!text || `${t.title} ${t.description}`.toLowerCase().includes(text)));
      return { result: { tasks: found.map(brief) }, events };
    }
    case 'get_task':
      return { result: { task: taskOf(input.id) }, events };
    case 'create_task': {
      const title = String(input.title ?? '').trim();
      if (!title) throw new Refusal('a task needs a title');
      const t = { id: `t${++seq}`, title, description: String(input.description ?? ''), labels: Array.isArray(input.labels) ? input.labels.map(String) : [], status: status(input.status) ?? 'Backlog', assignee: null, comments: [], createdBy: caller.accountId, updatedAt: new Date().toISOString() };
      tasks.set(t.id, t);
      events.push({ type: 'task.created', data: { id: t.id, title: t.title, by: caller.accountId }, ref: ref(t) });
      return { result: { task: brief(t) }, events };
    }
    case 'update_task': {
      const t = taskOf(input.id);
      const before = { status: t.status, assignee: t.assignee };
      if (input.title !== undefined) t.title = String(input.title);
      if (input.description !== undefined) t.description = String(input.description);
      if (input.labels !== undefined) t.labels = Array.isArray(input.labels) ? input.labels.map(String) : [];
      if (input.status !== undefined) t.status = status(input.status);
      if (input.assignee !== undefined) t.assignee = input.assignee === null ? null : who(caller, String(input.assignee));
      t.updatedAt = new Date().toISOString();
      moved(t, before.status);
      assigned(t, before.assignee);
      return { result: { task: brief(t) }, events };
    }
    case 'claim_task': {
      const t = taskOf(input.id);
      if (t.assignee && t.assignee !== caller.accountId) throw new Refusal(`task ${t.id} is already assigned to ${t.assignee}`);
      const before = { status: t.status, assignee: t.assignee };
      t.assignee = caller.accountId;
      t.status = 'In progress';
      t.updatedAt = new Date().toISOString();
      moved(t, before.status);
      return { result: { task: brief(t) }, events };
    }
    case 'add_comment': {
      const t = taskOf(input.id);
      const text = String(input.text ?? '').trim();
      if (!text) throw new Refusal('a comment needs text');
      t.comments.push({ by: caller.displayName, accountId: caller.accountId, text, at: new Date().toISOString() });
      events.push({ type: 'task.commented', data: { id: t.id, title: t.title, by: caller.accountId }, ref: ref(t) });
      return { result: { ok: true }, events };
    }
    default:
      throw new Refusal(`no tool ${tool}`);
  }
}

// ---- signatures: x-freeflow-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")> ----

const mac = (t, body) => createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');

function verified(header, body) {
  if (!SECRET || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=').map((s) => s.trim())));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > 300 || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
  const a = Buffer.from(parts.v1, 'hex');
  const b = Buffer.from(mac(t, body), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function send(event) {
  if (!SECRET || !EVENTS_URL) return;
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(EVENTS_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-freeflow-signature': `t=${t},v1=${mac(t, body)}` }, body });
    if (!res.ok) console.error(`taskboard: event ${event.type} refused: ${res.status} ${await res.text()}`);
  } catch (err) {
    console.error(`taskboard: event ${event.type} not sent: ${err.message}`);
  }
}

// ---- the screen ----

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function board(viewer) {
  const columns = STATUSES.map((s) => {
    const cards = [...tasks.values()].filter((t) => t.status === s).map((t) => `<li><b>${esc(t.title)}</b>${t.labels.length ? ` <small>${t.labels.map(esc).join(', ')}</small>` : ''}${t.assignee ? `<br><small>assigned to ${esc(t.assignee)}</small>` : ''}${t.comments.length ? `<br><small>${t.comments.length} comment(s)</small>` : ''}</li>`).join('');
    return `<section><h2>${esc(s)}</h2><ul>${cards}</ul></section>`;
  }).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tasks</title>
<style>body{font:14px system-ui;margin:16px}main{display:flex;gap:12px;overflow-x:auto}section{min-width:200px;background:#f8f9fa;border-radius:8px;padding:8px}ul{list-style:none;padding:0}li{background:#fff;border:1px solid #e3e6ea;border-radius:6px;padding:8px;margin:6px 0}</style>
<p>${viewer ? `Signed in as ${esc(viewer)}.` : 'Open this board from its tab in FreeFlow.'}</p>
<form method="post" action="tasks"><input name="title" placeholder="New task" required> <button>Add</button></form>
<main>${columns}</main>
<script>
  // Changes made elsewhere (an agent's tool call) show without a reload: the board asks for the version every 3 seconds.
  const seen = ${version};
  setInterval(async () => {
    try { const r = await fetch('version'); if (r.ok && (await r.json()).version !== seen) location.reload(); } catch {}
  }, 3000);
</script>`;
}

// ---- the server ----

const read = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
  req.on('end', () => resolve(data));
  req.on('error', reject);
});
const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/freeflow-app.json') return json(res, 200, manifest);
    if (req.method === 'POST' && url.pathname === '/freeflow') {
      const body = await read(req);
      if (!verified(req.headers['x-freeflow-signature'], body)) return json(res, 401, { error: 'bad or missing signature' });
      const call = JSON.parse(body);
      try {
        const { result, events } = runTool(call.tool, call.input ?? {}, call.caller);
        for (const e of events) void send(e);
        return json(res, 200, { result });
      } catch (err) {
        if (err instanceof Refusal) return json(res, 200, { error: err.message });
        throw err;
      }
    }
    // The screen, behind the guard: who is looking comes in the guard's headers.
    const viewer = { accountId: req.headers['x-flow-account-id'] ?? 'unknown', displayName: req.headers['x-flow-user-name'] ?? 'someone' };
    if (req.method === 'GET' && url.pathname === '/version') return json(res, 200, { version });
    if (req.method === 'GET' && url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(board(req.headers['x-flow-user-name']));
    if (req.method === 'POST' && url.pathname === '/tasks') {
      const title = new URLSearchParams(await read(req)).get('title') ?? '';
      const { events } = runTool('create_task', { title }, viewer);
      for (const e of events) void send(e);
      return res.writeHead(303, { location: './' }).end();
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(`taskboard: ${err.stack ?? err}`);
    return json(res, 500, { error: 'the app failed' });
  }
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  server.listen(PORT, () => console.log(`taskboard: listening on ${PORT}; manifest at ${PUBLIC_URL}/freeflow-app.json${SECRET ? '' : ' (no FREEFLOW_APP_SECRET yet: tool calls are refused until it is set)'}`));
}

