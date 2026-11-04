// Pictures in a message being sent: every <img> the editor shows from a data: URL (pasted in) or from one of this app's
// own attachment URLs (a picture quoted from the original, or a draft's) becomes an inline part of the message, with a
// Content-ID the HTML shows it by (`cid:`), as mail readers expect. Anything else (a remote picture) is left as it is.
import type { OutgoingAttachment } from '../api';

export interface InlinePart extends OutgoingAttachment { contentId: string; inline: true }

/** One of this app's attachment URLs: a message's part, to send again as this message's own. */
const OURS = /^\/v1\/mail\/accounts\/[^/]+\/messages\/\d+\/attachments\/\d+(\?.*)?$/;

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/avif': 'avif' };

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * The HTML with its data: and own-attachment pictures turned into inline parts. `fetchOurs` reads one of this app's
 * attachment URLs (null when it cannot). `bytes` is what the parts come to, decoded, for the size check.
 */
export async function inlineImages(html: string, fetchOurs: (url: string) => Promise<Blob | null>, id: () => string = () => crypto.randomUUID()): Promise<{ html: string; attachments: InlinePart[]; bytes: number }> {
  if (!/<img/i.test(html)) return { html, attachments: [], bytes: 0 };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const attachments: InlinePart[] = [];
  let bytes = 0, n = 0;
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    let contentType = '', contentBase64 = '';
    const data = /^data:([^;,]+);base64,(.*)$/is.exec(src);
    if (data) {
      contentType = data[1]!.toLowerCase();
      contentBase64 = data[2]!.replace(/\s/g, '');
    } else if (OURS.test(src)) {
      const blob = await fetchOurs(src);
      if (!blob) continue;
      contentType = blob.type || 'application/octet-stream';
      contentBase64 = await toBase64(blob);
    } else continue;
    if (!contentType.startsWith('image/')) continue;
    n++;
    const contentId = `img-${n}-${id()}@freeflow.im`;
    const filename = img.getAttribute('data-filename') || `image-${n}.${EXT[contentType] ?? 'bin'}`;
    attachments.push({ filename, contentType, contentBase64, contentId, inline: true });
    bytes += Math.floor((contentBase64.length * 3) / 4);
    img.setAttribute('src', `cid:${contentId}`);
    img.removeAttribute('data-filename');
  }
  return { html: attachments.length ? doc.body.innerHTML : html, attachments, bytes };
}
