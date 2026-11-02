// One organization: its database and its sockets. Requests arrive from the Worker with the user already authenticated.
import { DurableObject } from 'cloudflare:workers';
import type { UserDTO } from '@flow/shared';
import { withPublisher } from './bus';
import { openDb, withDb, type DB, schema } from './db/index';
import { ORG_MIGRATIONS } from './db/migrations';
import { ApiError } from '../errors';
import { setMailEnv } from './email/index';
import { setStorageEnv, type StorageEnv } from './storage/index';
import * as ch from './services/channels';
import * as msg from './services/messages';
import * as ws from './services/workspaces';

export type OrgEnv = StorageEnv & { FLOW_DATA_KEY?: string };
export type OrgAnswer = { ok: true; value: unknown } | { ok: false; status: number; code: string; message: string };

export class Org extends DurableObject<OrgEnv> {
  private readonly db: DB;

  constructor(ctx: DurableObjectState, env: OrgEnv) {
    super(ctx, env);
    setStorageEnv(env);
    setMailEnv(env as never);
    this.db = openDb(ctx.storage);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY)');
    const done = (sql.exec('SELECT COALESCE(MAX(n), -1) AS n FROM _migrations').one().n as number) + 1;
    ORG_MIGRATIONS.slice(done).forEach((m, i) => {
      for (const statement of m.split('--> statement-breakpoint')) sql.exec(statement);
      sql.exec('INSERT INTO _migrations (n) VALUES (?)', done + i);
    });
  }

  /** Keeps the organization's copy of a member's profile current, which is what its joins read. */
  private ensureUser(u: UserDTO): void {
    this.db.insert(schema.users).values({
      id: u.id, email: u.email || `${u.id}@hidden.invalid`, passwordHash: '!directory', displayName: u.displayName, avatarUrl: u.avatarUrl, timezone: u.timezone, isAgent: u.isAgent,
    }).onConflictDoUpdate({ target: schema.users.id, set: { displayName: u.displayName, avatarUrl: u.avatarUrl, timezone: u.timezone } }).run();
  }

  async call(user: UserDTO, method: string, args: unknown[]): Promise<OrgAnswer> {
    const events: unknown[] = [];
    try {
      const value = await withPublisher((subject, event) => events.push({ subject, event }), () => withDb(this.db, async () => {
        this.ensureUser(user);
        const fns: Record<string, (...a: never[]) => unknown> = { createWorkspace: ws.createWorkspace, createChannel: ch.createChannel, sendMessage: msg.sendMessage, listMessages: msg.listMessages };
        return fns[method]!(...(args as never[]));
      }));
      return { ok: true, value: JSON.parse(JSON.stringify({ value, events })) };
    } catch (err) {
      if (err instanceof ApiError || (err as { statusCode?: number }).statusCode) {
        const e = err as ApiError;
        return { ok: false, status: e.statusCode, code: e.code, message: e.message };
      }
      console.error(`org ${method}: ${(err as Error).stack}`);
      return { ok: false, status: 500, code: 'internal', message: String((err as Error).message) };
    }
  }
}
