import { describe, expect, it } from 'vitest';
import { inlineImages } from './inlineImages';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('inlineImages', () => {
  it('turns pasted (data:) and quoted (own attachment URL) pictures into inline parts shown by cid, and leaves the rest', async () => {
    const html = `<p>Hi</p><img src="data:image/png;base64,${PNG}" alt="dot"><p>and</p><img src="/v1/mail/accounts/a1/messages/7/attachments/2?folder=INBOX&amp;inline=1"><img src="https://x.test/pixel.gif"><img src="data:text/plain;base64,aGk=">`;
    const fetched: string[] = [];
    const out = await inlineImages(html, async (url) => { fetched.push(url); return new Blob([Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0))], { type: 'image/png' }); }, () => 'u');
    expect(out.attachments.map((a) => [a.filename, a.contentType, a.contentId, a.inline])).toEqual([
      ['image-1.png', 'image/png', 'img-1-u@freeflow.im', true], ['image-2.png', 'image/png', 'img-2-u@freeflow.im', true],
    ]);
    expect(out.attachments[0]!.contentBase64).toBe(PNG);
    expect(out.attachments[1]!.contentBase64).toBe(PNG);
    expect(fetched).toEqual(['/v1/mail/accounts/a1/messages/7/attachments/2?folder=INBOX&inline=1']);
    expect(out.html).toBe('<p>Hi</p><img src="cid:img-1-u@freeflow.im" alt="dot"><p>and</p><img src="cid:img-2-u@freeflow.im"><img src="https://x.test/pixel.gif"><img src="data:text/plain;base64,aGk=">');
    expect(out.bytes).toBe(Math.floor((PNG.length * 3) / 4) * 2);
  });

  it('leaves a message without pictures as it is, and one whose own picture cannot be read', async () => {
    expect(await inlineImages('<p>plain</p>', async () => null)).toEqual({ html: '<p>plain</p>', attachments: [], bytes: 0 });
    const html = '<img src="/v1/mail/accounts/a/messages/1/attachments/0?folder=X">';
    expect((await inlineImages(html, async () => null)).html).toBe(html);
  });
});
