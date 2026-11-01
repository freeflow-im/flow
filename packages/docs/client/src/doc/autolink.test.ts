import { describe, expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { docText } from '../../../shared/doc.ts';
import { docToMarkdown, markdownToDoc } from '../../../shared/docMarkdown.ts';
import { autoLinkHandler, autoLinkOnEnter, urlBeforeCursor } from './autolink.ts';
import { DocController } from './controller.ts';

/** A controller with the cursor at the end of the first block's text. */
function atEnd(markdown: string) {
  const ctl = new DocController(markdownToDoc(markdown), async () => {});
  ctl.run((tr) => tr.setSelection(TextSelection.create(tr.doc, tr.doc.child(0).nodeSize - 1)));
  return ctl;
}

describe('automatic links', () => {
  it('finds a URL ending at the cursor, without trailing punctuation', () => {
    expect(urlBeforeCursor(atEnd('see https://biztrip.ai').state)).toEqual({ from: 5, to: 23, href: 'https://biztrip.ai' });
    expect(urlBeforeCursor(atEnd('see https://biztrip.ai/x?y=1.').state)).toMatchObject({ href: 'https://biztrip.ai/x?y=1' });
    expect(urlBeforeCursor(atEnd('nothttps://x.com').state)).toBeNull();
    expect(urlBeforeCursor(atEnd('plain words').state)).toBeNull();
    expect(urlBeforeCursor(atEnd('already [https://x.com](https://x.com)').state)).toBeNull();
    expect(urlBeforeCursor(atEnd('`https://x.com`').state)).toBeNull();
    expect(urlBeforeCursor(atEnd('```\nhttps://x.com\n```').state)).toBeNull();
  });

  it('links the URL when a space is typed after it, keeping the space', () => {
    const ctl = atEnd('see https://biztrip.ai');
    const state = ctl.state;
    const text = state.selection.$from.parent.textContent;
    const tr = autoLinkHandler(state, /(?:^|\s)https?:\/\/\S+\s$/i.exec(`${text} `)!, state.selection.from - 'https://biztrip.ai'.length - 1, state.selection.from);
    expect(tr).not.toBeNull();
    ctl.dispatch(tr!);
    expect(docToMarkdown(ctl.doc)).toBe('see [https://biztrip.ai](https://biztrip.ai) ');
    // The link does not continue into what is typed next.
    ctl.run((t) => t.insertText('next'));
    expect(docToMarkdown(ctl.doc)).toBe('see [https://biztrip.ai](https://biztrip.ai) next');
  });

  it('links the URL on Enter and leaves the block split to the normal handling', () => {
    const ctl = atEnd('see https://biztrip.ai');
    expect(ctl.exec(autoLinkOnEnter)).toBe(false);
    expect(docToMarkdown(ctl.doc)).toBe('see [https://biztrip.ai](https://biztrip.ai)');
    expect(docText(ctl.doc)).toBe('see https://biztrip.ai');
    // Nothing to link: no transaction either.
    const v = ctl.store.version;
    ctl.exec(autoLinkOnEnter);
    expect(ctl.store.version).toBe(v);
  });
});
