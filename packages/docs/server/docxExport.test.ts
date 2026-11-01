import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { docNode, docStyleOf, pageSetupOf, validateDoc, type Doc, type DocJSON } from '../shared/doc.ts';
import { docxProblem } from '../shared/docxFormat.ts';
import { docDocx, imageSize } from './docxExport.ts';
import { importDocx } from './docxImport.ts';
import { buildDocx } from './testing.ts';

/** The header of a PNG of the given size: all the writer and importer look at. */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
const IMG = (n: number) => `/api/images/00000000-0000-0000-0000-00000000000${n}`;
const pictures = new Map<string, Buffer>([
  [IMG(1), png(400, 200)],
  [IMG(2), png(1200, 600)],
]);
const load = async (src: string) => (pictures.has(src) ? { type: 'image/png', data: pictures.get(src)! } : null);
/** Stores a picture under the address it was written from (found by its bytes). */
const sink = async (_type: string, data: Buffer) => [...pictures].find(([, b]) => b.equals(data))![0];

const t = (text: string, ...marks: { type: string; attrs?: Record<string, unknown> }[]): DocJSON => ({ type: 'text', text, ...(marks.length ? { marks } : {}) });
const b = (type: string, content: DocJSON[] = [], attrs?: Record<string, unknown>): DocJSON => ({ type, ...(attrs ? { attrs } : {}), ...(content.length ? { content } : {}) });
const p = (...content: DocJSON[]) => b('paragraph', content);
const doc = (content: DocJSON[], attrs?: Record<string, unknown>): Doc => ({ version: 1, content: { type: 'doc', ...(attrs ? { attrs } : {}), content } });

/** Write the document and read it back; the content of both as ProseMirror JSON with every attribute filled in. */
async function roundTrip(d: Doc) {
  expect(validateDoc(d)).toBeNull();
  const back = await importDocx(await docDocx(d, 'Test', load), sink);
  return { before: docNode(d), after: docNode(back.doc), warnings: back.warnings };
}
const content = (n: ReturnType<typeof docNode>) => n.toJSON().content;

