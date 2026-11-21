// POST /v1/perf: the browser's timings of what a person did (src/perf.ts), logged one record each. Signed in only;
// the Mail client sends them with navigator.sendBeacon, in batches.
import { Hono } from 'hono';
import { PerfBody, clientRecord } from '../perf';
import { badRequest, unauthorized } from '../errors';
import { resolveCaller, type AuthEnv } from './auth';

const MAX_BYTES = 64 * 1024;

export const perfRoutes = new Hono<{ Bindings: AuthEnv }>();

perfRoutes.post('/v1/perf', async (c) => {
  if (!(await resolveCaller(c)).user) throw unauthorized('missing bearer token');
  const text = await c.req.text();
  if (text.length > MAX_BYTES) throw badRequest('too_large', 'at most 64 KB of timings at once');
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw badRequest('validation', 'body: not JSON'); }
  const body = PerfBody.safeParse(json);
  if (!body.success) throw badRequest('validation', body.error.issues[0]?.message ?? 'invalid request');
  for (const e of body.data.events) console.log(clientRecord(e));
  return c.body(null, 204);
});
