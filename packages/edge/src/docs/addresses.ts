// Where a Docs object lives in the Workspace client (packages/docs/client/src/main.tsx' routes), relative to the site:
// what the share index's rows, the sharing events and `docs.file.changed` carry as `url`. A folder opens in Shared with
// me (HomePage's `withme` and `in`, with the organization as `org`).
import type { Reference } from '@flow/shared';

const PATHS: Record<string, string> = { sheet: 's', deck: 'd', doc: 'doc', markdown: 'md', file: 'f' };

/** The address of a Docs reference, by the kind of file it is (a document's kind, `file`, `folder`); null for another app's. */
export function docsAddress(ref: Reference | null, fileKind: string): string | null {
  if (!ref || ref.app !== 'docs') return null;
  const id = encodeURIComponent(ref.id);
  if (ref.kind === 'folder') return `/workspace/?withme=1&in=${id}&org=${encodeURIComponent(ref.organizationId)}`;
  return `/workspace/${PATHS[fileKind] ?? (ref.kind === 'file' ? 'f' : 's')}/${id}`;
}
