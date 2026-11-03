// PDF to Markdown on Workers (pdf.js, runtime/pdfText.ts), with the fixtures of packages/docs/server/pdfMarkdown.test.ts.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { PdfError, pdfToMarkdown } from './pdfMarkdown.ts';
import { ocrPages, OcrUnavailable, setOcrBinding } from '../runtime/pdfOcr.ts';

const fixture = (name: string) => readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url));

describe('pdfToMarkdown', () => {
  it('reads every page of a text PDF, with its headings', async () => {
    const made = await pdfToMarkdown(fixture('report.pdf'));
    expect(made.pageCount).toBe(2);
    expect(made.ocrPages).toEqual([]);
    expect(made.warnings).toEqual([]);
    expect(made.markdown).toMatch(/^# Quarterly Report\n\nThe office filed every expense on time this quarter, and travel costs fell by 0\.5 percent against the plan\./);
    expect(made.markdown).toContain('## Highlights\n\nRevenue grew in every region, led by the West.');
    expect(made.markdown).toContain('## Next Steps\n\nHire two engineers');
  });

  it('says a scan cannot be read where there is no OCR, rather than making something up', async () => {
    const made = await pdfToMarkdown(fixture('scan.pdf'));
    expect(made.markdown).toBe('');
    expect(made.ocrPages).toEqual([]);
    expect(made.ocrUnavailable).toBe('none');
  });

  it('refuses a locked PDF, a damaged one and anything else', async () => {
    await expect(pdfToMarkdown(fixture('locked.pdf'))).rejects.toThrow(/password-protected/);
    await expect(pdfToMarkdown(Buffer.from('%PDF-1.4 nothing here'))).rejects.toThrow(/could not be read/);
    await expect(pdfToMarkdown(Buffer.from('hello'))).rejects.toThrow(PdfError);
  });
});

/** A PDF_OCR namespace whose container answers with `answer`; the requests it was sent are in `calls`. */
function fakeOcr(answer: (url: URL, body: Uint8Array) => Response | Promise<Response>) {
  const calls: { name: string; url: URL; body: Uint8Array }[] = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (req: Request) => {
        const body = new Uint8Array(await req.arrayBuffer());
        const url = new URL(req.url);
        calls.push({ name: id.name, url, body });
        return answer(url, body);
      },
    }),
  };
  setOcrBinding(ns as never);
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// The bytes changed without changing the PDF, so that the cache of recent conversions does not answer.
const variant = (name: string, n: number) => Buffer.concat([fixture(name), Buffer.from('\n'.repeat(n))]);

describe('pdfToMarkdown with OCR in the container (mocked)', () => {
  afterEach(() => setOcrBinding(null));

  it('sends a scan to the container and keeps what it read', async () => {
    const calls = fakeOcr(() => json({ markdown: '# Scanned Receipt', pages: [{ page: 1, markdown: '# Scanned Receipt\n\nCoffee beans and filters' }], pageCount: 1, ocrPages: [1], warnings: ['Page 1 is a scan and was read with OCR, which can get words wrong.'] }));
    const made = await pdfToMarkdown(variant('scan.pdf', 1));
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/ocr');
    expect(calls[0].url.searchParams.get('pages')).toBe('1');
    expect(calls[0].name).toMatch(/^pdf-ocr-[0-2]$/);
    expect(Buffer.from(calls[0].body.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(made.markdown).toBe('# Scanned Receipt\n\nCoffee beans and filters');
    expect(made.ocrPages).toEqual([1]);
    expect(made.ocrUnavailable).toBeUndefined();
    expect(made.warnings).toEqual(['Page 1 is a scan and was read with OCR, which can get words wrong.']);
  });

  it('reads text pages with pdf.js and sends only the scanned ones', async () => {
    const calls = fakeOcr((url) => json({ pages: url.searchParams.get('pages') === '2' ? [{ page: 2, markdown: 'hire two engineers and open the Denver office.' }] : [], warnings: [] }));
    const made = await pdfToMarkdown(fixture('mixed.pdf'));
    expect(calls.map((c) => c.url.searchParams.get('pages'))).toEqual(['2']);
    expect(made.pageCount).toBe(2);
    expect(made.ocrPages).toEqual([2]);
    expect(made.markdown).toMatch(/^# Quarterly Report\n\nThe office filed every expense/);
    // A paragraph cut by the page break is joined, as for text pages.
    expect(made.markdown).toMatch(/led by the West\.\n\nhire two engineers and open the Denver office\.$/);
  });

  it('says when the container cannot be reached, and tries it again next time', async () => {
    let calls = fakeOcr(() => new Response('There is no Container instance available at this time.', { status: 503 }));
    const bytes = variant('scan.pdf', 2);
    const made = await pdfToMarkdown(bytes);
    expect(made.markdown).toBe('');
    expect(made.ocrUnavailable).toBe('it is busy');
    expect(calls).toHaveLength(1);
    calls = fakeOcr(() => { throw new Error('Network connection lost.'); });
    expect((await pdfToMarkdown(bytes)).ocrUnavailable).toBe('it could not be reached');
    expect(calls).toHaveLength(1);
    calls = fakeOcr(() => new Response('Failed to start container: boom', { status: 500 }));
    const mixed = await pdfToMarkdown(variant('mixed.pdf', 1));
    expect(mixed.ocrUnavailable).toBe('it could not be started');
    expect(mixed.markdown).toMatch(/^# Quarterly Report/);
    expect(mixed.warnings).toEqual(['Page 2 has no text that can be read, so it was left out. If it is a scan, the OCR service could not read it just now: it could not be started. Try again in a minute.']);
  });

  it("passes on the container's refusal of a PDF as a warning", async () => {
    fakeOcr(() => json({ error: 'This PDF could not be read. It may be damaged.' }, 400));
    const made = await pdfToMarkdown(variant('mixed.pdf', 2));
    expect(made.ocrUnavailable).toBeUndefined();
    expect(made.warnings[0]).toBe('The pages with no text could not be read with OCR: This PDF could not be read. It may be damaged.');
  });

  it('gives up on a container that takes too long', async () => {
    fakeOcr(() => new Promise<Response>(() => {}));
    await expect(ocrPages(fixture('scan.pdf'), [1], { timeoutMs: 50 })).rejects.toThrow(OcrUnavailable);
    await expect(ocrPages(fixture('scan.pdf'), [1], { timeoutMs: 50 })).rejects.toThrow('it took too long');
  });
});
