/**
 * Where j (1, older) or k (-1, newer) takes the keyboard in the message list.
 * `at` is the conversation under the cursor (or the open one), -1 for none; `open` says that conversation is the open one.
 * With the newest conversation open there is nothing above it, so k closes the reader and goes back to the list.
 */
export type ListMove = { kind: 'select'; index: number } | { kind: 'close' } | { kind: 'none' };

export function listMove(length: number, at: number, by: 1 | -1, open: boolean): ListMove {
  if (length === 0) return { kind: 'none' };
  if (by === -1 && open && at === 0) return { kind: 'close' };
  const i = at < 0 ? 0 : at + by;
  return { kind: 'select', index: Math.max(0, Math.min(length - 1, i)) };
}
