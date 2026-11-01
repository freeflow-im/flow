import { describe, expect, it } from 'vitest';
import { imageSize } from './imageSize.ts';

const u16be = (n: number) => [n >> 8, n & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const ascii = (s: string) => [...Buffer.from(s, 'latin1')];

describe('picture size from its bytes', () => {
  it('reads a PNG', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...ascii('IHDR'), ...u32be(3000), ...u32be(2000), 8, 6, 0, 0, 0]);
    expect(imageSize(png)).toEqual({ width: 3000, height: 2000 });
    expect(imageSize(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))).toEqual({ width: 1, height: 1 });
  });

  it('reads a JPEG, past the segments before its frame header', () => {
    const app1 = [0xff, 0xe1, ...u16be(10), ...ascii('Exif'), 0, 0, 0, 0];
    const dqt = [0xff, 0xdb, ...u16be(4), 0, 0];
    const sof = (marker: number) => [0xff, marker, ...u16be(11), 8, ...u16be(1200), ...u16be(1600), 3, 0, 0, 0];
    expect(imageSize(Buffer.from([0xff, 0xd8, ...app1, ...dqt, ...sof(0xc0), 0, 0, 0, 0]))).toEqual({ width: 1600, height: 1200 });
    // A progressive one, and one with a Huffman table (which is not a frame) first.
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xc4, ...u16be(4), 0, 0, ...sof(0xc2), 0, 0, 0, 0]))).toEqual({ width: 1600, height: 1200 });
  });

  it('reads a GIF and the three kinds of WebP', () => {
    expect(imageSize(Buffer.from([...ascii('GIF89a'), 0x40, 0x01, 0xf0, 0x00, 0, 0]))).toEqual({ width: 320, height: 240 });
    const riff = (kind: string, body: number[]) => Buffer.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii(kind), 0, 0, 0, 0, ...body, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageSize(riff('VP8X', [0, 0, 0, 0, ...u24le(799), ...u24le(599)]))).toEqual({ width: 800, height: 600 });
    expect(imageSize(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x20, 0x03, 0x58, 0x02]))).toEqual({ width: 800, height: 600 });
    const bits = 799 | (599 << 14);
    expect(imageSize(riff('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]))).toEqual({ width: 800, height: 600 });
  });

  it('says nothing of what is not a picture, or is cut short', () => {
    expect(imageSize(Buffer.from('%PDF-1.7 not a picture at all'))).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBeNull();
    expect(imageSize(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(imageSize(Buffer.alloc(0))).toBeNull();
  });
});