describe('docx export', () => {
  it('round-trips block styles, marks, links, breaks, rules, quotes and code', async () => {
    const d = doc([
      b('title', [t('Annual report')], { align: 'center' }),
      b('subtitle', [t('Fiscal 2026')]),
      b('heading', [t('Overview')], { level: 1 }),
      b('heading', [t('Details')], { level: 2 }),
      b('heading', [t('Fine print')], { level: 3 }),
      p(
        t('Plain, '),
        t('bold', { type: 'bold' }),
        t(', '),
        t('italic', { type: 'italic' }),
        t(', '),
        t('under', { type: 'underline' }),
        t(', '),
        t('gone', { type: 'strike' }),
        t(', '),
        t('red', { type: 'color', attrs: { color: '#c00000' } }),
        t(', '),
        t('marked', { type: 'highlight', attrs: { color: '#fff2cc' } }),
        t(', '),
        t('serif', { type: 'font', attrs: { family: 'Georgia' } }),
        t(', '),
        t('big', { type: 'size', attrs: { size: 18 } }),
        t(', '),
        t('x = 1', { type: 'code' }),
        t(', '),
        t('the site', { type: 'link', attrs: { href: 'https://biztrip.ai/' } }),
        t(' and '),
        t('strong link', { type: 'link', attrs: { href: 'https://biztrip.ai/' } }, { type: 'bold' }),
        t(' a\tb'),
        { type: 'hard_break' },
        t('after the break'),
      ),
      b('paragraph', [t('Right, spaced')], { align: 'right', spacing: { before: 6, after: 12, line: 2 } }),
      b('paragraph', [t('Justified')], { align: 'justify' }),
      b('blockquote', [p(t('Wise words')), p(t('said twice'))]),
      b('code_block', [t('const a = 1;\n\tb();')]),
      b('horizontal_rule'),
      b('page_break'),
      p(t('The end')),
      p(),
    ]);
    const { before, after, warnings } = await roundTrip(d);
    expect(content(after)).toEqual(content(before));
    expect(warnings).toEqual([]);
  });

  it('round-trips lists: kinds, nesting, starts, and lists side by side', async () => {
    const d = doc([
      b('bullet_list', [b('list_item', [p(t('one')), b('ordered_list', [b('list_item', [p(t('three'))]), b('list_item', [p(t('four'))])], { start: 3 })]), b('list_item', [p(t('two'))])]),
      b('bullet_list', [b('list_item', [p(t('another list'))])]),
      b('ordered_list', [b('list_item', [p(t('five'))]), b('list_item', [p(t('six'))])], { start: 5 }),
      p(t('after')),
    ]);
    const { before, after, warnings } = await roundTrip(d);
    expect(content(after)).toEqual(content(before));
    expect(warnings).toEqual([]);
  });

  it('embeds pictures with their width, alignment and description, sized from the picture when they have no width', async () => {
    const d = doc([
      b('image', [], { src: IMG(1), alt: 'A chart', width: 300, align: 'center' }),
      b('image', [], { src: IMG(2), alt: '', width: null, align: 'right' }),
      // Not loadable: left out.
      b('image', [], { src: IMG(9), alt: '', width: 200, align: null }),
      b('image', [], { src: IMG(1), alt: 'Again', width: 120, align: null }),
    ]);
    const { after, warnings } = await roundTrip(d);
    expect(content(after)).toEqual([
      { type: 'image', attrs: { src: IMG(1), alt: 'A chart', width: 300, align: 'center' } },
      // Its own size, as wide as the page at most.
      { type: 'image', attrs: { src: IMG(2), alt: '', width: 760, align: 'right' } },
      { type: 'image', attrs: { src: IMG(1), alt: 'Again', width: 120, align: null } },
    ]);
    expect(warnings).toEqual([]);
    // The same picture twice is in the file once.
    const zip = await JSZip.loadAsync(await docDocx(d, 'Test', load));
    expect(zip.file(/^word\/media\/./)).toHaveLength(2);
  });

  it('keeps a picture in its line of text (a signature on a form), and the same picture as a block too', async () => {
    const sig = { type: 'inline_image', attrs: { src: IMG(1), alt: 'Signature', width: 88 } };
    const d = doc([p(t('Signed '), sig, t(' Name')), b('image', [], { src: IMG(1), alt: '', width: 120, align: null }), p(t('Date '), t('Oct 27, 2026', { type: 'bold' }))]);
    const { after, warnings } = await roundTrip(d);
    expect(content(after)).toEqual([
      { type: 'paragraph', attrs: { align: null, spacing: null }, content: [{ type: 'text', text: 'Signed ' }, sig, { type: 'text', text: ' Name' }] },
      { type: 'image', attrs: { src: IMG(1), alt: '', width: 120, align: null } },
      { type: 'paragraph', attrs: { align: null, spacing: null }, content: [{ type: 'text', text: 'Date ' }, { type: 'text', text: 'Oct 27, 2026', marks: [{ type: 'bold' }] }] },
    ]);
    expect(warnings).toEqual([]);
    const xml = await (await JSZip.loadAsync(await docDocx(d, 'Test', load))).file('word/document.xml')!.async('string');
    // In the paragraph's own runs, between its text.
    expect(xml).toMatch(/Signed <\/w:t><\/w:r><w:r><w:drawing><wp:inline [^]*?<\/w:drawing><\/w:r><w:r><w:t xml:space="preserve"> Name/);
  });

  it('round-trips the page setup, header, footer, page numbers and the document style', async () => {
    const style = { font: 'Georgia', size: 11, lineHeight: 1.4, spaceAfter: 6 };
    for (const page of [
      { mode: 'pageless', size: 'a4', orientation: 'landscape', margins: { top: 0.5, right: 0.75, bottom: 1.25, left: 1 }, pageNumbers: 'bottom-right', header: 'Draft, page {page} of {pages}', footer: 'Confidential' },
      { mode: 'pages', size: 'legal', orientation: 'portrait', margins: { top: 1, right: 1, bottom: 1, left: 1 }, pageNumbers: 'top-right', header: '', footer: '' },
      { mode: 'pages', size: 'letter', orientation: 'portrait', margins: { top: 1, right: 1, bottom: 1, left: 1 }, pageNumbers: 'bottom-center', header: 'Only a header', footer: '' },
    ]) {
      const { before, after, warnings } = await roundTrip(doc([p(t('Body'))], { page, style }));
      expect(pageSetupOf(after)).toEqual(pageSetupOf(before));
      expect(docStyleOf(after)).toEqual(style);
      expect(content(after)).toEqual(content(before));
      expect(warnings).toEqual([]);
    }
  });

  it('writes a video as a link to it, and says a Word file cannot hold one', async () => {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const d = doc([b('video', [], { src: url, title: 'Launch film', width: null, align: null })]);
    expect(docxProblem(d)).toBe('Videos');
    expect(docxProblem(doc([p(t('no video'))]))).toBeNull();
    const { after } = await roundTrip(d);
    expect(content(after)).toEqual([{ type: 'paragraph', attrs: { align: null, spacing: null }, content: [{ type: 'text', text: 'Launch film', marks: [{ type: 'link', attrs: { href: url } }] }] }]);
  });

  it('reads the size of PNG, GIF, JPEG and WebP pictures from their headers', () => {
    expect(imageSize(png(640, 480))).toEqual({ width: 640, height: 480 });
    const gif = Buffer.from('GIF89a\x20\x00\x10\x00', 'latin1');
    expect(imageSize(gif)).toEqual({ width: 32, height: 16 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x78, 0x00, 0xa0, 0x03]);
    expect(imageSize(jpeg)).toEqual({ width: 160, height: 120 });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBPVP8X', 8, 'latin1');
    webp.writeUIntLE(99, 24, 3);
    webp.writeUIntLE(49, 27, 3);
    expect(imageSize(webp)).toEqual({ width: 100, height: 50 });
    expect(imageSize(Buffer.from('nope'))).toBeNull();
  });
});

