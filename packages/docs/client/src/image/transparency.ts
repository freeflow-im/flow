// Whether an edited picture has see-through parts (a removed background, the corners of a straightened photo).
// A JPEG cannot hold them and shows them black, so such a picture is saved as a PNG instead.

/** True if any part of the picture is transparent. Looked for in a reduced copy, which keeps any area worth keeping. */
export async function hasTransparency(image: Blob): Promise<boolean> {
  const bitmap = await createImageBitmap(image);
  try {
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
    return false;
  } finally {
    bitmap.close();
  }
}

/** "photo.jpg" as a PNG: "photo.png". */
export function pngName(filename: string): string {
  return `${filename.replace(/\.[a-z0-9]+$/i, '')}.png`;
}
