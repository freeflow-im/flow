// The small part of Fastify that the route file uses, so that file can stay as it was on Node.
import { Hono } from 'hono';
import type { UserDTO } from '@flow/shared';
import type { AuthKind } from '../../directory/core';
import { ApiError, unauthorized } from '../../errors';

export interface CallerContext { user: UserDTO | null; token: string | null; authKind: AuthKind | null; ip: string }

export interface CompatRequest {
  params: unknown; query: unknown; body: unknown; headers: Record<string, string | undefined>; url: string; ip: string; method: string;
  user: UserDTO; bearerToken: string; authKind: AuthKind;
  log: Pick<Console, 'warn' | 'error' | 'info'>;
  file(): Promise<undefined | { filename?: string; mimetype: string; toBuffer(): Promise<Buffer> }>;
}

export class CompatReply {
  statusCode = 200;
  headers = new Headers();
  body: BodyInit | null | undefined;
  sent = false;
  status(code: number) { this.statusCode = code; return this; }
  code(code: number) { return this.status(code); }
  header(name: string, value: string | number) { this.headers.set(name, String(value)); return this; }
  type(value: string) { return this.header('content-type', value); }
  redirect(url: string, code = 302) { this.statusCode = code; this.headers.set('location', url); this.sent = true; this.body = null; return this; }
  send(payload?: unknown) {
    this.sent = true;
    if (payload === undefined || payload === null) this.body = null;
    else if (payload instanceof Uint8Array || typeof payload === 'string') this.body = payload as BodyInit;
    else { this.body = JSON.stringify(payload); if (!this.headers.has('content-type')) this.headers.set('content-type', 'application/json; charset=utf-8'); }
    return this;
  }
}

type Handler = (req: CompatRequest, reply: CompatReply) => unknown;
interface Opts { preHandler?: (req: CompatRequest) => unknown }

/** `requireAuth` on Node looked the session up. Here the Worker has already done so and says who is calling. */
export const requireAuth = async (req: CompatRequest) => {
  if (!req.user) throw unauthorized('missing bearer token');
};

export class CompatApp {
  private readonly table: { method: string; path: string; opts: Opts; handler: Handler }[] = [];
  private hono: Hono<{ Bindings: CallerContext }> | null = null;

  private add(method: string, path: string, a: Opts | Handler, b?: Handler) {
    const handler = (b ?? a) as Handler;
    this.table.push({ method, path, opts: b ? (a as Opts) : {}, handler });
  }
  get(path: string, a: Opts | Handler, b?: Handler) { this.add('GET', path, a, b); }
  post(path: string, a: Opts | Handler, b?: Handler) { this.add('POST', path, a, b); }
  put(path: string, a: Opts | Handler, b?: Handler) { this.add('PUT', path, a, b); }
  patch(path: string, a: Opts | Handler, b?: Handler) { this.add('PATCH', path, a, b); }
  delete(path: string, a: Opts | Handler, b?: Handler) { this.add('DELETE', path, a, b); }
  setErrorHandler(_fn: unknown) { /* the object turns errors into answers */ }
  addHook(_name: string, _fn: unknown) { /* none needed on Workers */ }
  log = console;

  /** Fastify prefers a static path to a parameter whatever the order, so routes are registered static-first. */
  private router(): Hono<{ Bindings: CallerContext }> {
    if (this.hono) return this.hono;
    const hono = new Hono<{ Bindings: CallerContext }>();
    hono.onError((err) => {
      if (err instanceof ApiError) return Response.json({ error: { code: err.code, message: err.message } }, { status: err.statusCode });
      console.error(err.stack);
      return Response.json({ error: { code: 'internal', message: 'internal server error' } }, { status: 500 });
    });
    const rank = (p: string) => (p.match(/:/g) ?? []).length;
    for (const route of [...this.table].sort((x, y) => rank(x.path) - rank(y.path))) {
      hono.on(route.method, route.path, async (c) => {
        const raw = c.req.raw;
        const type = raw.headers.get('content-type') ?? '';
        let body: unknown;
        let form: FormData | null = null;
        if (type.includes('multipart/form-data')) form = await raw.formData();
        else if (raw.method !== 'GET' && raw.method !== 'HEAD') {
          const bytes = Buffer.from(await raw.arrayBuffer());
          if (bytes.length) body = type.includes('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes;
        }
        const url = new URL(raw.url);
        const req = {
          params: c.req.param(), query: Object.fromEntries(url.searchParams), body, ip: c.env.ip, method: raw.method,
          headers: Object.fromEntries(raw.headers), url: url.pathname + url.search, log: console,
          user: c.env.user, bearerToken: c.env.token, authKind: c.env.authKind,
          async file() {
            const part = [...(form?.values() ?? [])].find((v): v is File => typeof v !== 'string');
            return part && { filename: part.name, mimetype: part.type, toBuffer: async () => Buffer.from(await part.arrayBuffer()) };
          },
        } as unknown as CompatRequest;
        const reply = new CompatReply();
        await route.opts.preHandler?.(req);
        const result = await route.handler(req, reply);
        if (!(result instanceof CompatReply) && !reply.sent) reply.send(result);
        return new Response(reply.body ?? null, { status: reply.statusCode, headers: reply.headers });
      });
    }
    return (this.hono = hono);
  }

  handle(request: Request, caller: CallerContext): Promise<Response> {
    return Promise.resolve(this.router().fetch(request, caller));
  }
}
