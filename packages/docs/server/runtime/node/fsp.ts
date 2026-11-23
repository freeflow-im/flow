// `node:fs/promises` as the Docs server sees it on Node: the real thing.
export * from 'node:fs/promises';

import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/** A file written from a stream of `size` bytes, never held whole in memory (the workerd seam's twin). */
export async function writeStream(file: string, body: ReadableStream<Uint8Array>, size: number): Promise<void> {
  let n = 0;
  const counted = Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>).on('data', (chunk: Buffer) => (n += chunk.length));
  await pipeline(counted, createWriteStream(file));
  if (n !== size) throw new Error(`writeStream: expected ${size} bytes, got ${n}`);
}
