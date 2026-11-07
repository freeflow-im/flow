// The one directory object. Each call runs inside the object and comes back as data, because an error's class does not
// survive the trip from a Durable Object to the Worker.
import { DurableObject } from 'cloudflare:workers';
import { ApiError } from '../errors';
import { sendMail, type MailEnv } from '../mail';
import { DirectoryCore, type ProvisioningMessage } from './core';
import { listVar } from './authHandoff';
import { dohResolver } from './dns';
import { hostedMailEnabled, mailProviderFor, type MailProviderEnv } from '../mailprovider/index';
import { insertRows, type ImportRow } from '../importing';
import { McpOAuth, OAuthError, type OAuthAnswer } from './mcpOAuth';

export type DirectoryAnswer<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string };

export interface DirectoryEnv extends MailEnv, MailProviderEnv {
  WEB_URL_BASE: string;
  REGISTRATION_ENABLED?: string;
  FLOW_HANDOFF_RETURN_URLS?: string;
  FLOW_ALLOWED_WEB_ORIGINS?: string;
  /** The DNS-over-HTTPS (JSON) resolver domain checks use; Cloudflare's when unset. The e2e points it at a stub. */
  DNS_RESOLVER_URL?: string;
  /** The `flow-provisioning` Queue (producer): accounts' mailboxes made, suspended, resumed, deleted (provisioning/). */
  PROVISIONING?: Queue<ProvisioningMessage>;
}

/** The core's methods, which are what a Worker may call. */
type Method = { [K in keyof DirectoryCore]: DirectoryCore[K] extends (...args: never[]) => unknown ? K : never }[keyof DirectoryCore];
/** The MCP authorization server's methods (mcpOAuth.ts). */
export type OAuthMethod = { [K in keyof McpOAuth]: McpOAuth[K] extends (...args: never[]) => unknown ? K : never }[keyof McpOAuth];

export class Directory extends DurableObject<DirectoryEnv> {
  private readonly core: DirectoryCore;
  private readonly mcpOAuth: McpOAuth;

  constructor(ctx: DurableObjectState, env: DirectoryEnv) {
    super(ctx, env);
    this.core = new DirectoryCore(ctx.storage.sql as never, {
      webUrlBase: env.WEB_URL_BASE,
      registrationEnabled: env.REGISTRATION_ENABLED !== '0',
      send: (mail) => sendMail(env, mail),
      handoffReturnUrls: listVar(env.FLOW_HANDOFF_RETURN_URLS),
      allowedWebOrigins: listVar(env.FLOW_ALLOWED_WEB_ORIGINS),
      resolve: dohResolver(env.DNS_RESOLVER_URL || 'https://cloudflare-dns.com/dns-query'),
      mailProvider: mailProviderFor(env),
      provisioning: hostedMailEnabled(env),
    });
    // After the core, which runs the migrations that make its tables.
    this.mcpOAuth = new McpOAuth(ctx.storage.sql as never);
  }

  /** The MCP endpoint's OAuth (routes/mcp.ts). An OAuth error comes back as data, with the code the spec names. */
  async oauth(method: OAuthMethod, args: unknown[]): Promise<OAuthAnswer<unknown>> {
    try {
      return { ok: true, value: await (this.mcpOAuth[method] as (...a: unknown[]) => unknown).apply(this.mcpOAuth, args) };
    } catch (err) {
      if (err instanceof OAuthError) return { ok: false, code: err.code, description: err.message, status: err.status };
      console.error(`directory oauth ${method}: ${(err as Error).stack}`);
      return { ok: false, code: 'server_error', description: 'internal server error', status: 500 };
    }
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
    } finally {
      await this.sendProvisioning();
    }
  }

  /** The provisioning messages the call made, to the Queue before the caller has its answer. A failed send is logged:
   * the account waits in its state, and POST /v1/workspaces/:id/provision sends it again. */
  private async sendProvisioning(): Promise<void> {
    const out = this.core.takeProvisioning();
    if (!out.length || !this.env.PROVISIONING) return;
    await this.env.PROVISIONING.sendBatch(out.map((body) => ({ body }))).catch((err) => console.error(`provisioning send: ${(err as Error).message}`));
  }
}
