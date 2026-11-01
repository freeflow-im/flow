// Stored pictures as the app in ChatGPT reads and writes them: the bytes come by a link that carries its own
// token, and go back to the plugin server with a one-time upload ticket (the iframe has no cookies).
import { titleFromFileName } from '../../client/src/importFile.ts';
import type { Host } from './host.ts';

export interface StoredPicture {
  id: string;
  title: string;
  type?: string;
}

export async function loadPicture(host: Host, id: string): Promise<{ file: StoredPicture; data: Blob }> {
  const { file, url } = await host.call<{ file: StoredPicture; url: string }>('file_link', { id });
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not read the picture (${res.status}).`);
  const data = await res.blob();
  return { file, data: file.type && data.type !== file.type ? new Blob([data], { type: file.type }) : data };
}

async function upload(host: Host, params: Record<string, string>, image: Blob): Promise<{ id: string }> {
  const { ticket, url } = await host.call<{ ticket: string; url: string }>('upload_ticket');
  const res = await fetch(`${url}?${new URLSearchParams({ ticket, ...params })}`, { method: 'POST', headers: { 'content-type': image.type || 'application/octet-stream' }, body: image });
  const body = (await res.json().catch(() => ({}))) as { file?: { id: string }; error?: string };
  if (!res.ok || !body.file) throw new Error(body.error ?? `Saving the picture failed (${res.status}).`);
  return body.file;
}

/** Store a picture for a document, slide or cell; resolves to its address. Sent as it is, not as text through a tool, so a large one is no trouble. */
export async function storePicture(host: Host, image: Blob): Promise<string> {
  const { ticket, url } = await host.call<{ ticket: string; url: string }>('upload_ticket');
  const res = await fetch(`${url}?${new URLSearchParams({ ticket, image: '1' })}`, { method: 'POST', headers: { 'content-type': image.type }, body: image });
  const body = (await res.json().catch(() => ({}))) as { src?: string; error?: string };
  if (!res.ok || !body.src) throw new Error(body.error ?? `Saving the picture failed (${res.status}).`);
  return body.src;
}

/** Save an edited picture over the stored one (the version before is kept for one revert). */
export const replacePicture = (host: Host, id: string, name: string, image: Blob) => upload(host, { name, replace: id }, image);

/** Save an edited picture as a new file, which the app then shows. */
export const createPicture = (host: Host, name: string, image: Blob) => upload(host, { name, title: titleFromFileName(name) }, image);
