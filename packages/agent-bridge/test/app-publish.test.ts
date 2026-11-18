// `app publish`: which files of an app folder a version holds (docs/specs/user-apps.md §14 phase 2, step 5).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppPublishUsageError, collectAppFolder } from '../src/app-publish.js';

let dir = '';
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const make = (files: Record<string, string>) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pub-'));
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  return dir;
};

describe('collectAppFolder', () => {
  it('takes the manifest, server.js, migrations and ui files, and nothing else', () => {
    const d = make({ 'freeflow-app.json': '{"name":"kv"}', 'server.js': 'x', 'migrations/0001_a.sql': 'a', 'migrations/notes.txt': 'n', 'ui/index.html': 'i', 'ui/js/app.js': 'j', 'ui/.DS_Store': 'd', 'README.md': 'r', 'node_modules/x/y.js': 'y' });
    const { manifest, files } = collectAppFolder(d);
    expect(manifest).toEqual({ name: 'kv' });
    expect(Object.keys(files).sort()).toEqual(['migrations/0001_a.sql', 'server.js', 'ui/index.html', 'ui/js/app.js']);
  });

  it('says what is missing', () => {
    expect(() => collectAppFolder(make({ 'server.js': 'x' }))).toThrow(AppPublishUsageError);
    expect(() => collectAppFolder(make({ 'freeflow-app.json': '{' }))).toThrow(/not JSON/);
    expect(() => collectAppFolder(make({ 'freeflow-app.json': '{}' }))).toThrow(/no server\.js/);
  });
});
