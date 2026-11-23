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
// ctx.files    put(key, data, { type }), get(key), delete(key), list(prefix), response(key): the app's files in R2;
//              copyFromChat(fileId, key?): a copy of a Chat file the caller may open (needs "files:read")
// ctx.publish  publish(type, data, { ref: { kind, id }, about: [accountId] }): one of the manifest's events
// ctx.docs     read(path): a Docs read path as the caller (needs "docs:read" in uses)
// ctx.chat     post(channelId, text): a message as the caller (needs "chat:write" in uses);
//              file(fileId): a Chat file's name, type and size, if the caller may open it (needs "files:read")
// ctx.members  list(), search(text): the organization's people and agents as the caller sees them (needs "members:read")
// ctx.oauth    status(p), token(p), fetch(p, url, init), disconnect(p), start(p): the caller's sign-in to a service the
//              manifest declares under "oauth" (§6.5); the suite keeps the client secret and the tokens

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
  const files = {
    // data: a Blob or File (a form's), an ArrayBuffer, a typed array, or text; type defaults to the Blob's.
    put: async (key, data, opts = {}) => {
      let type = opts.type;
      let body = data;
      if (data && typeof data.arrayBuffer === 'function') { type = type ?? data.type; body = await data.arrayBuffer(); }
      return env.FILES.put(String(key), body, type || 'application/octet-stream');
    },
    get: (key) => env.FILES.get(String(key)),
    delete: (key) => env.FILES.delete(String(key)),
    list: (prefix = '') => env.FILES.list(String(prefix)),
    // A Chat file the caller may open, by its id, copied into the app's files: { key, id, name, type, size, width, height }.
    copyFromChat: (fileId, key) => env.SUITE.copyChatFile(ticket, String(fileId), key === undefined ? undefined : String(key)),
    // The file as a Response for the screen (a route that shows an image), or 404.
    response: async (key) => {
      const f = await env.FILES.get(String(key));
      return f ? new Response(f.data, { headers: { 'content-type': f.type, 'cache-control': 'private, max-age=60' } }) : new Response('not found', { status: 404 });
    },
  };
  return {
    caller: view,
    db,
    files,
    publish: (type, data, opts = {}) => env.SUITE.publish(type, data ?? null, opts.ref, opts.about),
    docs: { read: (path) => env.SUITE.readDocs(ticket, path) },
    chat: { post: (channelId, text) => env.SUITE.postMessage(ticket, channelId, text), file: (fileId) => env.SUITE.chatFile(ticket, String(fileId)) },
    members: { list: () => env.SUITE.members(ticket), search: (text) => env.SUITE.members(ticket, String(text ?? '')) },
    oauth: {
      start: (provider) => env.SUITE.oauth(ticket, 'start', String(provider)),
      status: (provider) => env.SUITE.oauth(ticket, 'status', String(provider)),
      token: (provider) => env.SUITE.oauth(ticket, 'token', String(provider)),
      disconnect: (provider) => env.SUITE.oauth(ticket, 'disconnect', String(provider)),
      // fetch with the caller's token as a bearer; the host must be in "egress". Not signed in: AppError 401.
      fetch: async (provider, url, init = {}) => {
        const t = await env.SUITE.oauth(ticket, 'token', String(provider));
        if (!t) throw new AppError('not signed in to ' + provider + ': open the app and connect it first', 401);
        const headers = new Headers(init.headers);
        headers.set('authorization', 'Bearer ' + t.accessToken);
        return fetch(url, { ...init, headers });
      },
    },
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
      // An exact route first; then one ending in /* for the paths under it (GET /api/files/*), longest first.
      let handler = routes[request.method + ' ' + url.pathname] ?? routes['* ' + url.pathname];
      if (!handler) {
        const prefixes = Object.keys(routes).filter((k) => k.endsWith('/*')).sort((a, b) => b.length - a.length);
        for (const k of prefixes) {
          const [method, path] = k.split(' ');
          if ((method === request.method || method === '*') && url.pathname.startsWith(path.slice(0, -1))) { handler = routes[k]; break; }
        }
      }
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
    routes: {                                       // the screen's own paths, for ui/ to fetch; return JSON or a Response; 'GET /api/files/*' takes every path under it
      'GET /api/tasks': async (request, ctx) => ctx.db.all('SELECT * FROM tasks'),
      'POST /api/tasks': async (request, ctx) => { const b = await request.json(); /* ... */ return { ok: true }; },
    },
  });

