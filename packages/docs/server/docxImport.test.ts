import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { docNode } from '../shared/doc.ts';
import { docToMarkdown } from '../shared/docMarkdown.ts';
import { importDocx, isDocx } from './docxImport.ts';
import { buildDocx } from './testing.ts';

const p = (inner: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
const r = (text: string, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const style = (id: string) => `<w:pStyle w:val="${id}"/>`;
const list = (numId: number, ilvl = 0) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;

const sink = async (type: string, data: Buffer) => `/api/images/00000000-0000-0000-0000-00000000000${data.length > 0 && type === 'image/png' ? 1 : 2}`;

describe('docx import', () => {
  it('keeps styles, lists, run formatting, links, breaks and pictures', async () => {
    const body = [
      p(r('Annual report'), style('Title')),
      p(r('Fiscal 2026'), style('Subtitle')),
      p(r('Overview'), style('Heading1')),
      p(r('Deep'), style('Heading4')),
      p(`${r('Plain, ')}${r('bold', '<w:b/>')}${r(', ')}${r('italic', '<w:i/>')}${r(', ')}${r('under', '<w:u w:val="single"/>')}${r(', ')}${r('gone', '<w:strike/>')}${r(', ')}${r('red', '<w:color w:val="C00000"/>')}${r(', ')}${r('marked', '<w:highlight w:val="yellow"/>')}${r(', ')}${r('big serif', '<w:rFonts w:ascii="Georgia"/><w:sz w:val="28"/>')}${r(' and ')}${r('strong', '<w:rStyle w:val="Strong"/>')}${r('.')}`),
      p(`${r('See ')}<w:hyperlink r:id="rId5">${r('the site', '<w:u w:val="single"/>')}</w:hyperlink>${r(' now.')}`, '<w:jc w:val="center"/>'),
      p(`${r('line one')}<w:r><w:br/></w:r>${r('line two')}`),
      p(r('one'), `${style('ListParagraph')}${list(1)}`),
      p(r('nested'), `${style('ListParagraph')}${list(1, 1)}`),
      p(r('two'), `${style('ListParagraph')}${list(1)}`),
      p(r('first'), `${style('ListParagraph')}${list(2)}`),
      p(r('second'), `${style('ListParagraph')}${list(2)}`),
      p(r('Wise words'), style('Quote')),
      p(`<w:r><w:drawing><wp:inline><wp:extent cx="1905000" cy="952500"/><wp:docPr id="1" name="Picture 1" descr="A chart"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId7"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`),
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      '<w:sectPr/>',
    ].join('');
    const { doc, warnings } = await importDocx(await buildDocx(body), sink);
    const node = docNode(doc);
    expect(node.content.childCount).toBe(12);
    expect(docToMarkdown(node)).toBe(
      [
        '# <span style="font-size: 28pt">Annual report</span> {.title}',
        '## Fiscal 2026 {.subtitle}',
        '# **Overview**',
        '### Deep',
        'Plain, **bold**, *italic*, <u>under</u>, ~~gone~~, <span style="color: #c00000">red</span>, <span style="background-color: #ffff00">marked</span>, <span style="font-family: Georgia, serif"><span style="font-size: 14pt">big serif</span></span> and **strong**.',
        'See [the site](https://biztrip.ai/) now.',
        'line one\nline two',
        '- one\n  - nested\n- two',
        '1. first\n2. second',
        '> Wise words',
        '![A chart](/api/images/00000000-0000-0000-0000-000000000001)',
        'A1\tB1',
      ].join('\n\n'),
    );
    expect(node.child(5).attrs.align).toBe('center');
    // Document defaults from docDefaults: Calibri 11, single spacing, no space after.
    expect(node.attrs.style).toEqual({ font: 'Calibri', size: 11, lineHeight: 1.15, spaceAfter: 0 });
    expect(node.child(10).attrs.width).toBe(200);
    expect(warnings).toEqual(['Headers and footers were dropped.', 'Tables were converted to paragraphs (one per row, cells separated by tabs).']);
  });

  it('skips marks equal to the document defaults, drops link colors, and survives text inside drawings', async () => {
    const body = [
      p(`${r('Calibri eleven', '<w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/>')}${r(' and ')}${r('Arial twelve', '<w:rFonts w:ascii="Arial"/><w:sz w:val="24"/>')}`),
      p(`<w:hyperlink r:id="rId5">${r('blue link', '<w:color w:val="1155CC"/>')}</w:hyperlink>`),
      p(`<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="2" name="Picture 2"/><a:graphic><a:graphicData><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="x.png"/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId7"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`),
    ].join('');
    const { doc } = await importDocx(await buildDocx(body), sink);
    expect(docToMarkdown(docNode(doc))).toBe(
      'Calibri eleven and <span style="font-family: Arial, sans-serif"><span style="font-size: 12pt">Arial twelve</span></span>\n\n[blue link](https://biztrip.ai/)\n\n![](/api/images/00000000-0000-0000-0000-000000000001)',
    );
  });

  it('keeps page breaks and reads the page size, orientation and margins', async () => {
    const body = [
      p(`${r('first page')}<w:r><w:br w:type="page"/></w:r>`),
      p(r('second page')),
      '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720" w:right="1440" w:bottom="720" w:left="1440"/></w:sectPr>',
    ].join('');
    const { doc } = await importDocx(await buildDocx(body), sink);
    const node = docNode(doc);
    expect(docToMarkdown(node)).toBe('first page\n\n\\newpage\n\nsecond page');
    expect(node.attrs.page).toEqual({ size: 'a4', orientation: 'landscape', margins: { top: 0.5, right: 1, bottom: 0.5, left: 1 } });
    const plain = await importDocx(await buildDocx(p(r('x'))), sink);
    expect(docNode(plain.doc).attrs.page).toBeNull();
  });

  it('rejects files that are not Word documents and handles empty ones', async () => {
    await expect(importDocx(Buffer.from('garbage'), sink)).rejects.toThrow(/not a valid Word document/);
    expect(await isDocx(Buffer.from('garbage'))).toBe(false);
    const zip = new JSZip();
    zip.file('ppt/presentation.xml', '<p/>');
    const pptx = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(await isDocx(pptx)).toBe(false);
    await expect(importDocx(pptx, sink)).rejects.toThrow(/not a valid Word document/);
    const empty = await buildDocx('<w:sectPr/>');
    expect(await isDocx(empty)).toBe(true);
    const { doc } = await importDocx(empty, sink);
    expect(doc.content.content).toHaveLength(1);
    expect(doc.content.content![0].type).toBe('paragraph');
  });
});
