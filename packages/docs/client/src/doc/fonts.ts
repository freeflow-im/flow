// Load the web fonts a document uses (see client/src/deck/fonts.ts for the list known to be on Google Fonts).
import type { Node as PMNode } from 'prosemirror-model';
import { useEffect } from 'react';
import { ensureFonts } from '../deck/fonts.ts';

/** Font families named by font marks anywhere in the document. */
export function fontsIn(doc: PMNode): string[] {
  const out = new Set<string>();
  doc.descendants((node) => {
    for (const m of node.marks) if (m.type.name === 'font') out.add(String(m.attrs.family));
    return true;
  });
  return [...out];
}

export function useDocFonts(doc: PMNode): void {
  const key = fontsIn(doc).sort().join('|');
  useEffect(() => {
    if (key) ensureFonts(key.split('|'));
  }, [key]);
}