describe('docx import of headers and footers', () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  async function withHeader(header: string) {
    const zip = await JSZip.loadAsync(await buildDocx('<w:p><w:r><w:t>Body</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="rId9"/></w:sectPr>'));
    zip.file('word/header1.xml', `<?xml version="1.0"?><w:hdr ${W}>${header}</w:hdr>`);
    return importDocx(Buffer.from(await zip.generateAsync({ type: 'nodebuffer' })), sink);
  }

  it('reads plain text and a page number field (simple or complex) into the page setup', async () => {
    const field = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
    const { doc, warnings } = await withHeader(`<w:p><w:r><w:t>Acme Corp</w:t></w:r></w:p><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${field}</w:p>`);
    expect(warnings).toEqual([]);
    const page = pageSetupOf(docNode(doc));
    expect([page.header, page.pageNumbers]).toEqual(['Acme Corp', 'top-right']);
  });

  it('still drops a header that holds more than text and page numbers', async () => {
    const { doc, warnings } = await withHeader('<w:p><w:r><w:drawing/></w:r><w:r><w:t>Logo</w:t></w:r></w:p>');
    expect(warnings).toContain('Headers and footers were dropped.');
    expect(pageSetupOf(docNode(doc)).header).toBe('');
    const other = await withHeader('<w:p><w:fldSimple w:instr=" DATE "><w:r><w:t>today</w:t></w:r></w:fldSimple></w:p>');
    expect(other.warnings).toContain('Headers and footers were dropped.');
  });
});
