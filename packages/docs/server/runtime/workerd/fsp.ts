// `node:fs/promises` for the Docs stores: their files are objects in R2 under this organization's prefix.
import { docsContext } from './context.ts';

const keyOf = (file: string) => `${docsContext().prefix}${String(file).replace(/^\/+/, '')}`;
function missing(file: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${file}'`), { code: 'ENOENT' });
}

export async function readFile(file: string, encoding?: string | { encoding?: string }): Promise<never> {
  const o = await docsContext().bucket.get(keyOf(file));
  if (!o) throw missing(file);
  const bytes = Buffer.from(await o.arrayBuffer());
  const enc = typeof encoding === 'string' ? encoding : encoding?.encoding;
  return (enc ? bytes.toString(enc as BufferEncoding) : bytes) as never;
}
export async function writeFile(file: string, data: string | Uint8Array): Promise<void> {
  await docsContext().bucket.put(keyOf(file), data);
}
export async function rename(from: string, to: string): Promise<void> {
  const { bucket } = docsContext();
  const o = await bucket.get(keyOf(from));
  if (!o) throw missing(from);
  await bucket.put(keyOf(to), o.body, { httpMetadata: o.httpMetadata });
  await bucket.delete(keyOf(from));
}
export async function copyFile(from: string, to: string): Promise<void> {
  const { bucket } = docsContext();
  const o = await bucket.get(keyOf(from));
  if (!o) throw missing(from);
  await bucket.put(keyOf(to), o.body, { httpMetadata: o.httpMetadata });
}
export async function unlink(file: string): Promise<void> { await docsContext().bucket.delete(keyOf(file)); }
export async function rm(file: string, _opts?: unknown): Promise<void> { await unlink(file); }
export async function mkdir(_dir: string, _opts?: unknown): Promise<void> { /* R2 has no directories */ }
export async function access(file: string): Promise<void> { await stat(file); }
export async function stat(file: string): Promise<{ size: number; mtimeMs: number; mtime: Date; isFile(): boolean; isDirectory(): boolean }> {
  const o = await docsContext().bucket.head(keyOf(file));
  if (!o) throw missing(file);
  return { size: o.size, mtimeMs: o.uploaded.getTime(), mtime: o.uploaded, isFile: () => true, isDirectory: () => false };
}
export async function readdir(dir: string): Promise<string[]> {
  const prefix = `${keyOf(dir).replace(/\/+$/, '')}/`;
  const listed = await docsContext().bucket.list({ prefix, delimiter: '/' });
  return listed.objects.map((o) => o.key.slice(prefix.length));
}
export default { readFile, writeFile, rename, copyFile, unlink, rm, mkdir, access, stat, readdir };

/** A handle that reads a slice of an R2 object, for code that looks at the start of a file before reading the rest. */
export async function open(file: string, _flags?: string): Promise<{
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  stat(): ReturnType<typeof stat>;
  close(): Promise<void>;
}> {
  const { bucket } = docsContext();
  const key = keyOf(file);
  if (!(await bucket.head(key))) throw missing(file);
  return {
    async read(buffer, offset, length, position) {
      const o = await bucket.get(key, { range: { offset: position ?? 0, length } });
      const bytes = o ? new Uint8Array(await o.arrayBuffer()) : new Uint8Array();
      buffer.set(bytes.subarray(0, length), offset);
      return { bytesRead: bytes.length, buffer };
    },
    stat: () => stat(file),
    async close() {},
  };
}
