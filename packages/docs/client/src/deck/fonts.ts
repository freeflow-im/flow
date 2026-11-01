// Load web fonts a deck uses (imported PowerPoint decks often use Inter, Poppins, ...). Only fonts known to be on
// Google Fonts are requested; anything else falls back to the theme font.
import { useEffect } from 'react';
import type { Deck } from '../../../shared/deck.ts';

/** The web fonts the font picker offers, besides the theme's own. */
export const GOOGLE_FONTS = new Set([
  'Inter',
  'Poppins',
  'Roboto',
  'Open Sans',
  'Lato',
  'Montserrat',
  'Oswald',
  'Raleway',
  'Nunito',
  'Nunito Sans',
  'Playfair Display',
  'Merriweather',
  'Source Sans 3',
  'Work Sans',
  'DM Sans',
  'Manrope',
  'Space Grotesk',
  'Rubik',
  'Ubuntu',
  'PT Sans',
  'Noto Sans',
  'Fira Sans',
  'Quicksand',
  'Karla',
  'Josefin Sans',
  'Libre Baskerville',
  'Lora',
  'Barlow',
  'Mulish',
  'IBM Plex Sans',
]);

/**
 * Web fonts that stand in for fonts PowerPoint decks name but browsers rarely have. The deck keeps the name it
 * came with (so the real font is used where it is installed, and an export names it again).
 */
const SUBSTITUTES: Record<string, string> = {
  'Felix Titling': 'Cinzel',
  'Avenir Next LT Pro': 'Nunito Sans',
  'Avenir Next': 'Nunito Sans',
  Avenir: 'Nunito Sans',
  'Gill Sans MT': 'Lato',
  'Century Gothic': 'Questrial',
  Calibri: 'Carlito',
  Cambria: 'Caladea',
};
/** Stand-ins that are not in the picker's list, with the styles Google Fonts has for them (a request for any other fails). */
const SUBSTITUTE_AXES: Record<string, string> = {
  Cinzel: 'wght@400;500;600;700;900',
  Questrial: '',
  Carlito: 'ital,wght@0,400;0,700;1,400;1,700',
  Caladea: 'ital,wght@0,400;0,700;1,400;1,700',
};
const DEFAULT_AXES = 'ital,wght@0,300;0,400;0,500;0,600;0,700;0,900;1,400';

/** The CSS font-family list for a font a deck names: the font itself, then its stand-in, if it has one. */
export function fontFamilies(font: string): string {
  const name = font.replace(/"/g, '');
  const sub = SUBSTITUTES[name];
  return sub ? `"${name}", "${sub}"` : `"${name}"`;
}

const loaded = new Set<string>();

/** Fonts named anywhere in the deck. */
export function fontsIn(deck: Deck): string[] {
  const out = new Set<string>();
  for (const s of deck.slides) {
    for (const e of s.elements) {
      if (e.type === 'shape' && e.textFont) out.add(e.textFont);
      if (e.type !== 'text') continue;
      if (e.style?.font) out.add(e.style.font);
      for (const p of e.paragraphs) if (p.font) out.add(p.font);
    }
  }
  return [...out];
}

/** Add a Google Fonts stylesheet for each font the deck uses that we know is available there. */
export function ensureFonts(fonts: string[]): void {
  const wanted = [...new Set(fonts.map((f) => SUBSTITUTES[f] ?? f))].filter((f) => (GOOGLE_FONTS.has(f) || f in SUBSTITUTE_AXES) && !loaded.has(f));
  if (!wanted.length) return;
  for (const f of wanted) loaded.add(f);
  const families = wanted
    .map((f) => {
      const axes = SUBSTITUTE_AXES[f] ?? DEFAULT_AXES;
      return `family=${encodeURIComponent(f).replace(/%20/g, '+')}${axes ? `:${axes}` : ''}`;
    })
    .join('&');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
  document.head.appendChild(link);
}

export function useDeckFonts(deck: Deck): void {
  const key = fontsIn(deck).sort().join('|');
  useEffect(() => {
    if (key) ensureFonts(key.split('|'));
  }, [key]);
}
