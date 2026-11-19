import { describe, expect, it } from 'vitest';
import { BY_FILE, MAKES } from './docs';

// Each kind of Docs file is made and opened under its own path (docs/server/app.ts). A path missing here sends the
// request to the caller's first organization: a whiteboard made in a second one was missing from its file list.
const KIND_PATHS = ['sheets', 'docs', 'decks', 'markdown', 'whiteboards'];

describe('Docs routing', () => {
  it('places a new file by the organization in its body, for every kind', () => {
    for (const path of [...KIND_PATHS, 'folders']) expect(MAKES.test(`/api/${path}`), path).toBe(true);
  });

  it('places a request for one file by the file, for every kind', () => {
    for (const path of KIND_PATHS) expect(BY_FILE.exec(`/api/${path}/abc123`)?.[1], path).toBe('abc123');
  });
});
