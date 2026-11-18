// The SDK every hosted app gets (docs/specs/user-apps.md §9.6): the module `freeflow`, which the runner adds to the app's
// isolate beside its server.js (apps/hosted.ts). The app imports it; nothing is bundled. Kept as source text here because
// it runs in the app's isolate, never in the suite's. FREEFLOW_SDK_DOC below is what the assistant is told about it.
//
//   import { defineApp } from 'freeflow';
//   export default defineApp({
//     tools:  { name: async (input, ctx) => result },          // the manifest's tools; a throw is the agent's error
//     routes: { 'GET /api/tasks': async (request, ctx) => rows }, // the screen's own paths; an object comes back as JSON
//   });
//
// ctx.caller   who is calling: { accountId, userId, displayName, kind, scopes, ... } (the tool's caller, or the viewer)
// ctx.db       the app's SQLite here: all(sql, ...params), one(sql, ...params), run(sql, ...params), batch([{ sql, params }])
// ctx.publish  publish(type, data, { ref: { kind, id }, about: [accountId] }): one of the manifest's events
// ctx.docs     read(path): a Docs read path as the caller (needs "docs:read" in uses)
// ctx.chat     post(channelId, text): a message as the caller (needs "chat:write" in uses)

/** The module's name in the app's isolate: `import { defineApp } from 'freeflow'`. */
export const SDK_MODULE = 'freeflow';

export const FREEFLOW_SDK_SOURCE = String.raw`
const TOOL_PATH = '/__freeflow/tool';

function makeCtx(env, caller) {
  const ticket = caller && caller.ticket;
  const params = (p) => (p.length === 1 && Array.isArray(p[0]) ? p[0] : p);
  const db = {
    all: (sql, ...p) => env.DB.exec(String(sql), params(p)),
    one: async (sql, ...p) => (await env.DB.exec(String(sql), params(p)))[0] ?? null,
    run: (sql, ...p) => env.DB.exec(String(sql), params(p)),
    exec: (sql, p) => env.DB.exec(String(sql), Array.isArray(p) ? p : []),
    batch: (statements) => env.DB.batch(statements),
  };
  const view = caller ? { ...caller } : null;
  if (view) delete view.ticket;
  return {
    caller: view,
    db,
    publish: (type, data, opts = {}) => env.SUITE.publish(type, data ?? null, opts.ref, opts.about),
    docs: { read: (path) => env.SUITE.readDocs(ticket, path) },
    chat: { post: (channelId, text) => env.SUITE.postMessage(ticket, channelId, text) },
  };
}

function toResponse(out) {
  if (out instanceof Response) return out;
  if (out === undefined) return new Response(null, { status: 204 });
  if (typeof out === 'string') return new Response(out, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return Response.json(out);
}

function errorText(e) {
  return String((e && e.message) || e).slice(0, 2000);
}

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function defineApp(app) {
  const tools = app.tools ?? {};
  const routes = app.routes ?? {};
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === TOOL_PATH && request.method === 'POST') {
        let call;
        try { call = await request.json(); } catch { return Response.json({ error: 'the call is not JSON' }); }
        const fn = tools[call.tool];
        if (typeof fn !== 'function') return Response.json({ error: 'this app has no tool ' + call.tool });
        try {
          const result = await fn(call.input ?? {}, makeCtx(env, call.caller));
          return Response.json({ result: result === undefined ? null : result });
        } catch (e) {
          return Response.json({ error: errorText(e) });
        }
      }
      let viewer = null;
      try { viewer = JSON.parse(request.headers.get('x-freeflow-viewer') ?? 'null'); } catch {}
      const ctx = makeCtx(env, viewer);
      const handler = routes[request.method + ' ' + url.pathname] ?? routes['* ' + url.pathname];
      if (typeof handler === 'function') {
        try {
          return toResponse(await handler(request, ctx));
        } catch (e) {
          return Response.json({ error: errorText(e) }, { status: e instanceof AppError ? e.status : 500 });
        }
      }
      if (typeof app.fetch === 'function') return app.fetch(request, ctx);
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  };
}
`;

/** What the assistant and agents are told of the SDK when they build an app (§9.6). */
export const FREEFLOW_SDK_DOC = `A hosted app's server.js is one ES module, run by FreeFlow. It imports the built-in SDK:

  import { defineApp, AppError } from 'freeflow';
  export default defineApp({
    tools: {                                        // one per tool in freeflow-app.json; return any JSON
      list_tasks: async (input, ctx) => ctx.db.all('SELECT * FROM tasks WHERE status = ?', input.status ?? 'Ready'),
    },
    routes: {                                       // the screen's own paths, for ui/ to fetch; return JSON or a Response
      'GET /api/tasks': async (request, ctx) => ctx.db.all('SELECT * FROM tasks'),
      'POST /api/tasks': async (request, ctx) => { const b = await request.json(); /* ... */ return { ok: true }; },
    },
  });

ctx.caller: { accountId, userId, displayName, kind, scopes } of who called the tool or is viewing the screen.
ctx.db: all(sql, ...params) → rows; one(sql, ...params) → a row or null; run(sql, ...params); batch([{ sql, params }]) in one transaction. The tables come from migrations/NNNN_name.sql, applied once each in order.
ctx.publish(type, data, { ref: { kind, id }, about: [accountId] }): one of the manifest's events; "about" makes a self subscription wake that account.
ctx.docs.read(path) (uses "docs:read") and ctx.chat.post(channelId, text) (uses "chat:write") act as the caller.
Throw an Error (or AppError(message, status) in a route) to refuse; the message goes back as it is.
The app reaches the internet only with fetch to the hosts in the manifest's "egress".
ui/index.html and the other ui/ files are the screen, served on the app's own host; its scripts fetch the routes above with relative paths (fetch('api/tasks')).`;
