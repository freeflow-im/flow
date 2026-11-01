import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { splitBlock } from 'prosemirror-commands';
import { TextSelection } from 'prosemirror-state';
import { docSchema, docText } from '../../../shared/doc.ts';
import { markdownToDoc } from '../../../shared/docMarkdown.ts';
import { DocController } from './controller.ts';

describe('document store undo/redo', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('merges quick successive edits (typing) into one undo step, and separates slow ones', () => {
    const ctl = new DocController(markdownToDoc('Hi'), async () => {});
    const type = (s: string) => ctl.run((tr) => tr.insertText(s, tr.doc.content.size - 1));
    type(' there');
    type(',');
    vi.advanceTimersByTime(1000);
    type(' friend');
    expect(docText(ctl.doc)).toBe('Hi there, friend');
    ctl.undo();
    expect(docText(ctl.doc)).toBe('Hi there,');
    ctl.undo();
    expect(docText(ctl.doc)).toBe('Hi');
    expect(ctl.store.canUndo()).toBe(false);
    ctl.redo();
    ctl.redo();
    expect(docText(ctl.doc)).toBe('Hi there, friend');
    expect(ctl.store.canRedo()).toBe(false);
    // A new edit after undo drops the redo history.
    ctl.undo();
    type('!');
    expect(ctl.store.canRedo()).toBe(false);
    expect(docText(ctl.doc)).toBe('Hi there,!');
  });

  it('groups agent changes by request however far apart, and restores the selection on undo', () => {
    const ctl = new DocController(markdownToDoc('One.'), async () => {});
    ctl.run((tr) => tr.setSelection(TextSelection.create(tr.doc, 2)));
    ctl.runAgent('req-1', (tr) => tr.insertText(' Two.', tr.doc.content.size - 1));
    vi.advanceTimersByTime(5000);
    ctl.runAgent('req-1', (tr) => tr.insertText(' Three.', tr.doc.content.size - 1));
    ctl.runAgent('req-2', (tr) => tr.insertText(' Four.', tr.doc.content.size - 1));
    expect(docText(ctl.doc)).toBe('One. Two. Three. Four.');
    ctl.undo();
    expect(docText(ctl.doc)).toBe('One. Two. Three.');
    ctl.undo();
    expect(docText(ctl.doc)).toBe('One.');
    expect(ctl.state.selection.from).toBe(2);
    // The saved document follows the store, and the version only counts document changes.
    const v = ctl.store.version;
    ctl.run((tr) => tr.setSelection(TextSelection.create(tr.doc, 1)));
    expect(ctl.store.version).toBe(v);
    ctl.redo();
    expect(ctl.store.version).toBe(v + 1);
    expect(ctl.store.document.content.content?.[0]).toMatchObject({ type: 'paragraph', content: [{ type: 'text', text: 'One. Two. Three.' }] });
  });

  it('starts a normal paragraph after Enter at the end of a title, subtitle or heading', () => {
    const ctl = new DocController(markdownToDoc('# Report {.title}\n\n## Sub {.subtitle}\n\n### Heading'), async () => {});
    for (const block of [0, 1, 2]) {
      let pos = 0;
      for (let k = 0; k <= block; k++) pos += ctl.doc.child(k).nodeSize;
      pos -= 1; // end of the block's text
      ctl.run((tr) => tr.setSelection(TextSelection.create(tr.doc, pos)));
      expect(ctl.state.selection.$from.index(0)).toBe(block);
      expect(ctl.state.selection.$from.parentOffset).toBe(ctl.state.selection.$from.parent.content.size);
      ctl.exec(splitBlock);
      expect(ctl.state.selection.$from.parent.type.name).toBe('paragraph');
      ctl.undo();
    }
    // The empty document the agent leaves behind is a paragraph, not a title.
    expect(docSchema.nodes.doc.contentMatch.defaultType?.name).toBe('paragraph');
  });

  it('closes the history when the editor loses focus', () => {
    const ctl = new DocController(markdownToDoc(''), async () => {});
    ctl.run((tr) => tr.insertText('a', 1));
    ctl.closeHistory();
    ctl.run((tr) => tr.insertText('b', 2));
    ctl.undo();
    expect(docText(ctl.doc)).toBe('a');
  });
});
