// One object, one thread: there is no second replica to exclude.
export const LOCK_KEYS = { orphanSweep: 0n } as const;
export async function runExclusive<T>(_key: bigint, fn: () => Promise<T>): Promise<{ ran: true; result: T }> { return { ran: true, result: await fn() }; }
