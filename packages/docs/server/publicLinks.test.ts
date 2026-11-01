import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { publicDeck } from './publicLinks.ts';
import { mailbox, signUp } from './testing.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: string;
let other: string;
const box = mailbox();

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });
const send = (method: 'PUT' | 'DELETE', url: string, cookie: string) => app.inject({ method, url, headers: { cookie } });
const upload = async (cookie: string, name: string, type: string, payload: Buffer) => (await app.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': type, 'x-filename': name }, payload })).json().file;
const image = async (cookie: string) => (await app.inject({ method: 'POST', url: '/api/images', headers: { cookie, 'content-type': 'image/png' }, payload: PNG })).json().url as string;
const tokenIn = (url: string) => url.split('/p/')[1];

/** A deck of `owner`'s with a picture, a video and speaker notes, and a slide's text that only mentions other files. */
async function makeDeck(picture: string, video: string, mentions: string) {
  const { deck: meta } = (await app.inject({ method: 'POST', url: '/api/decks', headers: { cookie: owner }, payload: { title: 'Launch' } })).json();
  const deck = {
    version: 1,
    theme: 'dark',
    slides: [
      {
        id: 's1',
        notes: 'Secret speaker notes',
        elements: [
          { id: 'e1', type: 'image', src: picture, x: 0, y: 0, w: 100, h: 100 },
          { id: 'e2', type: 'video', src: video, x: 0, y: 0, w: 100, h: 100 },
          { id: 'e3', type: 'text', x: 0, y: 0, w: 100, h: 100, paragraphs: [{ text: mentions }] },
        ],
      },
    ],
  };
  const res = await app.inject({ method: 'PUT', url: `/api/decks/${meta.id}`, headers: { cookie: owner }, payload: { deck } });
  expect(res.statusCode).toBe(200);
  return meta.id as string;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'public-links-test-'));
  app = await buildApp({ dataDir: dir, sendMail: box.send, appUrl: 'https://docs.test' });
  owner = (await signUp(app, box, 'owner@example.com')).cookie;
  other = (await signUp(app, box, 'other@example.com')).cookie;
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('public links', () => {
  it('shows a guest a deck without its notes, and only the files the deck shows', async () => {
    const picture = await image(owner);
    const hiddenPicture = await image(owner);
    const video = await upload(owner, 'clip.mp4', 'video/mp4', Buffer.from('0123456789'));
    const hiddenVideo = await upload(owner, 'private.mp4', 'video/mp4', Buffer.from('private'));
    const id = await makeDeck(picture, `/api/files/${video.id}`, `/api/files/${hiddenVideo.id}`);

    expect((await get(`/api/sharing/deck/${id}`, { cookie: owner })).json().url).toBeNull();
    const { url } = (await send('PUT', `/api/sharing/deck/${id}`, owner)).json();
    expect(url).toMatch(/^https:\/\/docs\.test\/p\/[A-Za-z0-9_-]{32}$/);
    // Asking again keeps the same address.
    expect((await send('PUT', `/api/sharing/deck/${id}`, owner)).json().url).toBe(url);
    const token = tokenIn(url);

    const res = await get(`/api/public/${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const view = res.json();
    expect(view).toMatchObject({ kind: 'deck', title: 'Launch' });
    expect(JSON.stringify(view)).not.toContain('Secret speaker notes');
    const [img, vid] = view.deck.slides[0].elements;
    expect(img.src).toBe(`/api/public/${token}/images/${picture.split('/').pop()}`);
    expect(vid.src).toBe(`/api/public/${token}/files/${video.id}`);

    const shown = await get(img.src);
    expect(shown.statusCode).toBe(200);
    expect(shown.headers['content-type']).toBe('image/png');
    expect(shown.headers['content-security-policy']).toBe('sandbox');
    const part = await get(vid.src, { range: 'bytes=2-5' });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('2345');

    // Other files of the owner's cannot be fetched with the token, also one a slide's text names.
    expect((await get(`/api/public/${token}/images/${hiddenPicture.split('/').pop()}`)).statusCode).toBe(404);
    expect((await get(`/api/public/${token}/files/${hiddenVideo.id}`)).statusCode).toBe(404);
    expect((await get(`/api/public/${token}/video`)).statusCode).toBe(404);

    // A picture taken off the slide stops being available.
    const { deck } = (await get(`/api/decks/${id}`, { cookie: owner })).json();
    deck.slides[0].elements = deck.slides[0].elements.filter((e: { type: string }) => e.type !== 'image');
    await app.inject({ method: 'PUT', url: `/api/decks/${id}`, headers: { cookie: owner }, payload: { deck } });
    expect((await get(img.src)).statusCode).toBe(404);

    // The link gives no way into the owner's own routes or anything to change.
    expect((await get(`/api/decks/${id}`)).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: `/api/public/${token}`, payload: { deck } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/api/decks/${id}`, payload: { deck } })).statusCode).toBe(401);
  });

  it('plays a shared video, seeking included, and stops when the link is stopped', async () => {
    const video = await upload(owner, 'talk.mp4', 'video/mp4', Buffer.from('0123456789'));
    const first = tokenIn((await send('PUT', `/api/sharing/file/${video.id}`, owner)).json().url);
    const view = (await get(`/api/public/${first}`)).json();
    expect(view).toEqual({ kind: 'video', title: 'talk.mp4', url: `/api/public/${first}/video` });
    expect((await get(view.url)).body).toBe('0123456789');
    const part = await get(view.url, { range: 'bytes=7-' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['accept-ranges']).toBe('bytes');
    expect(part.body).toBe('789');

    expect((await send('DELETE', `/api/sharing/file/${video.id}`, owner)).json().url).toBeNull();
    expect((await get(`/api/public/${first}`)).statusCode).toBe(404);
    expect((await get(view.url)).statusCode).toBe(404);

    // Shared again, it has a new address; the old one stays dead.
    const second = tokenIn((await send('PUT', `/api/sharing/file/${video.id}`, owner)).json().url);
    expect(second).not.toBe(first);
    expect((await get(`/api/public/${first}`)).statusCode).toBe(404);
    expect((await get(`/api/public/${second}`)).statusCode).toBe(200);
  });

  it('ends with the file', async () => {
    const video = await upload(owner, 'gone.mp4', 'video/mp4', Buffer.from('x'));
    const videoToken = tokenIn((await send('PUT', `/api/sharing/file/${video.id}`, owner)).json().url);
    await send('DELETE', `/api/files/${video.id}`, owner);
    expect((await get(`/api/public/${videoToken}`)).statusCode).toBe(404);

    const id = await makeDeck(await image(owner), `/api/files/${(await upload(owner, 'c.mp4', 'video/mp4', Buffer.from('x'))).id}`, 'text');
    const deckToken = tokenIn((await send('PUT', `/api/sharing/deck/${id}`, owner)).json().url);
    await send('DELETE', `/api/decks/${id}`, owner);
    expect((await get(`/api/public/${deckToken}`)).statusCode).toBe(404);
  });

  it('lets only the owner share, and only presentations and videos', async () => {
    const video = await upload(owner, 'mine.mp4', 'video/mp4', Buffer.from('x'));
    const pdf = await upload(owner, 'report.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n'));
    const binary = await upload(owner, 'a.bin', 'application/octet-stream', Buffer.from('x'));
    const id = await makeDeck(await image(owner), `/api/files/${video.id}`, 'text');

    expect((await get(`/api/sharing/file/${video.id}`)).statusCode).toBe(401);
    expect((await send('PUT', `/api/sharing/file/${video.id}`, other)).statusCode).toBe(404);
    expect((await send('PUT', `/api/sharing/deck/${id}`, other)).statusCode).toBe(404);
    expect((await send('PUT', `/api/sharing/file/${pdf.id}`, owner)).statusCode).toBe(404);
    expect((await send('PUT', `/api/sharing/file/${binary.id}`, owner)).statusCode).toBe(404);
    expect((await send('PUT', `/api/sharing/nonsense/${id}`, owner)).statusCode).toBe(404);
    // A deck's id is not a stored file, nor the other way around.
    expect((await send('PUT', `/api/sharing/file/${id}`, owner)).statusCode).toBe(404);
    expect((await send('PUT', `/api/sharing/deck/${video.id}`, owner)).statusCode).toBe(404);
    // Another user cannot stop the owner's link.
    const token = tokenIn((await send('PUT', `/api/sharing/deck/${id}`, owner)).json().url);
    expect((await send('DELETE', `/api/sharing/deck/${id}`, other)).statusCode).toBe(404);
    expect((await get(`/api/public/${token}`)).statusCode).toBe(200);
  });

  it('turns away a token that is not a link', async () => {
    expect((await get(`/api/public/${'a'.repeat(32)}`)).statusCode).toBe(404);
    expect((await get("/api/public/x' OR 1=1")).statusCode).toBe(404);
  });
});

describe('publicDeck', () => {
  it('leaves a linked table its data and drops its link to the spreadsheet', () => {
    const deck = { version: 1, theme: 'light', slides: [{ id: 's', elements: [{ id: 'e', type: 'table', x: 0, y: 0, w: 1, h: 1, source: { sheetId: 'private' }, rows: [] }] }] };
    const { deck: shown } = publicDeck(deck as never, 't');
    expect(JSON.stringify(shown)).not.toContain('private');
    expect(JSON.stringify(shown)).toContain('rows');
  });
});
