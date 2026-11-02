import { AsyncLocalStorage } from 'node:async_hooks';
import { uuidv7 } from 'uuidv7';

/** Time-ordered UUIDv7 — the ordering key for all rows (phase1.md §2). */
export function newId(): string {
  return uuidv7();
}

/** The id a new workspace must take: it names the object it lives in. */
export const presetWorkspaceId = new AsyncLocalStorage<string>();
