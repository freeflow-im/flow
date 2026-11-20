// Whiteboard file format (stored like the other kinds, server/sheets.ts, kind "whiteboard").
//
// A whiteboard is one large canvas, about four screens wide and four high, holding the same elements a slide does
// (shared/deck.ts): text with rich formatting, sticky notes (text with a fill), shapes, lines and pictures. The editor
// is the slide editor over this one canvas (client/src/whiteboard), with an invisible grid of GRID points that
// positions and sizes snap to. Typed text is an `anchored` text element: it stays where it was typed.
import { validateElement, type Deck, type SlideElement } from './deck.ts';

export const BOARD_W = 5760;
export const BOARD_H = 3600;
/** The invisible grid, in points: moved, resized and new elements land on it. */
export const GRID = 4;
/** The name of the global scratchpad, the whiteboard at the top of My files the suite bar's scratchpad button opens. */
export const SCRATCHPAD_TITLE = 'Global Scratchpad';
export const MAX_BOARD_ELEMENTS = 5000;

export interface Whiteboard {
  version: 1;
  /** In drawing order (last is on top). */
  elements: SlideElement[];
}

export function newWhiteboard(): Whiteboard {
  return { version: 1, elements: [] };
}

/** The nearest grid line to v. */
export const snap = (v: number): number => Math.round(v / GRID) * GRID;

/** The kinds of element a whiteboard holds. */
const BOARD_TYPES = new Set<SlideElement['type']>(['text', 'shape', 'line', 'image']);

/** Structural validation of an uploaded whiteboard; returns a problem or null. */
export function validateWhiteboard(b: unknown): string | null {
  if (!b || typeof b !== 'object') return 'Whiteboard must be an object';
  const board = b as Whiteboard;
  if (board.version !== 1) return 'Unsupported whiteboard version';
  if (!Array.isArray(board.elements)) return 'Whiteboard elements must be a list';
  if (board.elements.length > MAX_BOARD_ELEMENTS) return `A whiteboard holds at most ${MAX_BOARD_ELEMENTS} items`;
  const ids = new Set<string>();
  for (const e of board.elements) {
    if (!e || typeof e !== 'object' || !BOARD_TYPES.has(e.type)) return `whiteboard: a ${String(e?.type)} cannot be placed on a whiteboard`;
    const problem = validateElement(e, 'whiteboard');
    if (problem) return problem;
    if (e.x < 0 || e.y < 0 || e.x > BOARD_W || e.y > BOARD_H) return `whiteboard: element ${e.id} is off the board`;
    if (ids.has(e.id)) return `whiteboard: duplicate element id ${e.id}`;
    ids.add(e.id);
  }
  return null;
}

/** The text on a whiteboard, one line per paragraph or label, for search and the assistant. */
export function whiteboardText(b: Whiteboard): string {
  const out: string[] = [];
  for (const e of b.elements) {
    if (e.type === 'text') for (const p of e.paragraphs) out.push(p.text);
    else if (e.type === 'shape' && e.text) out.push(e.text);
  }
  return out.filter((t) => t.trim()).join('\n');
}

/**
 * The whiteboard as the slide editor holds it: a one-slide deck in the light theme, whose one slide is the board.
 * The editor (client/src/deck) works on decks; the page turns the board into one and back.
 */
export function boardAsDeck(b: Whiteboard): Deck {
  return { version: 1, theme: 'light', slides: [{ id: 'board', elements: b.elements }] };
}

export function deckAsBoard(d: Deck): Whiteboard {
  return { version: 1, elements: d.slides[0]?.elements ?? [] };
}
