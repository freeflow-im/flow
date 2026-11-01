// Brex connector (https://developer.brex.com). Auth: a Brex user token sent as a Bearer token.
// List endpoints use cursor pagination ({ items, next_cursor }); amounts are { amount: <minor units>, currency }.
import { z } from 'zod';
import type { Primitive } from '../../shared/connectors.ts';
import { ConnectorError, defaultHttpError, fromMinorUnits, getJson, type Connector, type Dataset, type DatasetResult, type FetchContext } from './types.ts';

export const BREX_BASE_URL = 'https://platform.brexapis.com';
const PAGE_SIZE = 100;

type Item = Record<string, unknown>;

const obj = (v: unknown): Item => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Item) : {});
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);
const money = (v: unknown): number | null => fromMinorUnits(obj(v).amount, obj(v).currency);
const currency = (v: unknown): string | null => s(obj(v).currency);
const fullName = (u: unknown): string | null => [s(obj(u).first_name), s(obj(u).last_name)].filter(Boolean).join(' ') || null;

function headers(ctx: FetchContext): Record<string, string> {
  const token = ctx.credentials.api_token?.trim();
  if (!token) throw new ConnectorError('auth', 'This Brex connection has no user token. Add one on the Connectors page.');
  return { Authorization: `Bearer ${token}` };
}

/** The read-only scope (as named in the Brex dashboard's user token page) that each endpoint needs. */
const SCOPES: [prefix: string, scope: string][] = [
  ['/v2/users', 'Users'],
  ['/v2/cards', 'Cards'],
  ['/v2/transactions/card', 'Transactions card'],
  ['/v2/transactions/cash', 'Transactions cash'],
  ['/v2/accounts/cash', 'Accounts cash'],
  ['/v2/expenses', 'Expenses card'],
  ['/v2/budgets', 'Budgets'],
];

export function scopeFor(path: string): string {
  return SCOPES.find(([prefix]) => path.startsWith(prefix))?.[1] ?? 'the matching';
}

function describeError(status: number, path: string): ConnectorError | undefined {
  if (status === 401) return new ConnectorError('auth', 'Brex rejected the user token (401). It may be invalid, expired or revoked; create a new one in the Brex dashboard (Developer > User Tokens) and update the connection.');
  if (status === 403) {
    return new ConnectorError(
      'forbidden',
      `Brex denied access to ${path} (403): the user token does not have the "${scopeFor(path)}" read-only scope. In the Brex dashboard (Developer > User Tokens) add that scope to the token, or create a new token with read-only access to transactions, cards, users, accounts, expenses and budgets, and update the connection.`,
    );
  }
  if (status === 429) return new ConnectorError('rate_limited', 'Brex is rate limiting requests (429), even after retrying. Wait a minute and try again.');
  return status >= 500 ? defaultHttpError('Brex', status) : undefined;
}

function get(ctx: FetchContext, path: string, query: Record<string, string | string[] | undefined> = {}): Promise<unknown> {
  const url = new URL(path, BREX_BASE_URL);
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, x);
    else if (v !== undefined) url.searchParams.set(k, v);
  }
  return getJson(ctx, url.href, { service: 'Brex', headers: headers(ctx), describe: (status) => describeError(status, path) });
}

/** Endpoints the connection test tries, each needing a different scope; one success is enough. */
const PROBES: [path: string, query: Record<string, string>][] = [
  ['/v2/cards', { limit: '1' }],
  ['/v2/transactions/card/primary', { limit: '1' }],
  ['/v2/accounts/cash', { limit: '1' }],
  ['/v2/expenses/card', { limit: '1' }],
  ['/v2/budgets', { limit: '1' }],
  ['/v2/users/me', {}],
];

