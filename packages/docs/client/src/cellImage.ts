// Helpers for putting an uploaded or pasted image file into a cell.
import { CELL_IMAGE_TOO_LARGE, CELL_IMAGE_TYPES, MAX_CELL_IMAGE_BYTES } from '../../shared/types.ts';
import { api } from './api.ts';

/** Open the browser's file picker for an image; resolves to null if the user cancels. */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = CELL_IMAGE_TYPES.join(',');
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * Store an image file on the server and resolve to its URL for a cell, rejecting unsupported types and images
 * over the size limit. The file is sent as is (no base64 encoding), so large images don't block the page.
 */
export async function uploadImageFile(file: Blob, upload: (file: Blob) => Promise<string> = api.uploadImage): Promise<string> {
  if (!CELL_IMAGE_TYPES.includes(file.type)) throw new Error('Please choose a PNG, JPEG, GIF or WebP image.');
  if (file.size > MAX_CELL_IMAGE_BYTES) throw new Error(`${CELL_IMAGE_TOO_LARGE}.`);
  return upload(file);
}

/** The first image file in a clipboard paste, if any. */
export function clipboardImage(data: DataTransfer): File | null {
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && CELL_IMAGE_TYPES.includes(item.type)) return item.getAsFile();
  }
  return null;
}
