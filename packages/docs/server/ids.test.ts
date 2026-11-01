import { describe, expect, it } from 'vitest';
import { isFileId, newFileId } from './ids.ts';

describe('file ids', () => {
  it('makes short ids of lowercase letters and digits', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newFileId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{12}$/);
  });

  it('draws again when an id is taken', () => {
    const seen: string[] = [];
    const id = newFileId((candidate) => seen.push(candidate) < 3);
    expect(seen).toHaveLength(3);
    expect(id).toBe(seen[2]);
  });

  it('accepts new ids and the UUIDs of older files, and nothing else', () => {
    expect(isFileId(newFileId())).toBe(true);
    expect(isFileId('d9ef81a9-1d48-4f0f-b26f-0c9a8a0f3242')).toBe(true);
    for (const bad of ['', 'short', 'K3VQ9XT2MBZ7', '../../etc/pw', 'k3vq9xt2mbz7x', 12, null]) expect(isFileId(bad)).toBe(false);
  });
});
