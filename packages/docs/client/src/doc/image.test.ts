import { describe, expect, it } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { DOC_PAGE_WIDTH, editedImageWidth } from '../../../shared/doc.ts';
import { markdownToDoc } from '../../../shared/docMarkdown.ts';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { DocController } from './controller.ts';

const size = (width: number, height: number) => ({ width, height });
const OLD = '/api/images/11111111-1111-1111-1111-111111111111';
const NEW = '/api/images/22222222-2222-2222-2222-222222222222';

/** The picture blocks of a document, with where each is. */
function pictures(ctl: DocController): { pos: number; node: PMNode }[] {
  const found: { pos: number; node: PMNode }[] = [];
  ctl.state.doc.descendants((node, pos) => void (node.type.name === 'image' && found.push({ pos, node })));
  return found;
}

describe('a picture in a document after it was edited', () => {
  it('keeps its width unless its shape changed, and then keeps its scale', () => {
    expect(editedImageWidth(400, size(2000, 1000), size(2000, 1000))).toBe(400);
    // Fewer pixels of the same shape (a resize) is shown as wide as before.
    expect(editedImageWidth(400, size(2000, 1000), size(1000, 500))).toBe(400);
    // Cropped to its left half: half as wide. Turned on its side: as wide as it was tall.
    expect(editedImageWidth(400, size(2000, 1000), size(1000, 1000))).toBe(200);
    expect(editedImageWidth(400, size(2000, 1000), size(1000, 2000))).toBe(200);
    // Never wider than the page or too small to grab.
    expect(editedImageWidth(600, size(1000, 2000), size(2000, 1000))).toBe(DOC_PAGE_WIDTH);
    expect(editedImageWidth(100, size(2000, 1000), size(100, 1000))).toBe(40);
    // No width of its own, or sizes that could not be told: left alone.
    expect(editedImageWidth(null, size(2000, 1000), size(1000, 1000))).toBeNull();
    expect(editedImageWidth(400, null, size(1000, 1000))).toBe(400);
  });

  it('is put in place of the picture as one step that undo takes back', () => {
    const ctl = new DocController(markdownToDoc(`Before\n\n![A chart](${OLD})\n\nAfter`), async () => {});
    const [pic] = pictures(ctl);
    ctl.run((tr) => tr.setNodeMarkup(pic.pos, undefined, { ...pic.node.attrs, width: 400, align: 'center' }));
    expect(ctl.replaceImage(pic.pos, OLD, NEW, size(2000, 1000), size(1000, 1000))).toBe(true);
    expect(pictures(ctl)[0].node.attrs).toEqual({ src: NEW, alt: 'A chart', width: 200, align: 'center' });
    // The picture is left selected, as after a resize.
    expect(ctl.selectedImage()?.node.attrs.src).toBe(NEW);
    // (Quick successive steps undo together, so the width set a moment ago in this test goes too.)
    ctl.undo();
    expect(pictures(ctl)[0].node.attrs.src).toBe(OLD);
  });

  it('finds the picture again when the document changed while the image editor was open', () => {
    const ctl = new DocController(markdownToDoc(`![One](${OLD})\n\nText`), async () => {});
    const was = pictures(ctl)[0].pos;
    // Text typed above it moves the picture down.
    ctl.run((tr) => tr.insert(0, ctl.state.schema.nodes.paragraph.create(null, ctl.state.schema.text('Added above'))));
    expect(pictures(ctl)[0].pos).not.toBe(was);
    expect(ctl.replaceImage(was, OLD, NEW, null, null)).toBe(true);
    expect(pictures(ctl)[0].node.attrs.src).toBe(NEW);
    // Gone, or a position that is no longer in the document: nothing to put the edit in.
    expect(ctl.replaceImage(was, OLD, NEW, null, null)).toBe(false);
    expect(ctl.replaceImage(99999, 'https://example.com/none.png', NEW, null, null)).toBe(false);
  });
});

describe('signing a document', () => {
  it("puts the signature in the line in place of the selected blank, and today's date as text, each undone in one step", () => {
    const ctl = new DocController(markdownToDoc('Signed \\_\\_\\_\\_ Name\n\nDate'), async () => {});
    expect(ctl.state.doc.firstChild!.textContent).toBe('Signed ____ Name');
    const start = 1 + 'Signed '.length;
    ctl.run((tr) => tr.setSelection(TextSelection.create(tr.doc, start, start + 4)));
    expect(ctl.insertInlineImage(NEW, { alt: 'Signature', width: 88 })).toBe(true);
    expect(ctl.state.doc.firstChild!.toJSON().content).toEqual([{ type: 'text', text: 'Signed ' }, { type: 'inline_image', attrs: { src: NEW, alt: 'Signature', width: 88 } }, { type: 'text', text: ' Name' }]);
    ctl.run((tr) => tr.setSelection(TextSelection.atEnd(tr.doc)));
    expect(ctl.insertText(' Oct 27, 2026')).toBe(true);
    expect(ctl.state.doc.lastChild!.textContent).toBe('Date Oct 27, 2026');
    ctl.undo();
    ctl.undo();
    expect(ctl.state.doc.firstChild!.textContent).toBe('Signed ____ Name');
    // Not in a line of text (a picture block selected): nothing is put in.
    const pic = new DocController(markdownToDoc(`![A chart](${OLD})`), async () => {});
    pic.run((tr) => tr.setSelection(NodeSelection.create(tr.doc, 0)));
    expect(pic.insertInlineImage(NEW)).toBe(false);
  });
});
