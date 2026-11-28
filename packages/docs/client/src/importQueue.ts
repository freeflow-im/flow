/** Several files dropped at once: imported one after another, each one's state kept for the progress card. */

export type QueuedImportState = 'queued' | 'uploading' | 'done' | 'failed';
export interface QueuedImport {
  name: string;
  state: QueuedImportState;
  /** Why it failed, when it did. */
  error?: string;
}
export type ImportQueue = QueuedImport[];

export const queueOf = (files: readonly File[]): ImportQueue => files.map((f) => ({ name: f.name, state: 'queued' }));
export const queueDone = (q: ImportQueue) => q.filter((i) => i.state === 'done' || i.state === 'failed').length;
export const queueFinished = (q: ImportQueue) => queueDone(q) === q.length;

/**
 * Imports `files` one at a time (the server and the browser both take one upload at a time best), calling
 * `onChange` with the whole queue after every step. A file that fails is marked and the rest go on.
 */
export async function runImports(files: readonly File[], importOne: (file: File) => Promise<void>, onChange: (q: ImportQueue) => void): Promise<ImportQueue> {
  let q = queueOf(files);
  const set = (i: number, item: Partial<QueuedImport>) => {
    q = q.map((x, j) => (j === i ? { ...x, ...item } : x));
    onChange(q);
  };
  onChange(q);
  for (let i = 0; i < files.length; i++) {
    set(i, { state: 'uploading' });
    try {
      await importOne(files[i]);
      set(i, { state: 'done' });
    } catch (e) {
      set(i, { state: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  }
  return q;
}
