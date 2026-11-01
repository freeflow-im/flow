import { afterEach, expect, it, vi } from 'vitest';
import { picturePng } from './copyPicture.ts';

afterEach(() => vi.unstubAllGlobals());

it('copies an uncropped PNG as it is, and refuses a picture it cannot read', async () => {
  const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  vi.stubGlobal('fetch', vi.fn(async (src: string) => (src === '/api/images/a' ? new Response(png, { headers: { 'Content-Type': 'image/png' } }) : new Response('', { status: 404 }))));
  expect(await (await picturePng({ src: '/api/images/a' })).arrayBuffer()).toEqual(await png.arrayBuffer());
  await expect(picturePng({ src: '/api/images/gone' })).rejects.toThrow(/could not be read \(404\)/);
});
