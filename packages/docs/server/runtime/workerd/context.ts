// What the Docs code reaches through module-level imports (`node:sqlite`, `node:fs`): the object handling this request.
// One isolate can hold several organizations' objects, so it cannot be a plain global.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface DocsContext { sql: SqlStorage; bucket: R2Bucket; prefix: string; transactionSync<T>(fn: () => T): T; /** The organization the request is for. */ organizationId?: string }
/** The organization of the request being handled, if any. */
export const currentOrganization = (): string | undefined => current.getStore()?.organizationId;
const current = new AsyncLocalStorage<DocsContext>();
export const withDocsContext = <T>(c: DocsContext, fn: () => T): T => current.run(c, fn);
export function docsContext(): DocsContext {
  const c = current.getStore();
  if (!c) throw new Error('no Docs object in scope');
  return c;
}
