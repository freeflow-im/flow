import { describe, expect, it } from 'vitest';
import { BY_FILE, bodyPlace, docsRoutes } from './docs';

// Each kind of Docs file is made and opened under its own path (docs/server/app.ts). A path missing here sends the
// request to the caller's first organization: a whiteboard made in a second one was missing from its file list.
const KIND_PATHS = ['sheets', 'docs', 'decks', 'markdown', 'whiteboards'];

/** The organization whose Docs object a request reached, for a caller in `first` and `second`. */
async function routedTo(path: string, init: RequestInit = {}): Promise<string> {
  let reached = '';
  const answers: Record<string, unknown> = {
    authenticate: { user: { id: 'u1', email: 'u1@x.test' } },
    organizationsOf: ['first', 'second'],
    accountFor: { id: 'a1', kind: 'member' },
    organizationOfId: null,
  };
  const env = {
    DIRECTORY: { idFromName: () => 'directory', get: () => ({ call: async (method: string) => ({ ok: true, value: answers[method] }) }) },
    ORG: { idFromName: (n: string) => n, get: () => ({ channelIdsOf: async () => [] }) },
    DOCS: { idFromName: (n: string) => n, get: (id: string) => ({ handle: async () => ((reached = id), new Response('{}')) }) },
  };
  const headers = new Headers(init.headers);
  headers.set('cookie', 'sid=token');
  await docsRoutes.request(`http://x${path}`, { ...init, headers }, env as never);
  return reached;
}
const post = (body: object) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('Docs routing', () => {
  it('places a new file by the organization in its body, for every kind', async () => {
    for (const path of [...KIND_PATHS, 'folders']) expect(await routedTo(`/api/${path}`, post({ title: 't', workspace: 'second' })), path).toBe('second');
  });

  it('places a request for one file by the file, for every kind', () => {
    for (const path of KIND_PATHS) expect(BY_FILE.exec(`/api/${path}/abc123`)?.[1], path).toBe('abc123');
  });

  // Task #52: moving a file into a folder of a second organization said "File not found".
  it('places a move into a folder by the organization in its body', async () => {
    expect(await routedTo('/api/library/move', post({ kind: 'file', id: 'abc123abc123', folder: '', workspace: 'second' }))).toBe('second');
    expect(await routedTo('/api/library/move?workspace=second', post({ kind: 'file', id: 'abc123abc123', folder: '' }))).toBe('second');
  });

  it("places a folder's change of root by the root it is in", () => {
    expect(bodyPlace({ path: 'Drafts', from: { workspace: 'second' }, workspace: 'second', shared: true })).toBe('second');
    expect(bodyPlace({ path: 'Drafts', from: { workspace: 'first' }, workspace: 'second' })).toBe('first');
  });

  it('goes to the first organization when nothing names one, and never reads an upload as JSON', async () => {
    expect(await routedTo('/api/library/move', post({ kind: 'file', id: 'abc123abc123', folder: '' }))).toBe('first');
    expect(await routedTo('/api/files', { method: 'POST', headers: { 'content-type': 'image/png' }, body: '{"workspace":"second"}' })).toBe('first');
  });
});
