// Connectors: external data sources (Brex, ...) whose data can be pulled into a spreadsheet.
// Types shared by the server (server/connectors), the Connectors page and the agent's ingest tool.
import { parseLiteral } from './values.ts';

export type ConnectorAuthType = 'api_key' | 'oauth2';

/** A secret or plain setting the user enters when setting up a connection (api_key auth). */
export interface ConnectorField {
  key: string;
  label: string;
  /** Secret fields are stored encrypted and never sent back to the browser. */
  secret: boolean;
  help?: string;
  placeholder?: string;
}

/** A connector as described to the browser and the agent (no code, no secrets). */
export interface ConnectorInfo {
  id: string;
  name: string;
  /** Short text or emoji shown as the connector's icon. */
  icon: string;
  description: string;
  authTypes: ConnectorAuthType[];
  fields: ConnectorField[];
  /** Setup help shown in the dialog (how to create a token, scopes needed). */
  setupHelp?: string;
  /** OAuth is configured on this server (client id and secret are set). */
  oauthAvailable?: boolean;
  datasets: { id: string; description: string; params: Record<string, unknown> }[];
}

export type ConnectionStatus = 'connected' | 'error' | 'needs_reauth';

/** A user's configured connection, as sent to the browser and the agent. Never includes secrets. */
export interface ConnectionInfo {
  id: string;
  connector: string;
  name: string;
  authType: ConnectorAuthType;
  status: ConnectionStatus;
  /** Last error, when status is not connected. */
  error?: string;
  /** Last four characters of the main secret, e.g. "••••a1b2". */
  masked?: string;
  /** Non-secret field values. */
  settings: Record<string, string>;
  createdAt: string;
  lastUsedAt?: string;
}

export type ColumnType = 'string' | 'number' | 'date' | 'datetime' | 'boolean';
export type Primitive = string | number | boolean | null;

/** Tabular data returned by a dataset query. */
export interface TabularResult {
  columns: { name: string; type: ColumnType }[];
  rows: Primitive[][];
  /** More rows exist than were fetched (the row cap was reached). */
  truncated: boolean;
}

/** Result of POST /api/connections/:id/fetch (and of fetch_connector_data, with the rows cut to a preview). */
export interface FetchResult extends TabularResult {
  handle: string;
  totalRows: number;
}

/**
 * A fetched value as cell input: numbers and ISO dates are written so they parse as real numbers and dates;
 * text that would otherwise be read as a number, date, boolean or formula is kept as text.
 */
export function toCellInput(v: Primitive, type: ColumnType): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (type === 'date' || type === 'datetime') {
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?/.exec(v);
    if (m) return type === 'date' || !m[2] ? m[1] : `${m[1]} ${m[2]}`;
  }
  if (type === 'number' && /^-?\d+(\.\d+)?$/.test(v)) return v;
  const parsed = parseLiteral(v);
  return v.startsWith('=') || v.startsWith("'") || parsed.value !== v ? `'${v}` : v;
}
