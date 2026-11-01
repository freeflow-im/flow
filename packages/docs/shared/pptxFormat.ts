// What a PowerPoint file (.pptx) the desktop app edits in place can hold. The writer (buildPptx in
// shared/pptxExport.ts) keeps text, pictures, shapes, lines, backgrounds and speaker notes, with the theme's
// fonts and colors written out; what it can only approximate is listed here, so a deck with any of it is
// kept in the app's own format, and adding one to a PowerPoint file asks first.
import { youtubeId } from './video.ts';
import { fillColor, type Deck } from './deck.ts';

/** What the writer approximates in the deck (named for the user, e.g. "Gradient fills"), each once. */
export function pptxGaps(deck: Deck): string[] {
  const gaps = new Set<string>();
  const gradient = (fill: string | undefined) => !!fill && fillColor(fill) !== fill;
  for (const slide of deck.slides) {
    if (gradient(slide.bg)) gaps.add('Gradient fills');
    for (const el of slide.elements) {
      if (el.type === 'shape') {
        if (gradient(el.fill)) gaps.add('Gradient fills');
        if (el.path) gaps.add('Freeform shapes');
      } else if (el.type === 'image') {
        if (el.crop) gaps.add('Picture crops');
        if (el.clip) gaps.add('Pictures cut to shapes');
        if ((el.opacity ?? 1) < 1 || el.duotone) gaps.add('Picture transparency and recoloring');
      } else if (el.type === 'video') {
        if (!youtubeId(el.src)) gaps.add('Videos from your files');
      } else if (el.type === 'line') {
        if (el.startConnection || el.endConnection) gaps.add('Lines attached to shapes');
      }
    }
  }
  return [...gaps];
}

/** The first thing the deck has that `before` did not and a PowerPoint file can only approximate, or null. */
export function newPptxGap(before: Deck, after: Deck): string | null {
  const had = new Set(pptxGaps(before));
  return pptxGaps(after).find((g) => !had.has(g)) ?? null;
}
