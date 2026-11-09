import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closePdfReaders, pdfToMarkdown } from './pdfMarkdown.ts';

// Its own file (so its own process): the reading workers inherit this environment. An empty model directory and
// a proxy that refuses every connection stand for a machine where Tesseract's model is missing and cannot be
// fetched.
const tessdata = mkdtempSync(path.join(tmpdir(), 'sheetsweb-tessdata-'));
process.env.TESSDATA_PREFIX = tessdata;
for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) process.env[name] = 'http://127.0.0.1:9';
for (const name of ['NO_PROXY', 'no_proxy']) delete process.env[name];

describe('pdfToMarkdown without the OCR model', () => {
  afterAll(async () => {
    await closePdfReaders();
    rmSync(tessdata, { recursive: true, force: true });
  });

  it('says a scanned page could not be read, and why', async () => {
    const made = await pdfToMarkdown(readFileSync(path.join(import.meta.dirname, 'fixtures', 'scan.pdf')));
    expect(made.ocrPages).toEqual([]);
    expect(made.warnings).toEqual(['Page 1 is a scan and could not be read: the OCR model is unavailable.']);
  }, 60_000);
});
