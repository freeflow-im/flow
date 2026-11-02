// After export-to-edge.ts: signs in to the Worker as an imported person and compares what it answers with Postgres.
//   EDGE_URL=… DATABASE_URL=… CHECK_EMAIL=someone@… SIGNIN_TOKEN=<from their sign-in mail> node --experimental-strip-types scripts/check-edge-import.ts
// The sign-in link is the only way in that needs no password: request it (POST /v1/auth/signin-link) and read the mail.
import postgres from 'postgres';

const EDGE = (process.env.EDGE_URL ?? '').replace(/\/+$/, '');
const sql = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: () => {} });
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const api = async (token: string, path: string) => {
  const res = await fetch(EDGE + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

const email = process.env.CHECK_EMAIL!;
const signin = await fetch(`${EDGE}/v1/auth/signin-link/consume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: process.env.SIGNIN_TOKEN }) });
const { token, user } = (await signin.json()) as { token: string; user: { id: string; email: string } };
t('an imported person signs in with a mailed link', signin.ok && user?.email === email, String(signin.status));

const [pgUser] = await sql`SELECT * FROM users WHERE email = ${email}`;
t('as the same account, with the same id', user?.id === pgUser!.id);

const memberships = await sql`SELECT w.id, w.name FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ${pgUser!.id}`;
const mine = await api(token, '/v1/me/workspaces');
t('their organizations', mine.json?.workspaces?.length === memberships.length, `${mine.json?.workspaces?.length} on the edge, ${memberships.length} in Postgres`);

const top = (await sql`SELECT c.workspace_id AS w, count(*)::int AS n FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.workspace_id IN ${sql(memberships.map((m) => m.id as string))} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`)[0]!;
const channels = await api(token, `/v1/workspaces/${top.w}/channels`);
const pgChannels = await sql`SELECT c.id, c.name FROM channels c WHERE c.workspace_id = ${top.w} AND (NOT c.is_private OR c.id IN (SELECT channel_id FROM channel_members WHERE user_id = ${pgUser!.id})) AND c.kind = 'standard' AND c.archived_at IS NULL`;
t('the channels of their busiest organization', (channels.json?.channels ?? []).filter((c: any) => c.kind === 'standard' && !c.archivedAt).length === pgChannels.length, `${(channels.json?.channels ?? []).length} on the edge (all kinds), ${pgChannels.length} standard and open in Postgres`);

// A channel whose messages are all under the key given to the Worker: one under another key cannot be read here or on Node.
const keyId = process.env.FLOW_DATA_KEY_ID ?? 'env-1';
const [busiest] = await sql`SELECT m.channel_id AS id, count(*)::int AS n FROM messages m JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ${pgUser!.id} JOIN channels c ON c.id = m.channel_id WHERE c.workspace_id = ${top.w} AND m.thread_root_id IS NULL AND m.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.channel_id = m.channel_id AND o.enc_key_id <> ${keyId}) GROUP BY 1 ORDER BY 2 DESC LIMIT 1`;
const page = await api(token, `/v1/channels/${busiest!.id}/messages?limit=100`);
const got = page.json?.messages ?? [];
t('a channel found by its id alone', page.status === 200, String(page.status));
t('its messages', got.length === Math.min(100, busiest!.n), `${got.length} on the edge, ${busiest!.n} in Postgres`);
const readable = got.filter((m: any) => typeof m.body === 'string' && m.body.length > 0).length;
t('their bodies decrypt with the key carried over', readable > 0, `${readable} of ${got.length} have text`);
const [newest] = await sql`SELECT id FROM messages WHERE channel_id = ${busiest!.id} AND thread_root_id IS NULL AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`;
t('newest first, as before', got[0]?.id === newest!.id);
const thread = await api(token, `/v1/messages/${newest!.id}/thread`);
t('a message found by its id alone', thread.status === 200, String(thread.status));

// Every kind the organization shares, and one of each read back with its body from R2.
for (const [kind, list, key] of [['spreadsheets', 'sheets', 'sheets'], ['documents', 'docs', 'docs'], ['Markdown files', 'markdown', 'docs'], ['stored files', 'files', 'files']] as const) {
  const listed = await api(token, `/api/${list}?workspace=${top.w}&shared=1`);
  const items = listed.json?.[key] ?? [];
  t(`Docs: the organization's ${kind}`, listed.status === 200, `${listed.status}, ${items.length} listed`);
  if (!items.length) continue;
  const res = await fetch(`${EDGE}/api/${list}/${items[0].id}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.arrayBuffer();
  t(`Docs: one of its ${kind}, body and all`, res.status === 200 && body.byteLength > 0, `${res.status}, ${body.byteLength} bytes`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await sql.end();
process.exit(fail ? 1 : 0);
