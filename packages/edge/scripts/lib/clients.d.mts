import type { AppManifest } from '@flow/shared';

export interface AssembledClient {
  name: string;
  from: string;
  to: string;
  page: string | null;
  optional: boolean;
}

export function clientsFrom(manifests: AppManifest[], root: string, out: string): AssembledClient[];
