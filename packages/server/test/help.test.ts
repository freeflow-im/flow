// GET /v1/help/topics and /v1/help/pages/:slug — the built-in help docs (#383).
//
// Two things are worth pinning down. First, the seed content the web (and, in
// #384, macOS) viewer opens on actually exists and is in sidebar order. Second,
// the topic list is *derived from the directory*: dropping a new markdown file
// in makes it appear with no client change — that is the whole content model,
// and it is easy to break by hardcoding a list later.
//
// "What's New" (#474) is the one topic with no file: it is generated from the
// `## Feature` sections of changelog/ by the same script that writes the
// FEATURES.md behind the build version menu, so the two cannot drift.
//
// No database — the routes only read files, like the public-config tests.
import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FLOW_DATA_KEY ??= randomBytes(32).toString('base64');

const { buildApp } = await import('../src/app.js');
const { parseFrontMatter } = await import('../src/services/help.js');

beforeEach(() => {
  process.env.LOG_LEVEL = 'silent';
});

async function get(url: string) {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url });
  await app.close();
  return res;
}

describe('parseFrontMatter', () => {
  it('normalizes Windows line endings before clients render markdown', () => {
    const parsed = parseFrontMatter('---\r\ntitle: Windows\r\norder: 1\r\n---\r\n# Heading\r\n\r\n- item\r\n');
    expect(parsed.meta).toEqual({ title: 'Windows', order: '1' });
    expect(parsed.body).toBe('# Heading\n\n- item\n');
  });
});

describe('GET /v1/help/topics', () => {
  it('lists the seed topics in sidebar order, Home first', async () => {
    const res = await get('/v1/help/topics');
    expect(res.statusCode).toBe(200);
    const { topics } = res.json() as { topics: { slug: string; title: string; order: number }[] };
    expect(topics.map((t) => t.slug)).toEqual([
      'home',
      'workspaces',
      'channels-and-invites',
      'agents',
      'mini-apps',
      'huddles',
      'scheduled-messages',
      'meet',
      'whats-new',
    ]);
    expect(topics[0]!.title).toBe('Home');
    expect(topics.map((t) => t.title)).toContain('Channels & Invites');
    expect(topics.at(-1)!.title).toBe("What's New");
  });
});

describe('GET /v1/help/pages/:slug', () => {
  it('serves raw markdown with the front-matter stripped', async () => {
    const res = await get('/v1/help/pages/home');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { slug: string; title: string; markdown: string };
    expect(body.slug).toBe('home');
    expect(body.title).toBe('Home');
    expect(body.markdown.startsWith('---')).toBe(false);
    expect(body.markdown).toContain('# Welcome to Flow');
  });

  it('serves every topic the list advertises', async () => {
    const { topics } = (await get('/v1/help/topics')).json() as { topics: { slug: string }[] };
    for (const { slug } of topics) {
      const res = await get(`/v1/help/pages/${slug}`);
      expect(res.statusCode, slug).toBe(200);
      expect((res.json() as { markdown: string }).markdown.trim().length, slug).toBeGreaterThan(0);
    }
  });

  it('serves What\'s New from the same source as the build version menu', async () => {
    const res = await get('/v1/help/pages/whats-new');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { slug: string; title: string; markdown: string };
    expect(body.title).toBe("What's New");

    // Same bytes the version menu renders: FEATURES.md, as the generator
    // produces it. Comparing against the generator rather than a checked-in
    // fixture is what makes "no duplicated content to maintain" testable.
    const { buildFeatures } = await import('../../../scripts/build-features.mjs');
    expect(body.markdown).toBe(buildFeatures().markdown.trim() + '\n');
    expect(body.markdown).toContain("# What's new in Flow");
  });

  it('404s an unknown slug, and never escapes the help directory', async () => {
    expect((await get('/v1/help/pages/nope')).statusCode).toBe(404);
    expect((await get('/v1/help/pages/..%2F..%2FREADME')).statusCode).toBe(404);
    expect((await get('/v1/help/pages/.%2E')).statusCode).toBe(404);
  });
});

describe('a new markdown file (content-driven topic list)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-help-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('appears in the list and renders, with no client change', async () => {
    fs.writeFileSync(path.join(dir, 'home.md'), '---\ntitle: Home\norder: 0\n---\n\n# Home\n');
    fs.writeFileSync(path.join(dir, 'later.md'), '---\ntitle: Later\norder: 9\n---\n\n# Later\n');
    // A file with no front-matter still shows up, titled from its slug.
    fs.writeFileSync(path.join(dir, 'bare-page.md'), '# Bare\n');

    // The module reads FLOW_HELP_DIR once, at import — re-import it pointed
    // at the temp directory.
    process.env.FLOW_HELP_DIR = dir;
    vi.resetModules();
    const { listTopics, getPage } = await import('../src/services/help.js');
    delete process.env.FLOW_HELP_DIR;

    // whats-new is generated, not a file, so it rides along on any help dir;
    // bare-page has no `order:` and so falls back to 100, behind it.
    expect(listTopics().map((t: { slug: string }) => t.slug)).toEqual([
      'home',
      'later',
      'whats-new',
      'bare-page',
    ]);
    expect(listTopics().find((t: { slug: string }) => t.slug === 'bare-page')!.title).toBe('bare page');
    expect((await getPage('later')).markdown).toContain('# Later');
  });
});
