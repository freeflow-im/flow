import { describe, expect, it } from 'vitest';
import { docNode, docSchema, docText, newDoc, validateDoc } from './doc.ts';
import { docToMarkdown, inlineToMarkdown, markdownToDoc, markdownToNodes } from './docMarkdown.ts';

const roundTrip = (md: string) => docToMarkdown(docNode(markdownToDoc(md)));

describe('document markdown', () => {
  it('parses headings, paragraphs, lists, quotes, code, rules and images', () => {
    const md = [
      '# Title',
      '',
      'A paragraph with **bold**, *italic*, ~~gone~~, `code`, <u>under</u> and a [link](https://x.com/a).',
      'Second line of the same paragraph.',
      '',
      '- one',
      '- two',
      '  - nested',
      '    - deeper',
      '- three',
      '',
      '1. first',
      '2. second',
      '',
      '> quoted',
      '> more',
      '',
      '```',
      'let x = 1;',
      '```',
      '',
      '---',
      '',
      '![A picture](/api/images/00000000-0000-0000-0000-000000000001)',
    ].join('\n');
    const nodes = markdownToNodes(md);
    expect(nodes.map((n) => n.type.name)).toEqual(['heading', 'paragraph', 'bullet_list', 'ordered_list', 'blockquote', 'code_block', 'horizontal_rule', 'image']);
    const para = nodes[1];
    expect(para.childCount).toBeGreaterThan(5);
    expect(para.child(1).marks.map((m) => m.type.name)).toEqual(['bold']);
    expect(para.textContent).toContain('and a link.');
    const link = [...Array(para.childCount).keys()].map((k) => para.child(k)).find((n) => n.marks.some((m) => m.type.name === 'link'))!;
    expect(link.text).toBe('link');
    expect(link.marks[0].attrs.href).toBe('https://x.com/a');
    expect(docText(docSchema.nodes.doc.create(null, [para]))).toBe('A paragraph with bold, italic, gone, code, under and a link.\nSecond line of the same paragraph.');
    const list = nodes[2];
    expect(list.childCount).toBe(3);
    expect(list.child(1).child(1).type.name).toBe('bullet_list');
    expect(list.child(1).child(1).child(0).child(1).type.name).toBe('bullet_list');
    expect(nodes[3].child(0).textContent).toBe('first');
    expect(docText(nodes[4])).toBe('quoted\nmore');
    expect(nodes[5].textContent).toBe('let x = 1;');
    expect(nodes[7].attrs).toMatchObject({ src: '/api/images/00000000-0000-0000-0000-000000000001', alt: 'A picture' });
    expect(roundTrip(md)).toBe(md);
  });

  it('round-trips marks that overlap, colors and escaped characters', () => {
    const cases = [
      '**bold *and italic* still bold**',
      '*italic **and bold** still italic*',
      'Some <span style="color: #c00">red</span> and <span style="background-color: #ff0">marked</span> text',
      'Keep 2 \\* 3 and snake_case_names and a_b literal',
      'A line ending in a break\nnext line',
      '\\# not a heading',
      '\\- not a list',
      '`code with **stars**`',
    ];
    for (const c of cases) expect(roundTrip(c)).toBe(c);
    const n = markdownToNodes('**bold *and italic* still bold**')[0];
    expect(n.child(1).marks.map((m) => m.type.name).sort()).toEqual(['bold', 'italic']);
    expect(n.textContent).toBe('bold and italic still bold');
    expect(markdownToNodes('snake_case_names')[0].textContent).toBe('snake_case_names');
    expect(markdownToNodes('2 * 3 * 4')[0].textContent).toBe('2 * 3 * 4');
  });

  it('round-trips the title, subtitle, fonts and sizes, including nested spans', () => {
    const md = '# Annual report {.title}\n\n## Fiscal 2026 {.subtitle}\n\nBody in <span style="font-family: Georgia, serif">Georgia</span> at <span style="font-size: 14pt">fourteen</span> points.';
    const nodes = markdownToNodes(md);
    expect(nodes.map((n) => n.type.name)).toEqual(['title', 'subtitle', 'paragraph']);
    expect(markdownToNodes('one\n\n\\newpage\n\ntwo').map((n) => n.type.name)).toEqual(['paragraph', 'page_break', 'paragraph']);
    expect(roundTrip('one\n\n\\newpage\n\ntwo')).toBe('one\n\n\\newpage\n\ntwo');
    expect(nodes[2].child(1).marks[0].attrs).toEqual({ family: 'Georgia' });
    expect(nodes[2].child(3).marks[0].attrs).toEqual({ size: 14 });
    expect(roundTrip(md)).toBe(md);
    // A closing span only removes what its own span added.
    const p = markdownToNodes('<span style="color: #c00"><span style="font-size: 18px">big</span> red</span>')[0];
    expect(p.child(0).marks.map((m) => m.type.name).sort()).toEqual(['color', 'size']);
    expect(p.child(0).marks.find((m) => m.type.name === 'size')!.attrs.size).toBe(13.5);
    expect(p.child(1).marks.map((m) => m.type.name)).toEqual(['color']);
    expect(validateDoc(markdownToDoc(md))).toBeNull();
    expect(validateDoc({ version: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'size', attrs: { size: 1000 } }] }] }] } })).toBe('Invalid font size');
  });

  it('keeps whitespace outside delimiters when serializing', () => {
    const p = docSchema.nodes.paragraph.create(null, [docSchema.text('a '), docSchema.text(' b ', [docSchema.marks.bold.create()]), docSchema.text(' c')]);
    expect(inlineToMarkdown(p)).toBe('a  **b**  c');
  });

  it('reads and writes a video as a picture whose address is a video', () => {
    const doc = markdownToDoc('Watch:\n\n![Demo](https://youtu.be/dQw4w9WgXcQ?t=9)\n\n![Clip 1](/api/files/wvx2szrxf804)\n\n![Pic](https://example.com/a.png)\n');
    expect(validateDoc(doc)).toBeNull();
    const node = docNode(doc);
    const blocks: { type: string; attrs: Record<string, unknown> }[] = [];
    node.forEach((n) => blocks.push({ type: n.type.name, attrs: n.attrs }));
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'video', 'video', 'image']);
    expect(blocks[1].attrs).toMatchObject({ src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Demo' });
    expect(blocks[2].attrs).toMatchObject({ src: '/api/files/wvx2szrxf804' });
    expect(docToMarkdown(node)).toContain('![Demo](https://www.youtube.com/watch?v=dQw4w9WgXcQ)\n\n![Clip 1](/api/files/wvx2szrxf804)');
    expect(docText(node)).toContain('[video: Demo]');
    // A video block with any other address is not a valid document.
    const bad = JSON.parse(JSON.stringify(doc).replace('/api/files/wvx2szrxf804', 'https://example.com/clip.mp4'));
    expect(validateDoc(bad)).toMatch(/Invalid video/);
  });

  it('reads and writes a picture in a line of text, kept apart from a picture on a line of its own', () => {
    const src = '/api/images/00000000-0000-0000-0000-000000000001';
    const md = `Signed <img src="${src}" alt="Signature" width="88"> Name\n\n![Logo](${src})\n\nA mark ![tick](${src}) here.`;
    const d = markdownToDoc(md);
    expect(validateDoc(d)).toBeNull();
    const [signed, logo, tick] = d.content.content!;
    expect(signed.content).toEqual([{ type: 'text', text: 'Signed ' }, { type: 'inline_image', attrs: { src, alt: 'Signature', width: 88 } }, { type: 'text', text: ' Name' }]);
    expect(logo.type).toBe('image');
    expect(tick.content?.[1]).toEqual({ type: 'inline_image', attrs: { src, alt: 'tick', width: null } });
    expect(roundTrip(md)).toBe(`Signed <img src="${src}" alt="Signature" width="88"> Name\n\n![Logo](${src})\n\nA mark <img src="${src}" alt="tick"> here.`);
    // A line holding only an inline picture stays one (not a block picture).
    expect(docNode(markdownToDoc(`<img src="${src}" alt="">`)).firstChild!.type.name).toBe('paragraph');
    expect(docText(docNode(markdownToDoc(md)))).toContain('Signed [image: Signature] Name');
    // Not a picture address: left as text.
    expect(roundTrip('<img src="javascript:alert(1)">')).toBe('\\<img src="javascript:alert(1)">');
  });

  it('ignores unsafe links and images, and accepts an empty document', () => {
    const n = markdownToNodes('[x](javascript:alert(1)) and ![y](javascript:alert(1))');
    expect(n[0].textContent).toBe('[x](javascript:alert(1)) and ![y](javascript:alert(1))');
    expect(n[0].child(0).marks).toHaveLength(0);
    expect(markdownToDoc('').content.content).toMatchObject([{ type: 'paragraph' }]);
    expect(validateDoc(newDoc())).toBeNull();
    expect(validateDoc(markdownToDoc('# Hi\n\n- a\n- b'))).toBeNull();
    expect(validateDoc({ version: 1, content: { type: 'doc', content: [{ type: 'bogus' }] } })).toMatch(/Invalid document/);
    expect(validateDoc({ version: 1, content: { type: 'doc', content: [{ type: 'image', attrs: { src: 'javascript:x' } }] } })).toMatch(/Invalid image/);
    expect(validateDoc({ version: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:1' } }] }] }] } })).toBe('Invalid link');
  });

  it('parses loose lists and ordered lists that start elsewhere', () => {
    const nodes = markdownToNodes('3. three\n4. four\n\n- a\n\n  second paragraph of a\n- b');
    expect(nodes[0].attrs.start).toBe(3);
    expect(nodes[1].child(0).childCount).toBe(2);
    expect(nodes[1].child(0).child(1).textContent).toBe('second paragraph of a');
    expect(docToMarkdown(docSchema.nodes.doc.create(null, nodes))).toBe('3. three\n4. four\n\n- a\n\n  second paragraph of a\n- b');
  });
});
