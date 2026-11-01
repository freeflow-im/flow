// Public links: a presentation or a video of the hosted app that anyone with the address can view, signed in or
// not (docs/architecture.md). The address's token is the only thing a guest has, so what a guest gets is built here:
// a copy of the deck without its speaker notes or its links to spreadsheets, whose pictures and videos are named
// under the token, and only those can be fetched with it.
import { randomBytes } from 'node:crypto';
import type { Deck } from '../shared/deck.ts';
import { PREVIEW_FILE_TYPES } from '../shared/types.ts';
import { STORED_FILE_RE } from '../shared/video.ts';
import type { DB } from './db.ts';

export type SharedKind = 'deck' | 'file';

export interface PublicLink {
  token: string;
  ownerId: string;
  kind: SharedKind;
  fileId: string;
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const IMAGE_RE = /^\/api\/images\/([0-9a-f-]{36})$/;

/** A stored file that can be shared on its own: a video a browser plays. */
export const isSharableVideo = (type: string): boolean => type.startsWith('video/') && PREVIEW_FILE_TYPES.includes(type);

export class PublicLinks {
  private readonly db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  /** The token of a file's link, if it has one. */
  tokenOf(ownerId: string, kind: SharedKind, fileId: string): string | null {
    const row = this.db.prepare('SELECT token FROM public_links WHERE owner_id = ? AND kind = ? AND file_id = ?').get(ownerId, kind, fileId) as { token: string } | undefined;
    return row?.token ?? null;
  }

  /** The file's link, made if it has none. A link stopped and made again gets a new token: the old address stays dead. */
  create(ownerId: string, kind: SharedKind, fileId: string): string {
    const token = randomBytes(24).toString('base64url');
    this.db.prepare('INSERT OR IGNORE INTO public_links (token, owner_id, kind, file_id, created_at) VALUES (?, ?, ?, ?, ?)').run(token, ownerId, kind, fileId, new Date().toISOString());
    return this.tokenOf(ownerId, kind, fileId)!;
  }

  remove(ownerId: string, kind: SharedKind, fileId: string): void {
    this.db.prepare('DELETE FROM public_links WHERE owner_id = ? AND kind = ? AND file_id = ?').run(ownerId, kind, fileId);
  }

  resolve(token: string): PublicLink | null {
    if (!TOKEN_RE.test(token)) return null;
    const row = this.db.prepare('SELECT owner_id, kind, file_id FROM public_links WHERE token = ?').get(token) as { owner_id: string; kind: SharedKind; file_id: string } | undefined;
    return row ? { token, ownerId: row.owner_id, kind: row.kind, fileId: row.file_id } : null;
  }
}

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
