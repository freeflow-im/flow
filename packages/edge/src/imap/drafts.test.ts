import { describe, expect, it } from 'vitest';
import { compileMime, outgoingMessage } from './drafts';

const me = { email: 'ann@example.com', displayName: 'Ann' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('an outgoing message', () => {
  it('sends an inline picture as a related part the HTML shows by cid, and a file as an attachment', async () => {
    const message = outgoingMessage(me, { to: [{ name: 'Bo', address: 'bo@example.com' }], subject: 'Pic', html: '<p>Look:</p><img src="cid:img-1@freeflow.im" alt="">' }, [
      { filename: 'image-1.png', contentType: 'image/png', content: png, contentId: 'img-1@freeflow.im', inline: true },
      { filename: 'notes.txt', contentType: 'text/plain', content: Buffer.from('notes') },
    ]);
    const raw = (await compileMime(message, false)).toString('latin1');
    expect(raw).toMatch(/Content-Type: multipart\/related/i);
    expect(raw).toMatch(/Content-ID: <img-1@freeflow\.im>/i);
    expect(raw).toMatch(/Content-Disposition: inline; filename=image-1\.png/i);
    expect(raw).toMatch(/Content-Disposition: attachment; filename=notes\.txt/i);
    expect(raw).toContain('src="cid:img-1@freeflow.im"');
    // Angle brackets given with the id are not doubled.
    const angled = outgoingMessage(me, { to: [], subject: '', html: '' }, [{ filename: 'a.png', contentType: 'image/png', content: png, contentId: '<x@y>' }]);
    expect((await compileMime(angled, false)).toString('latin1')).toMatch(/Content-ID: <x@y>/);
  });
});