ctx.caller: { accountId, userId, displayName, kind, scopes } of who called the tool or is viewing the screen.
ctx.db: all(sql, ...params) → rows; one(sql, ...params) → a row or null; run(sql, ...params); batch([{ sql, params }]) in one transaction. The tables come from migrations/NNNN_name.sql, applied once each in order.
ctx.files: the app's own file storage (images, attachments, any upload). put(key, data, { type }) takes a File or Blob (from request.formData()), an ArrayBuffer or text; get(key) → { data, type, size } or null; delete(key); list(prefix) → [{ key, size, type }]; response(key) → a Response to return from a route. At most 10 MB a file. Keep the key in the database row (e.g. 'tasks/42/photo.png'); never put file contents in the database. The screen uploads with fetch('api/...', { method: 'POST', body: formData }) to a route that calls ctx.files.put, and shows a file with <img src="api/files/..."> from a route that returns ctx.files.response(key). Nothing is public: routes check who is looking.
Chat files (uses "files:read"): a person or agent names a file in Chat by its id (an agent sees it in a message as [attachments: <id> "photo.png" ...]). ctx.chat.file(fileId) → { id, name, type, size, width, height } (width and height for an image, else null). ctx.files.copyFromChat(fileId, key?) copies it into the app's own files (key defaults to 'chat/<fileId>') and returns those facts with its key; keep the key in the row and show it like any other file. Both act as the caller: a file the caller cannot open is 'file not found'. The copy is the app's: it stays if the Chat message is deleted, and anyone who may see the app's screen sees it. For an image tool, attach_image({ task_id, file_id }): const f = await ctx.chat.file(input.file_id); if (!f.type.startsWith('image/')) throw new Error('not an image'); const c = await ctx.files.copyFromChat(input.file_id, 'tasks/' + input.task_id + '/' + f.id); then keep c.key on the task.
ctx.publish(type, data, { ref: { kind, id }, about: [accountId] }): one of the manifest's events; "about" makes a self subscription wake that account.
ctx.docs.read(path) (uses "docs:read") and ctx.chat.post(channelId, text) (uses "chat:write") act as the caller.
ctx.members.list() and ctx.members.search(text) (uses "members:read"): the organization's people and agents as the caller sees them in Chat, no guests and no email addresses: [{ accountId, displayName, picture, kind: 'person' | 'agent' }], by name. For an assignee picker: keep the accountId; ctx.publish(..., { about: [accountId] }) can wake an assigned agent. picture is a URL the screen can show in <img> as it is, or null.
Throw an Error (or AppError(message, status) in a route) to refuse; the message goes back as it is.
The app reaches the internet only with fetch to the hosts in the manifest's "egress". A draft's preview and try_tool reach only the egress hosts an admin already approved for the installed version of the app.
Signing people in to another service by OAuth (GitHub, Google, ...): declare it under "oauth" in the manifest. FreeFlow runs the whole sign-in and keeps the client secret and each person's token; never put a client secret in the app's files or ask a person to paste one. An owner or admin enters the client id and secret in Admin › Apps (the draft's author on the Build page, for the preview), and registers FreeFlow's one callback address, shown there, with the provider. Each person connects their own account; an agent calling a tool uses its own connection, so a tool answers "not signed in" for it unless it connected.
  The screen: GET __freeflow/oauth/<id> → { connected, label, scope }; POST __freeflow/oauth/<id>/start → { url }: open it with window.open(url, 'oauth', 'width=600,height=750'), then check GET __freeflow/oauth/<id> every 2 seconds until connected (the sign-in window also posts { type: 'freeflow:oauth', provider, ok } to its opener; treat it only as a hint to check again); DELETE __freeflow/oauth/<id> disconnects. Use relative paths, as for the routes.
  The server: ctx.oauth.fetch(id, url, init) calls the service with the caller's token (its host must be in "egress"); it throws AppError 401 when the caller has not connected. ctx.oauth.token(id) → { accessToken, tokenType, scope, expiresAt } or null; ctx.oauth.status(id); ctx.oauth.disconnect(id).
ui/index.html and the other ui/ files are the screen, served on the app's own host; its scripts fetch the routes above with relative paths (fetch('api/tasks')).`;

/** What the assistant and agents are told of a hosted app's manifest when they build one (§4, §9.6). */
export const FREEFLOW_MANIFEST_DOC = `freeflow-app.json, the manifest of a hosted app:
{
  "name": "tasks",                      2-20 lowercase letters and digits; the app's name in tool names (tasks__list_tasks) and its address
  "label": "Tasks", "icon": "🗂️", "description": "One line for the people who install it.",
                                        icon: an emoji, or a PNG or SVG among the ui/ files ("ui/icon.png"), square, 16-512 px, at most 64 KB
  "server": { "hosted": true }, "ui": { "hosted": true },   (leave "ui" out for an app with no screen)
  "kinds": [{ "kind": "task", "label": "Task" }],             the kinds of objects its events refer to
  "scopes": [                                                  who may use it is given out by scope; one scope marked "read" lets an account see its events
    { "id": "tasks:read", "label": "See tasks", "read": true },
    { "id": "tasks:write", "label": "Change tasks" } ],
  "tools": [{ "name": "list_tasks", "description": "What it does and when to use it.",
              "input": { "type": "object", "properties": { "status": { "type": "string" } } }, "scopes": ["tasks:read"] }],
  "events": ["task.created", "task.assigned"],                what it publishes with ctx.publish
  "uses": ["docs:read", "chat:write", "members:read", "files:read"],  optional: what of FreeFlow it uses, as its caller
  "egress": ["api.example.com"],                              optional: the only hosts its server may fetch
  "oauth": [{ "id": "github", "label": "GitHub",               optional: services people sign in to (see ctx.oauth); https only
              "authorizeUrl": "https://github.com/login/oauth/authorize",
              "tokenUrl": "https://github.com/login/oauth/access_token",
              "scopes": ["read:user", "repo"] }]                 the scopes asked for; put the service's API host (api.github.com) in "egress"
}
Files: server.js (one ES module, with the SDK), migrations/0001_name.sql (applied once each in order; add a new file for a change, never edit an applied one), ui/index.html and other ui/ files.`;