/** Fetch every page of a list endpoint (following next_cursor) until the row cap. */
export async function paginate(
  ctx: FetchContext,
  path: string,
  query: Record<string, string | string[] | undefined>,
  toRow: (item: Item) => Primitive[] | null,
  maxRows = ctx.maxRows,
): Promise<DatasetResult> {
  const rows: Primitive[][] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = obj(await get(ctx, path, { ...query, limit: String(PAGE_SIZE), cursor }));
    const items = Array.isArray(page.items) ? page.items : [];
    for (let i = 0; i < items.length; i++) {
      const row = toRow(obj(items[i]));
      if (!row) continue;
      if (rows.length >= maxRows) return { rows, truncated: true };
      rows.push(row);
    }
    cursor = s(page.next_cursor) ?? undefined;
    if (!cursor || !items.length) return { rows, truncated: false };
    if (rows.length >= maxRows) return { rows, truncated: true };
  }
}

// --- Parameters ---------------------------------------------------------------

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, 'Use a date like 2025-01-31 (or an ISO date-time).');
const lastDays = z.number().int().min(1).max(3650).optional().describe('Only the last N days (e.g. 30), counted back from today. Use instead of a start date.');

/** Start of the window as an ISO date-time, from an explicit date or a number of days back. */
function startOf(ctx: FetchContext, start: string | undefined, days: number | undefined): string | undefined {
  if (days) return new Date(ctx.now().getTime() - days * 86_400_000).toISOString().slice(0, 10) + 'T00:00:00Z';
  if (!start) return undefined;
  return start.length === 10 ? `${start}T00:00:00Z` : start;
}

/** Keep rows whose date (at column index `col`) is on or before `end`. */
function endFilter(end: string | undefined, col: number) {
  return (row: Primitive[] | null): Primitive[] | null => {
    if (!row || !end) return row;
    const d = row[col];
    return typeof d === 'string' && d.slice(0, 10) > end.slice(0, 10) ? null : row;
  };
}

const range = {
  last_days: lastDays,
  end_date: date.optional().describe('Only rows dated on or before this date (inclusive).'),
};

// --- Datasets -----------------------------------------------------------------

const cardTxParams = z.object({
  posted_at_start: date.optional().describe('Only transactions posted on or after this date, e.g. "2025-01-01".'),
  ...range,
});

const cardTransactions: Dataset<typeof cardTxParams> = {
  id: 'card_transactions',
  description: 'Card transactions on the primary Brex card account (purchases, refunds, ...), newest first. Amounts are decimals in the transaction currency.',
  params: cardTxParams,
  columns: [
    { name: 'id', type: 'string' },
    { name: 'initiated_at', type: 'date' },
    { name: 'posted_at', type: 'date' },
    { name: 'description', type: 'string' },
    { name: 'merchant', type: 'string' },
    { name: 'amount', type: 'number' },
    { name: 'currency', type: 'string' },
    { name: 'card_id', type: 'string' },
    { name: 'expense_id', type: 'string' },
    { name: 'type', type: 'string' },
  ],
  fetch: (ctx, p) => {
    const keep = endFilter(p.end_date, 2);
    return paginate(ctx, '/v2/transactions/card/primary', { posted_at_start: startOf(ctx, p.posted_at_start, p.last_days) }, (t) =>
      keep([
        s(t.id),
        s(t.initiated_at_date),
        s(t.posted_at_date),
        s(t.description),
        s(obj(t.merchant).raw_descriptor) ?? s(obj(t.merchant).name),
        money(t.amount),
        currency(t.amount),
        s(t.card_id),
        s(t.expense_id),
        s(t.type),
      ]),
    );
  },
};

const cashTxParams = z.object({
  account_id: z.string().optional().describe('Brex cash account id. Omit to include every cash account (see the cash_accounts dataset).'),
  posted_at_start: date.optional().describe('Only transactions posted on or after this date, e.g. "2025-01-01".'),
  ...range,
});

