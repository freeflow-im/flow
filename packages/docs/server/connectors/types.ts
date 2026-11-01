// The connector interface. A connector describes an external service (auth, setup fields) and its
// datasets: named, parameterised queries that return a table. See docs/connectors.md to add one.
import type { z } from 'zod';
import type { ColumnType, ConnectorAuthType, ConnectorField, Primitive } from '../../shared/connectors.ts';

export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Environment variables holding this server's OAuth client id and secret. */
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Extra query parameters for the authorize URL (e.g. access_type=offline). */
  extraAuthorizeParams?: Record<string, string>;
}

/** What a dataset's fetch or a connection test gets to work with. */
export interface FetchContext {
  /** The decrypted credentials: api_key field values, or { access_token } for OAuth. */
  credentials: Record<string, string>;
  /** Stop after this many rows (and report truncation). */
  maxRows: number;
  /** Injectable for tests. */
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

export interface DatasetResult {
  rows: Primitive[][];
  truncated: boolean;
}

export interface Dataset<P extends z.ZodObject = z.ZodObject> {
  id: string;
  description: string;
  /** Dataset parameters. Every dataset also accepts `limit` (row cap), added by the framework. */
  params: P;
  columns: { name: string; type: ColumnType }[];
  fetch(ctx: FetchContext, params: z.infer<P>): Promise<DatasetResult>;
}

export interface Connector {
  id: string;
  name: string;
  icon: string;
  description: string;
  authTypes: ConnectorAuthType[];
  /** Fields the user fills in for api_key auth. */
  fields: ConnectorField[];
  setupHelp?: string;
  oauth?: OAuthConfig;
  /** A cheap request that succeeds only with working credentials. Throws ConnectorError otherwise. */
  test(ctx: FetchContext): Promise<void>;
  datasets: Dataset[];
}

export type ConnectorErrorCode = 'auth' | 'forbidden' | 'rate_limited' | 'unavailable' | 'bad_request' | 'not_found';

/** An error with a message fit for the user and the agent (never contains credentials). */
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  constructor(code: ConnectorErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Convert an amount in minor units (cents) to a decimal amount, using the currency's decimal places. */
export function fromMinorUnits(amount: unknown, currency: unknown): number | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  let digits = 2;
  if (typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)) {
    try {
      digits = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
  }
  return Number((amount / 10 ** digits).toFixed(digits));
}

export interface HttpJsonOptions {
  /** Name of the service, for error messages. */
  service: string;
  headers: Record<string, string>;
  /** Retries for 429 and 5xx responses. */
  retries?: number;
  /** Map an error status to a message; return undefined for the default. */
  describe?: (status: number, body: string) => ConnectorError | undefined;
}

const MAX_BACKOFF_MS = 30_000;

/** GET a JSON resource with retry/backoff on 429 (honouring Retry-After) and 5xx, and clear errors. */
export async function getJson(ctx: FetchContext, url: string, opts: HttpJsonOptions): Promise<unknown> {
  const retries = opts.retries ?? 4;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await ctx.fetch(url, { headers: { Accept: 'application/json', ...opts.headers }, signal: AbortSignal.timeout(30_000) });
    } catch {
      if (attempt < retries) {
        await ctx.sleep(backoff(attempt));
        continue;
      }
      throw new ConnectorError('unavailable', `${opts.service} could not be reached. Check your network and try again.`);
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw new ConnectorError('unavailable', `${opts.service} returned an unreadable response.`);
      }
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const after = Number(res.headers.get('retry-after'));
      await ctx.sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, MAX_BACKOFF_MS) : backoff(attempt));
      continue;
    }
    const body = await res.text().catch(() => '');
    throw opts.describe?.(res.status, body) ?? defaultHttpError(opts.service, res.status);
  }
}

function backoff(attempt: number): number {
  return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
}

export function defaultHttpError(service: string, status: number): ConnectorError {
  if (status === 401) return new ConnectorError('auth', `${service} rejected the credentials (401). The token may be invalid, expired or revoked; update the connection on the Connectors page.`);
  if (status === 403) return new ConnectorError('forbidden', `${service} denied access (403). The token is missing a required scope or permission.`);
  if (status === 404) return new ConnectorError('not_found', `${service} could not find that resource (404).`);
  if (status === 429) return new ConnectorError('rate_limited', `${service} is rate limiting requests (429). Wait a minute and try again.`);
  if (status >= 500) return new ConnectorError('unavailable', `${service} had a server error (HTTP ${status}). Try again later.`);
  return new ConnectorError('bad_request', `${service} rejected the request (HTTP ${status}).`);
}
