// Public picture links (avatarLinks.ts): a kept picture gets a signed link only its signature opens; a preset gets the
// suite's origin; an outside https address stays; anything else has none.
import { describe, expect, it } from 'vitest';
import { checkAvatarSignature, publicPictureUrl } from './avatarLinks';

const SECRET = 'c2VjcmV0LWtleS1mb3ItdGVzdHMtb25seS0xMjM0NTY=';
const KEY = '01a206fd-d420-76f5-824a-c1ebb91132a1-1795412000000.png';
const at = { origin: 'https://app.freeflow.im', secret: SECRET };

describe('public picture links', () => {
  it('signs a kept picture, and only that signature with that secret opens it', () => {
    const url = publicPictureUrl(`/v1/avatars/${KEY}`, at)!;
    expect(url).toMatch(new RegExp(`^https://app\\.freeflow\\.im/v1/public/avatars/${KEY}\\?s=[A-Za-z0-9_-]{43}$`));
    const sig = new URL(url).searchParams.get('s')!;
    expect(checkAvatarSignature(SECRET, KEY, sig)).toBe(true);
    expect(checkAvatarSignature('another-secret', KEY, sig)).toBe(false);
    expect(checkAvatarSignature(SECRET, KEY.replace('.png', '.gif'), sig)).toBe(false);
    expect(checkAvatarSignature(SECRET, KEY, `${sig.slice(0, -1)}A`)).toBe(false);
    expect(checkAvatarSignature(SECRET, KEY, undefined)).toBe(false);
    expect(checkAvatarSignature(undefined, KEY, sig)).toBe(false);
    expect(checkAvatarSignature(SECRET, '../secret', sig)).toBe(false);
  });

  it('gives a preset the origin, keeps an outside https address, and has none otherwise', () => {
    expect(publicPictureUrl('/agent-avatars/mint.svg', at)).toBe('https://app.freeflow.im/agent-avatars/mint.svg');
    expect(publicPictureUrl('https://lh3.googleusercontent.com/a/x', at)).toBe('https://lh3.googleusercontent.com/a/x');
    expect(publicPictureUrl(null, at)).toBeNull();
    expect(publicPictureUrl('/v1/files/other', at)).toBeNull();
    expect(publicPictureUrl('http://insecure.test/x.png', at)).toBeNull();
    expect(publicPictureUrl(`/v1/avatars/${KEY}`, { ...at, secret: undefined })).toBeNull();
    expect(publicPictureUrl('/agent-avatars/mint.svg', { origin: 'not a url', secret: SECRET })).toBeNull();
  });
});
