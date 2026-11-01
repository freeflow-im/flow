import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { featurePages, parseFeature } from './marketing.ts';
import { mailbox, signUp } from './testing.ts';
import { ORIGIN_MARK } from '../shared/brand.ts';

// The feature pages (content/features, server/marketing.ts): HTML for people and crawlers, Markdown for agents.
let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-marketing-'));
  app = await buildApp({ dataDir: dir, appUrl: 'https://docs.test' });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a feature file', () => {
  it('is its front matter, its heading, the paragraph under it, the rest and its questions', () => {
    const p = parseFeature(
      'things',
      `---\ntitle: Things for SEO\ndescription: All about things.\nimage: thing\nalt: A thing\norder: 3\n---\n\n# Edit things\n\nThings, **edited**.\n\n## What you can do\n\n- Stuff\n\n## Frequently asked questions\n\n### Is it \`free\`?\n\nYes, [it is](/x).\n\nReally.\n\n### Unanswered?\n\n## After\n\nMore.\n`,
    );
    expect(p).toMatchObject({ slug: 'things', title: 'Things for SEO', description: 'All about things.', image: 'thing', alt: 'A thing', order: 3, h1: 'Edit things', lede: 'Things, **edited**.' });
    expect(p.rest.startsWith('## What you can do')).toBe(true);
    expect(p.rest).toContain('## After');
    expect(p.faq).toEqual([{ q: 'Is it free?', a: 'Yes, it is. Really.' }]);
  });

  it('every page in content/features has what its page needs', () => {
    const pages = featurePages();
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) {
      expect(p.slug).toMatch(/^[a-z0-9-]+$/);
      expect(p.description.length).toBeGreaterThan(50);
      expect(p.description.length).toBeLessThanOrEqual(200);
      expect(p.alt).not.toBe('');
      expect(p.lede).not.toBe('');
    }
  });
});

describe('the feature pages', () => {
  const [first] = featurePages();

  it('are HTML with their text, picture, metadata and structured data', async () => {
    const res = await app.inject({ method: 'GET', url: `/features/${first.slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain(`<h1>${first.h1}</h1>`);
    expect(res.body).toContain(`<link rel="canonical" href="https://docs.test/features/${first.slug}">`);
    expect(res.body).toContain(`href="/features/${first.slug}.md"`);
    expect(res.body).toContain(`/marketing/${first.image}.webp`);
    const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(res.body)![1]);
    expect(ld['@graph'].map((n: { '@type': string }) => n['@type'])).toEqual(expect.arrayContaining(['SoftwareApplication', 'WebPage', 'BreadcrumbList']));
  });

  it('are Markdown at their address with .md, or when Markdown is asked for', async () => {
    for (const req of [{ url: `/features/${first.slug}.md` }, { url: `/features/${first.slug}`, headers: { accept: 'text/markdown' } }]) {
      const res = await app.inject({ method: 'GET', ...req });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/markdown');
      expect(res.body.startsWith(`# ${first.h1}\n`)).toBe(true);
      expect(res.body).not.toContain('\n---\n');
      expect(res.body).toContain(`https://docs.test/marketing/${first.image}.webp`);
    }
  });

  it('are listed on /features, in the sitemap, robots.txt and llms.txt', async () => {
    const index = await app.inject({ method: 'GET', url: '/features' });
    expect(index.body).toContain(`href="/features/${first.slug}"`);
    const sitemap = await app.inject({ method: 'GET', url: '/sitemap.xml' });
    expect(sitemap.headers['content-type']).toContain('xml');
    expect(sitemap.body).toContain(`<loc>https://docs.test/features/${first.slug}</loc>`);
    expect((await app.inject({ method: 'GET', url: '/robots.txt' })).body).toContain('Sitemap: https://docs.test/sitemap.xml');
    expect((await app.inject({ method: 'GET', url: '/llms.txt' })).body).toContain(`(https://docs.test/features/${first.slug}.md)`);
  });

  it('have the address of the app where their text names it', async () => {
    for (const url of ['/features/ai-agents', '/features/ai-agents.md']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body).toContain('https://docs.test/mcp/v2');
      expect(res.body).not.toContain('{{origin}}');
    }
  });

  it('are not found by any other name', async () => {
    expect((await app.inject({ method: 'GET', url: '/features/nothing' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/features/..%2Fpackage.md' })).statusCode).toBe(404);
  });
});

describe('the front page', () => {
  it('is sent already drawn to a visitor at /, and the app is sent to a user and to every other address', async () => {
    const data = mkdtempSync(path.join(tmpdir(), 'sheetsweb-landing-'));
    const staticDir = path.join(data, 'client');
    mkdirSync(staticDir);
    mkdirSync(path.join(data, 'data'));
    writeFileSync(path.join(staticDir, 'index.html'), '<div id="root"></div>');
    writeFileSync(path.join(staticDir, 'landing.html'), `<div id="root"><a href="${ORIGIN_MARK}/mcp/v2">front</a></div>`);
    const box = mailbox();
    const a = await buildApp({ dataDir: path.join(data, 'data'), staticDir, sendMail: box.send, appUrl: 'https://docs.test' });
    try {
      for (const url of ['/', '/?from=x']) expect((await a.inject({ method: 'GET', url })).body).toBe('<div id="root"><a href="https://docs.test/mcp/v2">front</a></div>');
      expect((await a.inject({ method: 'GET', url: '/s/abc' })).body).toBe('<div id="root"></div>');
      const { cookie } = await signUp(a, box, 'landing@x.com');
      expect((await a.inject({ method: 'GET', url: '/', headers: { cookie } })).body).toBe('<div id="root"></div>');
    } finally {
      await a.close();
      rmSync(data, { recursive: true, force: true });
    }
  });
});
