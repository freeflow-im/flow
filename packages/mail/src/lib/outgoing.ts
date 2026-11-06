// Sending a message the composer handed over: its pictures turned into inline parts (lib/inlineImages.ts), its files read
// as base64, the 20 MB limit checked. This runs after the composer has closed, while the toast says "Sending…".
import { MAX_SEND_BYTES, type OutgoingAttachment, type OutgoingMessage } from '../api';
import type { Outgoing } from './compose';
import { fileSize } from './format';
import { inlineImages } from './inlineImages';
import type { Notice } from './notice';

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'));
    r.readAsDataURL(blob);
  });
}

/** One of this app's attachment URLs, read for a picture quoted from the original (null when it cannot be). */
export const fetchOurs = (url: string) => fetch(url, { credentials: 'same-origin' }).then((r) => (r.ok ? r.blob() : null), () => null);

/** The request body for `mailApi.send`. Throws (with what to tell the person) when the message is too big. */
export async function outgoingMessage(out: Pick<Outgoing, 'message' | 'files'>, read: (url: string) => Promise<Blob | null> = fetchOurs): Promise<OutgoingMessage> {
  // Pictures pasted in (data:) or quoted from the original (its attachments) go as inline parts the HTML shows by cid.
  const pictures = await inlineImages(out.message.html, read);
  const html = pictures.html;
  const total = out.files.reduce((n, f) => n + f.file.size, 0) + pictures.bytes + html.length;
  if (total > MAX_SEND_BYTES) throw new Error(`Messages can be at most 20 MB with their attachments (this one is ${fileSize(total)}).`);
  const files: OutgoingAttachment[] = await Promise.all(out.files.map(async (f) => ({ filename: f.filename, contentType: f.contentType, contentBase64: await toBase64(f.file) })));
  const attachments = [...files, ...pictures.attachments];
  return { ...out.message, html, ...(attachments.length ? { attachments } : {}) };
}

/**
 * Sends `out` in the background, saying so: "Sending…" at once, then "Message sent." (and `onSent`), or "Could not send:
 * <reason>" with Open, which hands the composer as it was to `reopen`.
 */
export function sendInBackground(
  out: Outgoing,
  d: { send(accountId: string, message: OutgoingMessage): Promise<unknown>; notice(n: Notice): void; onSent(): void; reopen(out: Outgoing): void; read?: (url: string) => Promise<Blob | null> },
): Promise<boolean> {
  d.notice({ text: 'Sending…', progress: true });
  return outgoingMessage(out, d.read)
    .then((message) => d.send(out.accountId, message))
    .then(
      () => {
        d.onSent();
        d.notice('Message sent.');
        return true;
      },
      (e: unknown) => {
        d.notice({ text: `Could not send: ${e instanceof Error ? e.message : String(e)}`, action: { label: 'Open', run: () => d.reopen(out) } });
        return false;
      },
    );
}
