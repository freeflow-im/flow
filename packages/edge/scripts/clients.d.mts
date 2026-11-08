export interface DeployClient {
  pkg: string;
  dir: string;
  dist: string;
  basePath: string;
  optional: boolean;
}

export function deployClients(): Promise<DeployClient[]>;
export function blocks(clients: DeployClient[]): Record<string, Record<string, string[]>>;
export function fill(text: string, file: string, fileBlocks: Record<string, string[]>): string;
