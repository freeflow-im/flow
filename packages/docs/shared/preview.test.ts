import { describe, expect, it } from 'vitest';
import { newDoc } from './doc.ts';
import { newMarkdownDoc } from './markdown.ts';
import { docPreview, markdownPreview, sheetPreview } from './preview.ts';
import { newWorkbook } from './types.ts';

describe('file previews', () => {
  it('show the start of a text, and nothing for an empty one', () => {
    expect(markdownPreview(newMarkdownDoc('# Title\n\nBody'))).toEqual({ kind: 'text', text: '# Title\n\nBody' });
    expect(markdownPreview(newMarkdownDoc('  \n'))).toEqual({ kind: 'empty' });
    expect(docPreview(newDoc())).toEqual({ kind: 'empty' });
    const doc = newDoc();
    doc.content = { type: 'doc', content: [{ type: 'heading', content: [{ type: 'text', text: 'Plan' }] }, { type: 'bullet_list', content: [{ type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] }] } as typeof doc.content;
    expect(docPreview(doc)).toEqual({ kind: 'text', text: 'Plan\none' });
  });

  it('show the top-left cells of the first tab', () => {
    const wb = newWorkbook('t1');
    expect(sheetPreview(wb)).toEqual({ kind: 'empty' });
    wb.tabs[0].cells.A1 = { v: 'Item' };
    wb.tabs[0].cells.B2 = { v: '=A1' };
    wb.tabs[0].cells.Z99 = { v: 'far away' };
    const p = sheetPreview(wb);
    expect(p.kind === 'grid' && [p.rows[0][0], p.rows[1][1], p.rows.length, p.rows[0].length]).toEqual(['Item', '=A1', 12, 6]);
  });
});
