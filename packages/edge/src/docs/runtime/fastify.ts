// The part of Fastify the Docs routes use, so that those files can stay as they were on Node: scoped plugins and hooks,
// content-type parsers, cookies, and `reply.hijack()` with `reply.raw` for its event streams.
import { docsContext } from './context.ts';
import { FileStream } from './fs.ts';

export type Caller = { userId: string | null; email: string | null; token: string | null; ip: string };
type Hook = (req: DocsRequest, reply: DocsReply, done?: (err?: Error) => void) => unknown;
type Handler = (req: DocsRequest, reply: DocsReply) => unknown;
type Opts = { preHandler?: Hook | Hook[]; onRequest?: Hook | Hook[]; [key: string]: unknown };

export interface DocsRequest {
  method: string; url: string; params: unknown; query: unknown; body: unknown; ip: string; hostname: string; protocol: string;
  headers: Record<string, string | undefined>; cookies: Record<string, string | undefined>; raw: RawRequest; id: string;
  routeOptions: { url: string }; log: Console; caller: Caller; [decoration: string]: unknown;
}

/** Closing is told through `on('close')`, as a Node socket does. */
class RawRequest {
  private readonly closers: (() => void)[] = [];
  aborted = false;
  headers: Record<string, string>;
  constructor(headers: Record<string, string>) { this.headers = headers; }
  on(event: string, fn: () => void) { if (event === 'close' || event === 'aborted') this.closers.push(fn); return this; }
  once(event: string, fn: () => void) { return this.on(event, fn); }
  off() { return this; }
  close() { this.aborted = true; for (const fn of this.closers.splice(0)) { try { fn(); } catch { /* one listener must not stop the rest */ } } }
}

class RawResponse {
  writableEnded = false;
  destroyed = false;
  headersSent = false;
  statusCode = 200;
  private readonly closers: (() => void)[] = [];
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly readable: ReadableStream<Uint8Array>;
  private readonly encoder = new TextEncoder();
  constructor(private readonly reply: DocsReply) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    this.readable = readable;
    this.writer = writable.getWriter();
    this.writer.closed.catch(() => this.closed());
  }
  private closed() { this.destroyed = true; for (const fn of this.closers.splice(0)) { try { fn(); } catch { /* as above */ } } }
  on(event: string, fn: () => void) { if (event === 'close') this.closers.push(fn); return this; }
  once(event: string, fn: () => void) { return this.on(event, fn); }
  off() { return this; }
  setHeader(name: string, value: string) { this.reply.header(name, value); return this; }
  flushHeaders() { this.open(); }
  writeHead(status: number, headers?: Record<string, string>) {
    this.statusCode = status;
    this.reply.status(status);
    for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() !== 'connection') this.reply.header(k, v);
    this.open();
    return this;
  }
  private open() { if (!this.headersSent) { this.headersSent = true; this.reply.opened(this.readable); } }
  write(chunk: string | Uint8Array): boolean {
    this.open();
    this.writer.write(typeof chunk === 'string' ? this.encoder.encode(chunk) : chunk).catch(() => this.closed());
    return true;
  }
  end(chunk?: string | Uint8Array) {
    if (this.writableEnded) return;
    if (chunk) this.write(chunk);
    this.open();
    this.writableEnded = true;
    this.writer.close().catch(() => {});
    this.closed();
  }
}

