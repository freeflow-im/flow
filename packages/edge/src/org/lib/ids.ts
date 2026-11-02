import { uuidv7 } from 'uuidv7';

/** Time-ordered UUIDv7 — the ordering key for all rows (phase1.md §2). */
export function newId(): string {
  return uuidv7();
}
