// "Getting started": the first time a user asks for the guide they get their own copy of it, an ordinary
// presentation in their files; after that they get that copy back (found by its title). The guide itself is
// a presentation someone keeps in their own account and edits in the app: GETTING_STARTED_DECK_ID names it.
// Without that setting (the desktop app, local development) the copy is made from the built-in one.
import { readFile } from 'node:fs/promises';
import type { Deck } from '../shared/deck.ts';
import { findGettingStarted, GETTING_STARTED_TITLE, gettingStartedDeck } from '../shared/gettingStarted.ts';
import type { SheetMeta } from '../shared/types.ts';
import type { ImageStore } from './images.ts';
import type { SheetStore } from './sheets.ts';

const IMAGE_URL = /\/api\/images\/([0-9a-f-]{36})/g;

/** A copy of the deck whose stored pictures belong to `userId`: an account can only load its own. */
async function withOwnImages(deck: Deck, images: ImageStore, fromOwner: string, userId: string): Promise<Deck> {
  const text = JSON.stringify(deck);
  const copies = new Map<string, string>();
  for (const [url, id] of text.matchAll(IMAGE_URL)) {
    if (copies.has(url)) continue;
    // A picture that is gone, or cannot be copied, stays a broken link rather than failing the whole copy.
    const img = images.get(fromOwner, id);
    const copy = img ? await readFile(img.file).then((data) => images.create(userId, img.type, data), () => null) : null;
    copies.set(url, copy ?? url);
  }
  return JSON.parse(text.replace(IMAGE_URL, (url) => copies.get(url) ?? url)) as Deck;
}

export async function openGettingStarted(sheets: SheetStore, images: ImageStore, userId: string, masterId: string | undefined = process.env.GETTING_STARTED_DECK_ID?.trim() || undefined): Promise<SheetMeta> {
  const mine = findGettingStarted(sheets.list(userId, 'deck'));
  if (mine) return mine;
  const master = masterId ? await sheets.loadDeckOfAnyOwner(masterId) : null;
  // The guide's owner asking for it before naming it "Getting started" gets the guide itself, not a copy of it.
  if (master && master.ownerId === userId) return master.meta;
  const deck = master ? await withOwnImages(master.deck, images, master.ownerId, userId) : gettingStartedDeck();
  return sheets.createDeck(userId, GETTING_STARTED_TITLE, deck);
}
