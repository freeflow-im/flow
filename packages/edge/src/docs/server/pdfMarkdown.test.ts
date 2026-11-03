// PDF to Markdown on Workers (pdf.js, runtime/pdfText.ts), with the fixtures of packages/docs/server/pdfMarkdown.test.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PdfError, pdfToMarkdown } from './pdfMarkdown.ts';

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

  it('says a scan cannot be read here, rather than making something up', async () => {
    const made = await pdfToMarkdown(fixture('scan.pdf'));
    expect(made.markdown).toBe('');
    expect(made.ocrPages).toEqual([]);
  });

  it('refuses a locked PDF, a damaged one and anything else', async () => {
    await expect(pdfToMarkdown(fixture('locked.pdf'))).rejects.toThrow(/password-protected/);
    await expect(pdfToMarkdown(Buffer.from('%PDF-1.4 nothing here'))).rejects.toThrow(/could not be read/);
    await expect(pdfToMarkdown(Buffer.from('hello'))).rejects.toThrow(PdfError);
  });
});
