// Types of mcpAuth.js (plain JavaScript, as main.js is, which imports it).
import type http from 'node:http';

export function clientName(name: unknown): string;
export function allowedRedirect(uri: string): boolean;

export class LocalOAuth {
  constructor(opts: { file: string; issuer: string; approve: (name: string) => Promise<boolean>; now?: () => number });
  readonly resourceMetadataUrl: string;
  clients(): { id: string; name: string; approved: string }[];
  revoke(id: string): boolean;
  revokeAll(): void;
  verify(header: string | undefined): string | null;
  handles(pathname: string): boolean;
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
}
