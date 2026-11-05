// A saved assistant key sealed under another key (the Worker once sealed with a random key per object instance, so a
// restart made every saved key unreadable): entering it again must work, and a turn must say what is wrong.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db.ts';
import { AssistantSettingsStore, SettingsError } from './settings.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'assistant-settings-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const keyFile = (name: string) => {
  const f = path.join(dir, name);
  writeFileSync(f, randomBytes(32).toString('base64'));
  return f;
};
const ok = async () => {};

describe('a saved key sealed under another key', () => {
  it('is treated as gone: the person enters it again, and a turn before that says so', async () => {
    const db = openDb(path.join(dir, 'app.db'));
    db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u', 'u@example.com', '', ?)").run(new Date().toISOString());
    const first = new AssistantSettingsStore(db, keyFile('a.key'));
    await first.update('u', { provider: 'openai', openaiKey: 'sk-old-key' }, ok);
    expect(first.choice('u')?.apiKey).toBe('sk-old-key');

    const second = new AssistantSettingsStore(db, keyFile('b.key')); // another key over the same rows
    expect(() => second.choice('u')).toThrow(SettingsError);
    expect(second.get('u').openaiKey).not.toBeNull(); // the mask is still shown until it is replaced
    const after = await second.update('u', { provider: 'openai', openaiKey: 'sk-new-key' }, ok);
    expect(after.openaiKey).not.toBeNull();
    expect(second.choice('u')?.apiKey).toBe('sk-new-key');
  });

  it('a Brave Search key sealed under another key is gone, not an error on every turn', async () => {
    const db = openDb(path.join(dir, 'app.db'));
    db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u', 'u@example.com', '', ?)").run(new Date().toISOString());
    const first = new AssistantSettingsStore(db, keyFile('a.key'));
    await first.update('u', { provider: 'openai', openaiKey: 'sk-old-key', braveKey: 'brave-old-key' }, ok);
    expect(first.braveKey('u')).toBe('brave-old-key');

    const second = new AssistantSettingsStore(db, keyFile('b.key'));
    expect(second.braveKey('u')).toBeNull(); // the turn goes on without it
    expect(second.openaiKey('u')).toBeNull();
    expect(second.get('u').braveKey).toBeNull(); // Settings shows it as not set
    // Entering the model key again keeps nothing of the unreadable search key.
    const after = await second.update('u', { provider: 'openai', openaiKey: 'sk-new-key' }, ok);
    expect(after.braveKey).toBeNull();
    expect(second.braveKey('u')).toBeNull();
    expect(second.choice('u')?.apiKey).toBe('sk-new-key');
    expect(second.openaiKey('u')).toBe('sk-new-key');
  });
});
