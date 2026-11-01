// A picture's size in pixels, read from the start of its bytes (PNG, JPEG, GIF and WebP). The server has no
// image library; this is enough to tell the assistant what positions in a picture can be.

export function imageSize(data: Buffer): { width: number; height: number } | null {
  try {
    const size = png(data) ?? gif(data) ?? webp(data) ?? jpeg(data);
    return size && size.width > 0 && size.height > 0 ? size : null;
  } catch {
    // Cut short or malformed: not a picture whose size can be told.
    return null;
  }
}

function png(d: Buffer) {
  if (d.length < 24 || d.readUInt32BE(0) !== 0x89504e47 || d.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: d.readUInt32BE(16), height: d.readUInt32BE(20) };
}

function gif(d: Buffer) {
  if (d.length < 10 || d.toString('latin1', 0, 4) !== 'GIF8') return null;
  return { width: d.readUInt16LE(6), height: d.readUInt16LE(8) };
}

function webp(d: Buffer) {
  if (d.length < 30 || d.toString('latin1', 0, 4) !== 'RIFF' || d.toString('latin1', 8, 12) !== 'WEBP') return null;
  const kind = d.toString('latin1', 12, 16);
  if (kind === 'VP8X') return { width: 1 + d.readUIntLE(24, 3), height: 1 + d.readUIntLE(27, 3) };
  if (kind === 'VP8 ') return { width: d.readUInt16LE(26) & 0x3fff, height: d.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') {
    const bits = d.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

/** A JPEG's size is in its frame header, after whatever segments (EXIF, thumbnails) come first. */
function jpeg(d: Buffer) {
  if (d.length < 4 || d[0] !== 0xff || d[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < d.length) {
    if (d[i] !== 0xff) return null;
    const marker = d[i + 1];
    // Padding, and markers that stand alone.
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = d.readUInt16BE(i + 2);
    // Start of frame, of any kind but the tables that share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: d.readUInt16BE(i + 7), height: d.readUInt16BE(i + 5) };
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}
