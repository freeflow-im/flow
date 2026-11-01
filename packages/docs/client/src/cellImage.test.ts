import { describe, expect, it } from 'vitest';
import { MAX_CELL_IMAGE_BYTES } from '../../shared/types.ts';
import { uploadImageFile } from './cellImage.ts';

describe('uploadImageFile', () => {
  const upload = async () => '/api/images/0b5d3b9e-7f6a-4c1e-9d2a-3f4e5a6b7c8d';
  // Only type and size are looked at before uploading, so large files can be faked.
  const file = (type: string, size: number) => ({ type, size }) as Blob;

  it('uploads images up to 100 MB and returns their URL', async () => {
    await expect(uploadImageFile(file('image/png', 50 * 1024 * 1024), upload)).resolves.toMatch(/^\/api\/images\//);
    await expect(uploadImageFile(file('image/jpeg', MAX_CELL_IMAGE_BYTES), upload)).resolves.toMatch(/^\/api\/images\//);
  });

  it('refuses larger images and unsupported types', async () => {
    await expect(uploadImageFile(file('image/png', MAX_CELL_IMAGE_BYTES + 1), upload)).rejects.toThrow('Image is too large (100 MB maximum).');
    await expect(uploadImageFile(file('image/svg+xml', 10), upload)).rejects.toThrow(/PNG, JPEG, GIF or WebP/);
  });
});