const cashTransactions: Dataset<typeof cashTxParams> = {
  id: 'cash_transactions',
  description: 'Transactions on Brex cash (business) accounts: deposits, transfers, payments. Amounts are decimals in the account currency.',
  params: cashTxParams,
  columns: [
    { name: 'id', type: 'string' },
    { name: 'account_id', type: 'string' },
    { name: 'initiated_at', type: 'date' },
    { name: 'posted_at', type: 'date' },
    { name: 'description', type: 'string' },
    { name: 'amount', type: 'number' },
    { name: 'currency', type: 'string' },
    { name: 'type', type: 'string' },
    { name: 'transfer_id', type: 'string' },
  ],
  fetch: async (ctx, p) => {
    let accounts = p.account_id ? [p.account_id] : [];
    if (!p.account_id) {
      const list = await paginate(ctx, '/v2/accounts/cash', {}, (a) => [s(a.id)], 1000);
      accounts = list.rows.map((r) => String(r[0]));
    }
    const keep = endFilter(p.end_date, 3);
    const rows: Primitive[][] = [];
    for (const id of accounts) {
      const res = await paginate(
        ctx,
        `/v2/transactions/cash/${encodeURIComponent(id)}`,
        { posted_at_start: startOf(ctx, p.posted_at_start, p.last_days) },
        (t) => keep([s(t.id), id, s(t.initiated_at_date), s(t.posted_at_date), s(t.description), money(t.amount), currency(t.amount), s(t.type), s(t.transfer_id)]),
        ctx.maxRows - rows.length,
      );
      rows.push(...res.rows);
      if (res.truncated || rows.length >= ctx.maxRows) return { rows, truncated: true };
    }
    return { rows, truncated: false };
  },
};

const cashAccounts: Dataset = {
  id: 'cash_accounts',
  description: 'Brex cash accounts with their current and available balances.',
  params: z.object({}),
  columns: [
    { name: 'id', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'status', type: 'string' },
    { name: 'primary', type: 'boolean' },
    { name: 'current_balance', type: 'number' },
    { name: 'available_balance', type: 'number' },
    { name: 'currency', type: 'string' },
  ],
  fetch: (ctx) =>
    paginate(ctx, '/v2/accounts/cash', {}, (a) => [
      s(a.id),
      s(a.name),
      s(a.status),
      typeof a.primary === 'boolean' ? a.primary : null,
      money(a.current_balance),
      money(a.available_balance),
      currency(a.current_balance),
    ]),
};

const cards: Dataset = {
  id: 'cards',
  description: 'Brex cards: last four digits, name, status, owner and type.',
  params: z.object({}),
  columns: [
    { name: 'id', type: 'string' },
    { name: 'last_four', type: 'string' },
    { name: 'card_name', type: 'string' },
    { name: 'status', type: 'string' },
    { name: 'owner_user_id', type: 'string' },
    { name: 'card_type', type: 'string' },
    { name: 'limit_type', type: 'string' },
  ],
  fetch: (ctx) =>
    paginate(ctx, '/v2/cards', {}, (c) => [s(c.id), s(c.last_four), s(c.card_name), s(c.status), s(obj(c.owner).user_id), s(c.card_type), s(c.limit_type)]),
};

const users: Dataset = {
  id: 'users',
  description: 'Users in the Brex account with email, status, department and location ids.',
  params: z.object({}),
  columns: [
    { name: 'id', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'email', type: 'string' },
    { name: 'status', type: 'string' },
    { name: 'department_id', type: 'string' },
    { name: 'location_id', type: 'string' },
    { name: 'manager_id', type: 'string' },
  ],
  fetch: (ctx) =>
    paginate(ctx, '/v2/users', {}, (u) => [s(u.id), fullName(u), s(u.email), s(u.status), s(u.department_id), s(u.location_id), s(u.manager_id)]),
};

const expenseParams = z.object({
  purchased_at_start: date.optional().describe('Only expenses purchased on or after this date, e.g. "2025-01-01".'),
  ...range,
});

