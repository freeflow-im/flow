// Public links: a presentation or a video of the hosted app that anyone with the address can view, signed in or
// not (docs/architecture.md). A link is a `link:<token>` viewer grant on the file (server/access.ts, platform phase
// 3.2). The address's token is the only thing a guest has, so what a guest gets is built here:
// a copy of the deck without its speaker notes or its links to spreadsheets, whose pictures and videos are named
// under the token, and only those can be fetched with it.
import { randomBytes } from 'node:crypto';
import type { Deck } from '../shared/deck.ts';
import { PREVIEW_FILE_TYPES } from '../shared/types.ts';
import { STORED_FILE_RE } from '../shared/video.ts';

export type SharedKind = 'deck' | 'file';

export const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const IMAGE_RE = /^\/api\/images\/([0-9a-f-]{36})$/;

/** A stored file that can be shared on its own: a video a browser plays. */
export const isSharableVideo = (type: string): boolean => type.startsWith('video/') && PREVIEW_FILE_TYPES.includes(type);

/** A new link's token (a link grant's, `link:<token>`): stopped and made again, a link gets a new one. */
export const newLinkToken = (): string => randomBytes(24).toString('base64url');

/**
 * What a guest sees of a deck, and the stored pictures and files it may fetch: those its picture and video elements
 * show. An address anywhere else (a slide's text) gives no access.
 */
export function publicDeck(deck: Deck, token: string): { deck: Deck; images: Set<string>; files: Set<string> } {
  const images = new Set<string>();
  const files = new Set<string>();
  const named = (src: string): string => {
    const image = IMAGE_RE.exec(src);
    if (image) {
      images.add(image[1]);
      return `/api/public/${token}/images/${image[1]}`;
    }
    const file = STORED_FILE_RE.exec(src);
    if (file) {
      files.add(file[1]);
      return `/api/public/${token}/files/${file[1]}`;
    }
    return src;
  };
  const shown: Deck = {
    ...deck,
    slides: deck.slides.map(({ notes: _notes, ...slide }) => ({
      ...slide,
      elements: slide.elements.map((el) => {
        const { source: _source, ...rest } = el as typeof el & { source?: unknown };
        const element = rest as typeof el;
        return element.type === 'image' || element.type === 'video' ? { ...element, src: named(element.src) } : element;
      }),
    })),
  };
  return { deck: shown, images, files };
}