export class DocsReply {
  statusCode = 200;
  headers = new Headers();
  body: BodyInit | null = null;
  sent = false;
  private rawResponse: RawResponse | null = null;
  private onOpen: ((r: Response) => void) | null = null;
  private pending: Promise<void> | null = null;
  status(code: number) { this.statusCode = code; return this; }
  code(code: number) { return this.status(code); }
  header(name: string, value: string | number) { this.headers.set(name, String(value)); return this; }
  getHeader(name: string) { return this.headers.get(name) ?? undefined; }
  type(value: string) { return this.header('content-type', value); }
  redirect(url: string, code = 302) { this.statusCode = code; this.headers.set('location', url); this.sent = true; return this; }
  hijack() { this.sent = true; return this; }
  get raw(): RawResponse { return (this.rawResponse ??= new RawResponse(this)); }
  /** A stream has started: the caller gets its Response now, and the handler goes on writing to it. */
  opened(readable: ReadableStream<Uint8Array>) { this.onOpen?.(new Response(readable, { status: this.statusCode, headers: this.headers })); }
  waitForOpen(fn: (r: Response) => void) { this.onOpen = fn; }
  setCookie(name: string, value: string, o: { path?: string; httpOnly?: boolean; sameSite?: string; secure?: boolean; maxAge?: number } = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? '/'}`];
    if (o.httpOnly) parts.push('HttpOnly');
    if (o.secure) parts.push('Secure');
    if (o.sameSite) parts.push(`SameSite=${o.sameSite}`);
    if (o.maxAge !== undefined) parts.push(`Max-Age=${o.maxAge}`);
    this.headers.append('set-cookie', parts.join('; '));
    return this;
  }
  clearCookie(name: string, o: { path?: string } = {}) { return this.setCookie(name, '', { path: o.path ?? '/', maxAge: 0 }); }
  /** Files named by `createReadStream` are R2 objects, sent as a stream, which is what lets a large video play. */
  private sendFileStream(stream: FileStream) {
    const { bucket, prefix } = docsContext();
    const key = `${prefix}${stream.file.replace(/^\/+/, '')}`;
    const { start, end } = stream.opts;
    this.pending = (async () => {
      const range = start !== undefined ? { offset: start, ...(end !== undefined ? { length: end - start + 1 } : {}) } : undefined;
      const o = await bucket.get(key, range ? { range } : undefined);
      if (!o) { this.statusCode = 404; this.body = null; return; }
      this.body = o.body;
    })();
  }
  send(payload?: unknown) {
    this.sent = true;
    if (payload === undefined || payload === null) this.body = null;
    else if (payload instanceof FileStream) this.sendFileStream(payload);
    else if (payload instanceof Uint8Array || typeof payload === 'string' || payload instanceof ReadableStream) {
      if (typeof payload === 'string' && !this.headers.has('content-type')) this.headers.set('content-type', 'text/plain; charset=utf-8');
      this.body = payload as BodyInit;
    } else {
      this.body = JSON.stringify(payload);
      if (!this.headers.has('content-type')) this.headers.set('content-type', 'application/json; charset=utf-8');
    }
    return this;
  }
  async finish(): Promise<Response> {
    await this.pending;
    return new Response(this.body, { status: this.statusCode, headers: this.headers });
  }
}

interface Route { method: string; pattern: RegExp; keys: string[]; path: string; handler: Handler; opts: Opts; scope: DocsApp; rank: number }
type Parser = (req: DocsRequest, body: Buffer, done: (err: Error | null, value?: unknown) => void) => void;

const asList = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function compile(path: string): { pattern: RegExp; keys: string[]; rank: number } {
  const keys: string[] = [];
  const source = path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, k: string) => { keys.push(k); return '([^/]+)'; }).replace(/\*/g, () => { keys.push('*'); return '(.*)'; });
  return { pattern: new RegExp(`^${source}$`), keys, rank: keys.length + (path.includes('*') ? 100 : 0) };
}

/** An Error written out as its name, message, stack and cause: console in Workers prints an Error inside an object as {}. */
function loggable(a: unknown): unknown {
  if (a instanceof Error) return { name: a.name, message: a.message, stack: a.stack, ...(a.cause !== undefined ? { cause: loggable(a.cause) } : {}) };
  if (a && typeof a === 'object' && !Array.isArray(a)) return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v instanceof Error ? loggable(v) : v]));
  return a;
}

/** Fastify's app.log and req.log over console, with errors readable in the Worker's logs (`req.log.error({ err }, 'msg')`). */
export const log: Console = Object.assign(Object.create(console) as Console, {
  error: (...a: unknown[]) => console.error(...a.map(loggable)),
  warn: (...a: unknown[]) => console.warn(...a.map(loggable)),
  info: (...a: unknown[]) => console.info(...a.map(loggable)),
});

export class DocsApp {
  private readonly hooks: { name: string; fn: Hook }[] = [];
  private readonly root: DocsApp;
  private routes: Route[] = [];
  private parsers: { types: string[]; parser: Parser }[] = [];
  private decorations: Record<string, unknown> = {};
  server = { address: () => null };
  log = log;
  constructor(private readonly parent: DocsApp | null = null) { this.root = parent?.root ?? this; }

  private add(method: string, path: string, a: Opts | Handler, b?: Handler) {
    const handler = (b ?? a) as Handler;
    this.root.routes.push({ method, path, ...compile(path), handler, opts: b ? (a as Opts) : {}, scope: this });
    this.root.routes.sort((x, y) => x.rank - y.rank);
  }
  get(p: string, a: Opts | Handler, b?: Handler) { this.add('GET', p, a, b); this.add('HEAD', p, a, b); }
  post(p: string, a: Opts | Handler, b?: Handler) { this.add('POST', p, a, b); }
  put(p: string, a: Opts | Handler, b?: Handler) { this.add('PUT', p, a, b); }
  patch(p: string, a: Opts | Handler, b?: Handler) { this.add('PATCH', p, a, b); }
  delete(p: string, a: Opts | Handler, b?: Handler) { this.add('DELETE', p, a, b); }
  all(p: string, a: Opts | Handler, b?: Handler) { for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) this.add(m, p, a, b); }
  addHook(name: string, fn: Hook) { this.hooks.push({ name, fn }); }
  async register(plugin: (app: DocsApp, opts?: unknown) => unknown, opts?: unknown) { await plugin(new DocsApp(this), opts); }
  decorateRequest(name: string, value: unknown) { this.root.decorations[name] = value; }
  /** An app-level decoration (`app.connectors`): a property on the instance, seen by every scope. */
  decorate(name: string, value: unknown) { (this.root as unknown as Record<string, unknown>)[name] = value; if (this !== this.root) (this as unknown as Record<string, unknown>)[name] = value; }
  hasDecorator(name: string) { return name in this.root; }
  hasRequestDecorator(name: string) { return name in this.root.decorations; }
  addContentTypeParser(types: string | string[], _opts: unknown, parser: Parser) { this.root.parsers.push({ types: asList(types), parser }); }
  setNotFoundHandler(_fn: unknown) { /* the Worker answers what no route does */ }
  setErrorHandler(_fn: unknown) { /* `handle` turns errors into answers */ }
  async ready() {}
  async close() {}

  private hooksOf(scope: DocsApp, name: string): Hook[] {
    const chain: DocsApp[] = [];
    for (let s: DocsApp | null = scope; s; s = s.parent) chain.unshift(s);
    return chain.flatMap((s) => s.hooks.filter((h) => h.name === name).map((h) => h.fn));
  }

  private async runHook(fn: Hook, req: DocsRequest, reply: DocsReply): Promise<void> {
    if (fn.length >= 3) await new Promise<void>((resolve, reject) => { void fn(req, reply, (err) => (err ? reject(err) : resolve())); });
    else await fn(req, reply);
  }

  async handle(request: Request, caller: Caller): Promise<Response> {
    const url = new URL(request.url);
    const raw = new RawRequest(Object.fromEntries(request.headers));
    request.signal?.addEventListener('abort', () => raw.close());
    const route = this.routes.find((r) => r.method === request.method && r.pattern.test(url.pathname));
    if (!route) return Response.json({ error: 'Not found' }, { status: 404 });
    const params: Record<string, string> = {};
    const match = route.pattern.exec(url.pathname)!;
    route.keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]!); });
    const cookies = Object.fromEntries((request.headers.get('cookie') ?? '').split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
    const req = {
      ...this.decorations, method: request.method, url: url.pathname + url.search, params, query: Object.fromEntries(url.searchParams), body: undefined,
      ip: caller.ip, hostname: url.hostname, protocol: url.protocol.replace(':', ''), headers: Object.fromEntries(request.headers), cookies, raw, id: crypto.randomUUID(),
      routeOptions: { url: route.path }, log, caller,
    } as DocsRequest;
    const reply = new DocsReply();
    const run = async (): Promise<void> => {
      for (const fn of [...this.hooksOf(route.scope, 'onRequest'), ...asList(route.opts.onRequest)]) {
        await this.runHook(fn, req, reply);
        if (reply.sent) return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) req.body = await this.parseBody(request, req);
      for (const fn of [...this.hooksOf(route.scope, 'preValidation'), ...this.hooksOf(route.scope, 'preHandler'), ...asList(route.opts.preHandler)]) {
        await this.runHook(fn, req, reply);
        if (reply.sent) return;
      }
      const result = await route.handler(req, reply);
      if (!reply.sent && result !== reply && result !== undefined) reply.send(result);
    };
    return new Promise<Response>((resolve) => {
      reply.waitForOpen(resolve);
      run().then(() => reply.finish().then(resolve)).catch((err: Error & { statusCode?: number }) => {
        if (!err.statusCode || err.statusCode >= 500) console.error(`${request.method} ${url.pathname}: ${err.stack}`);
        resolve(Response.json({ error: err.statusCode && err.statusCode < 500 ? err.message : 'Something went wrong on the server' }, { status: err.statusCode ?? 500 }));
      });
    });
  }

  private async parseBody(request: Request, req: DocsRequest): Promise<unknown> {
    const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const bytes = Buffer.from(await request.arrayBuffer());
    if (!bytes.length) return undefined;
    // The suite's server hands Docs every body but JSON as raw bytes (packages/server/src/app.ts), and Docs relies on it.
    const own = this.parsers.find((p) => p.types.includes(type));
    if (own) return new Promise((resolve, reject) => own.parser(req, bytes, (err, value) => (err ? reject(err) : resolve(value))));
    if (type === 'application/json') {
      try { return JSON.parse(bytes.toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); }
    }
    return bytes;
  }
}
