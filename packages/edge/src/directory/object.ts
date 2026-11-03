// The one directory object. Each call runs inside the object and comes back as data, because an error's class does not
// survive the trip from a Durable Object to the Worker.
import { DurableObject } from 'cloudflare:workers';
import { ApiError } from '../errors';
import { sendMail, type MailEnv } from '../mail';
import { DirectoryCore } from './core';
import { listVar } from './authHandoff';
import { insertRows, type ImportRow } from '../importing';

export type DirectoryAnswer<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string };

export interface DirectoryEnv extends MailEnv {
  WEB_URL_BASE: string;
  REGISTRATION_ENABLED?: string;
  FLOW_HANDOFF_RETURN_URLS?: string;
  FLOW_ALLOWED_WEB_ORIGINS?: string;
}

/** The core's methods, which are what a Worker may call. */
type Method = { [K in keyof DirectoryCore]: DirectoryCore[K] extends (...args: never[]) => unknown ? K : never }[keyof DirectoryCore];

export class Directory extends DurableObject<DirectoryEnv> {
  private readonly core: DirectoryCore;

  constructor(ctx: DurableObjectState, env: DirectoryEnv) {
    super(ctx, env);
    this.core = new DirectoryCore(ctx.storage.sql as never, {
      webUrlBase: env.WEB_URL_BASE,
      registrationEnabled: env.REGISTRATION_ENABLED !== '0',
      send: (mail) => sendMail(env, mail),
      handoffReturnUrls: listVar(env.FLOW_HANDOFF_RETURN_URLS),
      allowedWebOrigins: listVar(env.FLOW_ALLOWED_WEB_ORIGINS),
    });
  }

  /** The one-time import (routes/admin.ts). Only identity's tables. */
  importRows(table: string, rows: ImportRow[]): { added: number } {
    if (!['users', 'sessions', 'oauth_identities', 'agent_tokens', 'memberships', 'organization_slugs'].includes(table)) throw new Error(`not a directory table: ${table}`);
    return { added: insertRows(this.ctx.storage.sql, table, rows) };
  }

  async call(method: Method, args: unknown[]): Promise<DirectoryAnswer<unknown>> {
    try {
      return { ok: true, value: await (this.core[method] as (...a: unknown[]) => unknown).apply(this.core, args) };
    } catch (err) {
      if (err instanceof ApiError) return { ok: false, status: err.statusCode, code: err.code, message: err.message };
      console.error(`directory ${method}: ${(err as Error).stack}`);
      return { ok: false, status: 500, code: 'internal', message: 'internal server error' };
    }
  }
}
