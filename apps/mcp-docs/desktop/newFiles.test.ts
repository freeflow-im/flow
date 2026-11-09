import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kindOf, watchNewFiles } from './newFiles.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Wait until `told` has `n` files (or 5 seconds pass, on a busy machine). */
const until = async (told: () => string[], n: number) => {
  for (const end = Date.now() + 5000; told().length < n && Date.now() < end; ) await wait(50);
};

describe('kindOf', () => {
  it('names the kind by extension, any other name a text file to look at, and never hidden, lock or unfinished files', () => {
    expect(kindOf('Report.docx')).toBe('office');
    expect(kindOf('Q3.XLSX')).toBe('office');
    expect(kindOf('scan.pdf')).toBe('pdf');
    expect(kindOf('notes.md')).toBe('markdown');
    expect(kindOf('Screenshot 2026-10-30.png')).toBe('pictures');
    expect(kindOf('clip.mov')).toBe('videos');
    expect(kindOf('server.log')).toBe('text');
    expect(kindOf('README')).toBe('text');
    expect(kindOf('.DS_Store')).toBe(null);
    expect(kindOf('~$Report.docx')).toBe(null);
    expect(kindOf('scan.pdf.crdownload')).toBe(null);
    expect(kindOf('notes.txt.part')).toBe(null);
    expect(kindOf('Report.docx.123.456.tmp')).toBe(null);
    expect(kindOf('setup.dmg')).toBe(null);
  });
});

describe('watchNewFiles', () => {
  let dir: string;
  let stop: () => void = () => {};
  let told: string[];
  const start = (ignore?: (file: string) => boolean, kinds?: string[]) => {
    told = [];
    stop = watchNewFiles({ dirs: [dir, path.join(dir, 'missing')], kinds, onFile: (f) => told.push(f), ignore, settle: 100, bulk: 100 });
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'newfiles-'));
    writeFileSync(path.join(dir, 'old.docx'), 'old');
  });
  afterEach(() => {
    stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('tells a new file once it settles, and not one that was there', async () => {
    start();
    writeFileSync(path.join(dir, 'old.docx'), 'changed');
    writeFileSync(path.join(dir, 'new.pdf'), 'pdf');
    await until(() => told, 1);
    await wait(300);
    expect(told).toEqual([path.join(dir, 'new.pdf')]);
  });

  it('tells a download when it is renamed to its own name, not while it is written', async () => {
    start();
    writeFileSync(path.join(dir, 'big.pdf.crdownload'), 'part');
    await wait(400);
    expect(told).toEqual([]);
    renameSync(path.join(dir, 'big.pdf.crdownload'), path.join(dir, 'big.pdf'));
    await until(() => told, 1);
    expect(told).toEqual([path.join(dir, 'big.pdf')]);
  });

  it('leaves out the files it is told to ignore, folders and copies of several files', async () => {
    start((f) => f.endsWith('mine.docx'));
    writeFileSync(path.join(dir, 'mine.docx'), 'the app wrote it');
    mkdirSync(path.join(dir, 'unzipped.md'));
    await wait(600);
    writeFileSync(path.join(dir, 'a.csv'), 'a');
    writeFileSync(path.join(dir, 'b.csv'), 'b');
    await wait(600);
    expect(told).toEqual([]);
  });

  it('tells a text file of any name by its bytes, and only the kinds asked for', async () => {
    start();
    writeFileSync(path.join(dir, 'data.bin'), Buffer.from([0, 1, 2, 3]));
    await wait(500);
    writeFileSync(path.join(dir, 'server.log'), 'started\n');
    await until(() => told, 1);
    expect(told).toEqual([path.join(dir, 'server.log')]);
    stop();
    start(undefined, ['pictures']);
    writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    await wait(500);
    writeFileSync(path.join(dir, 'shot.png'), 'png');
    await until(() => told, 1);
    expect(told).toEqual([path.join(dir, 'shot.png')]);
  });
});
