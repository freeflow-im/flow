import JSZip from 'jszip';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openZip, ZipError, zipEntries, zipEntryBytes } from './zipView.ts';

async function zipFile(files: Record<string, string>): Promise<string> {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'zipview-')), 'test.zip');
  writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return file;
}

describe('a zip file’s contents', () => {
  it('lists its files with their sizes, leaving out what the system added', async () => {
    const zip = await openZip(await zipFile({ 'readme.md': '# Hi', 'docs/plan.txt': 'plan', '__MACOSX/docs/._plan.txt': 'x', 'docs/.DS_Store': 'x' }));
    expect(zipEntries(zip).map((e) => [e.path, e.size])).toEqual([
      ['readme.md', 4],
      ['docs/plan.txt', 4],
    ]);
  });

  it('takes out one file, and nothing that is not there', async () => {
    const zip = await openZip(await zipFile({ 'docs/plan.txt': 'the plan' }));
    expect((await zipEntryBytes(zip, 'docs/plan.txt'))?.toString()).toBe('the plan');
    expect(await zipEntryBytes(zip, 'docs/missing.txt')).toBeNull();
    expect(await zipEntryBytes(zip, 'docs/')).toBeNull();
  });

  it('refuses a file larger than the limit', async () => {
    const zip = await openZip(await zipFile({ 'big.txt': 'x'.repeat(5000) }));
    await expect(zipEntryBytes(zip, 'big.txt', 1000)).rejects.toThrow(ZipError);
  });

  it('refuses a file that is not a zip', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'zipview-')), 'fake.zip');
    writeFileSync(file, 'not a zip');
    await expect(openZip(file)).rejects.toThrow(ZipError);
  });
});
