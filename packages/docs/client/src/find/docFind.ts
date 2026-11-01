// Find in a document: the matches of a query in the text of its ProseMirror document, as positions.
import type { Node as PMNode } from 'prosemirror-model';
import { findAll } from './find.ts';

export interface DocMatch {
  from: number;
  to: number;
}

/** Where `query` is in the document's text, block by block (a match does not run from one paragraph into the next). */
export function docMatches(doc: PMNode, query: string, matchCase: boolean): DocMatch[] {
  const out: DocMatch[] = [];
  if (!query) return out;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Each inline node takes as many characters as its size, so an index in the text is an offset in the block;
    // a picture or a line break is a character no query matches.
    let text = '';
    node.forEach((child) => {
      text += child.isText ? child.text! : '￼'.repeat(child.nodeSize);
    });
    for (const at of findAll(text, query, matchCase)) out.push({ from: pos + 1 + at, to: pos + 1 + at + query.length });
    return false;
  });
  return out;
}
