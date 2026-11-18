// Drafts (docs/specs/user-apps.md §9.6): the starter project passes every check, and a draft's problems are listed.
import { describe, expect, it } from 'vitest';
import { draftProblems, starterFiles } from './appDrafts';

const enc = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)]));

describe('drafts', () => {
  it('starts from a project that may be published as it is', () => {
    const files = starterFiles('shop', 'Shopping');
    expect(Object.keys(files).sort()).toEqual(['freeflow-app.json', 'migrations/0001_items.sql', 'server.js', 'ui/index.html']);
    expect(draftProblems(enc(files))).toEqual([]);
    expect(files['server.js']).toContain("from 'freeflow'");
  });

  it('lists what stands between a draft and a version', () => {
    const files = starterFiles('shop', 'Shopping');
    expect(draftProblems(enc({ ...files, 'freeflow-app.json': '{' }))[0]).toMatch(/not JSON/);
    const { 'server.js': _s, ...noServer } = files;
    expect(draftProblems(enc(noServer))).toContain('files: server.js is missing');
    const { 'freeflow-app.json': _m, ...noManifest } = files;
    expect(draftProblems(enc(noManifest))).toEqual(['freeflow-app.json is missing']);
  });
});