const expenses: Dataset<typeof expenseParams> = {
  id: 'expenses',
  description: 'Card expenses with merchant, category, memo, status, budget and user. Amounts are decimals in the purchase currency.',
  params: expenseParams,
  columns: [
    { name: 'id', type: 'string' },
    { name: 'date', type: 'date' },
    { name: 'merchant', type: 'string' },
    { name: 'amount', type: 'number' },
    { name: 'currency', type: 'string' },
    { name: 'category', type: 'string' },
    { name: 'memo', type: 'string' },
    { name: 'status', type: 'string' },
    { name: 'budget', type: 'string' },
    { name: 'user', type: 'string' },
  ],
  fetch: (ctx, p) => {
    const keep = endFilter(p.end_date, 1);
    return paginate(
      ctx,
      '/v2/expenses/card',
      { purchased_at_start: startOf(ctx, p.purchased_at_start, p.last_days), 'expand[]': ['merchant', 'budget', 'user'] },
      (e) => {
        const amount = e.original_amount ?? e.billing_amount ?? e.amount;
        return keep([
          s(e.id),
          s(e.purchased_at) ?? s(e.purchased_at_date),
          s(obj(e.merchant).raw_descriptor) ?? s(obj(e.merchant).name),
          money(amount),
          currency(amount),
          s(e.category),
          s(e.memo),
          s(e.status),
          s(obj(e.budget).name) ?? s(e.budget_id),
          fullName(e.user) ?? s(e.user_id),
        ]);
      },
    );
  },
};

const budgets: Dataset = {
  id: 'budgets',
  description: 'Brex budgets with their status, amount (limit) and period.',
  params: z.object({}),
  columns: [
    { name: 'id', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'status', type: 'string' },
    { name: 'amount', type: 'number' },
    { name: 'currency', type: 'string' },
    { name: 'period', type: 'string' },
    { name: 'start_date', type: 'date' },
    { name: 'end_date', type: 'date' },
  ],
  fetch: (ctx) =>
    paginate(ctx, '/v2/budgets', {}, (b) => {
      const amount = b.amount ?? b.limit;
      return [
        s(b.id) ?? s(b.budget_id),
        s(b.name),
        s(b.spend_budget_status) ?? s(b.budget_status) ?? s(b.status),
        money(amount),
        currency(amount),
        s(b.period_recurrence_type) ?? s(b.period_type),
        s(b.start_date),
        s(b.end_date),
      ];
    }),
};

export const brex: Connector = {
  id: 'brex',
  name: 'Brex',
  icon: 'B',
  description: 'Card and cash transactions, expenses, cards, users and budgets from your Brex account.',
  authTypes: ['api_key'],
  fields: [
    {
      key: 'api_token',
      label: 'Brex user token',
      secret: true,
      placeholder: 'bxt_…',
      help: 'In the Brex dashboard go to Developer > User Tokens, create a token with read-only scopes, and paste it here.',
    },
  ],
  setupHelp:
    'Create a user token in the Brex dashboard under Developer > User Tokens. Give it read-only access to transactions, cards, users, accounts, expenses and budgets. The token is stored encrypted on the server and is never shown again.',
  // A token is fine if it can read anything this connector uses; datasets whose scope is missing report
  // that scope by name when they are fetched. Only a token with none of the scopes fails the test.
  test: async (ctx) => {
    const missing: string[] = [];
    for (const [path, query] of PROBES) {
      try {
        await get(ctx, path, query);
        return;
      } catch (e) {
        if (e instanceof ConnectorError && e.code === 'forbidden') {
          missing.push(scopeFor(path));
          continue;
        }
        throw e;
      }
    }
    throw new ConnectorError(
      'forbidden',
      `Brex accepted the user token but denied every request (403). The token has none of the read-only scopes this connector uses (${missing.join(', ')}). In the Brex dashboard (Developer > User Tokens) create a token with read-only access to transactions, cards, users, accounts, expenses and budgets.`,
    );
  },
  datasets: [cardTransactions, cashTransactions, cashAccounts, cards, users, expenses, budgets] as Dataset[],
};
