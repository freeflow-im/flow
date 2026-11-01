// A stored zip file's contents, for its file page: what is in it, one file's bytes, and a Word, Excel or
// PowerPoint file inside it converted to be shown read-only. Nothing is unpacked to disk or stored.
import JSZip from 'jszip';
import { readFile, stat } from 'node:fs/promises';
import type { ZipEntry, ZipOfficeView } from '../shared/zip.ts';
import { importDocx } from './docxImport.ts';
import { importPptx } from './pptxImport.ts';
import { importExcel } from './xlsxImport.ts';

export class ZipError extends Error {}

/** The largest zip opened, and the largest file taken out of one (a video, say). */
export const MAX_ZIP_BYTES = 500 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 200 * 1024 * 1024;
/** The largest Word, Excel or PowerPoint file inside a zip that is converted to be shown. */
export const MAX_OFFICE_ENTRY_BYTES = 20 * 1024 * 1024;

// The last few zips opened, kept read: a web page or a folder of pictures asks for many of its files in turn.
const opened = new Map<string, Promise<JSZip>>();
const KEEP = 3;

export async function openZip(file: string): Promise<JSZip> {
  const { size, mtimeMs } = await stat(file);
  if (size > MAX_ZIP_BYTES) throw new ZipError(`This zip file is too large to open here (over ${MAX_ZIP_BYTES / 1024 / 1024} MB). Download it instead.`);
  const key = `${file}:${size}:${mtimeMs}`;
  let zip = opened.get(key);
  if (!zip) {
    zip = readFile(file).then((buf) => JSZip.loadAsync(buf));
    zip.catch(() => opened.delete(key));
    opened.set(key, zip);
    while (opened.size > KEEP) opened.delete(opened.keys().next().value!);
  } else {
    // Most recently used last.
    opened.delete(key);
    opened.set(key, zip);
  }
  try {
    return await zip;
  } catch {
    throw new ZipError('This file is not a zip file the app can read.');
  }
}

interface JSZipStream {
  on(event: 'data', fn: (chunk: Uint8Array) => void): JSZipStream;
  on(event: 'error', fn: (e: Error) => void): JSZipStream;
  on(event: 'end', fn: () => void): JSZipStream;
  pause(): JSZipStream;
  resume(): JSZipStream;
}

/** The size a file inside a zip says it unpacks to. */
const declaredSize = (f: JSZip.JSZipObject) => (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;

/** Files the system put in the zip, not the person who made it. */
const isJunk = (path: string) => /(^|\/)__MACOSX\//.test(path) || /(^|\/)\.DS_Store$/.test(path);

/** The files in a zip (folders are the paths' parts), in its order. */
export function zipEntries(zip: JSZip): ZipEntry[] {
  const entries: ZipEntry[] = [];
  zip.forEach((path, f) => {
    if (f.dir || isJunk(path)) return;
    // A zip keeps the time on the clock where it was made, with no zone; JSZip reads it as UTC. Sent with no
    // zone, it is read as a time on the viewer's clock.
    entries.push({ path, size: declaredSize(f), modified: f.date.toISOString().slice(0, 19) });
  });
  return entries;
}

/**
 * The bytes of the file at `path` in the zip, or null when there is none. Unpacking stops at `limit`
 * bytes whatever the zip says the file's size is, so a small zip that unpacks to a huge file is refused.
 */
export async function zipEntryBytes(zip: JSZip, path: string, limit = MAX_ENTRY_BYTES): Promise<Buffer | null> {
  const f = zip.file(path);
  if (!f || f.dir || isJunk(path)) return null;
  const tooLarge = () => new ZipError(`“${path.split('/').pop()}” is too large to open from the zip (over ${Math.round(limit / 1024 / 1024)} MB).`);
  if (declaredSize(f) > limit) throw tooLarge();
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    // JSZip's own stream (not in its types), which can be stopped part way.
    const stream = (f as unknown as { internalStream(type: 'uint8array'): JSZipStream }).internalStream('uint8array');
    stream
      .on('data', (chunk: Uint8Array) => {
        total += chunk.length;
        if (total > limit) {
          stream.pause();
          reject(tooLarge());
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (e: Error) => reject(new ZipError(`“${path}” could not be unpacked: ${e.message}`)))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .resume();
  });
}

/** A Word, Excel or PowerPoint file from a zip, converted to be shown, with its pictures inline. */
export async function zipOfficeView(name: string, bytes: Buffer): Promise<ZipOfficeView> {
  const inline = async (type: string, data: Buffer) => `data:${type};base64,${data.toString('base64')}`;
  if (/\.docx$/i.test(name)) return { kind: 'doc', ...(await importDocx(bytes, inline)) };
  if (/\.pptx$/i.test(name)) return { kind: 'deck', ...(await importPptx(bytes, inline)) };
  if (/\.xlsx?$/i.test(name)) return { kind: 'sheet', ...(await importExcel(bytes)) };
  throw new ZipError(`“${name}” is not a Word, Excel or PowerPoint file.`);
}
