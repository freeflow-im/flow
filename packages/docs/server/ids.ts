// Ids of the files a user sees in an address (/d/<id>, /s/<id>, /doc/<id>, /f/<id>): twelve lowercase letters
// and digits, about 62 random bits. Access is always checked against the owner, so an id only has to be
// unique, not secret. Files made before this have a UUID, and both kinds are valid for good.
import { randomInt } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const LENGTH = 12;

/** A new id; `taken` says whether one is in use already (then another is drawn). */
export function newFileId(taken: (id: string) => boolean = () => false): string {
  for (;;) {
    let id = '';
    for (let i = 0; i < LENGTH; i++) id += ALPHABET[randomInt(ALPHABET.length)];
    if (!taken(id)) return id;
  }
}

/** Whether the text has the shape of a file id, new or old (a UUID). */
export function isFileId(id: unknown): id is string {
  return typeof id === 'string' && (/^[0-9a-z]{12}$/.test(id) || /^[0-9a-f-]{36}$/.test(id));
}
