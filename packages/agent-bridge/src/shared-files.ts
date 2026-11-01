import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FileDTO } from '@flow/shared';
import { attachmentFilename } from './attachments.js';

export const MAX_SHARED_FILE_BYTES = 20 * 1024 * 1024;
export interface PreparedSharedFile {
  name: string;
  path: string;
  text: string;
  images: string[];
  notice?: string;
}

/** A cancellable worker keeps malformed/expensive documents off the audio loop. */
export async function prepareSharedFile(
  file: FileDTO,
  directory: string,
  download: (id: string, signal: AbortSignal) => Promise<Buffer>,
  signal: AbortSignal,
): Promise<PreparedSharedFile> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(file.id)) throw new Error('Invalid attachment identifier');
  if (file.sizeBytes > MAX_SHARED_FILE_BYTES) throw new Error('File exceeds the 20 MB call limit');
  signal.throwIfAborted();
  const data = await download(file.id, signal);
  signal.throwIfAborted();
  if (data.length > MAX_SHARED_FILE_BYTES) throw new Error('File exceeds the 20 MB call limit');
  const filePath = path.join(directory, attachmentFilename(file.id, file.name));
  await fs.writeFile(filePath, data, { mode: 0o600 });
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const adjacent = new URL('./shared-file-worker.js', import.meta.url);
    // tsx development uses the built worker too: Node workers cannot load TS unaided.
    const worker = new Worker(existsSync(adjacent) ? adjacent : new URL('../dist/shared-file-worker.js', import.meta.url), {
      workerData: { filePath, name: file.name, mimeType: file.mimeType },
      resourceLimits: { maxOldGenerationSizeMb: 192 },
    });
    let settled = false;
    const finish = (error?: Error, result?: PreparedSharedFile) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      // Wait for termination before the caller can remove its temporary directory.
      void worker.terminate().finally(() => error ? reject(error) : resolve(result!));
    };
    const abort = () => finish(new Error('File preparation cancelled'));
    const timer = setTimeout(() => finish(new Error('Document took too long to open (20 seconds)')), 20_000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    worker.once('message', (message: { result?: PreparedSharedFile; error?: string }) => {
      if (message.result) finish(undefined, message.result);
      else finish(new Error(message.error ?? 'Could not read document'));
    });
    worker.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once('exit', () => finish(new Error('Document reader stopped unexpectedly')));
  });
}
