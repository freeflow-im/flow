import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HelpViewer } from './HelpModal';

// The help viewer (#383) renders markdown files that live in the repo, so the
// tests use the real ones: a formatting change in docs/help that the block
// renderer can't handle should fail here, not in front of a user.
const helpDir = path.resolve(process.cwd(), '../../docs/help');
const read = (slug: string) => readFileSync(path.join(helpDir, `${slug}.md`), 'utf8')
  .replace(/\r\n?/g, '\n')
  .replace(/^---\n[\s\S]*?\n---\n?/, '');

const TOPICS = [
  { slug: 'home', title: 'Home', order: 0 },
  { slug: 'workspaces', title: 'Workspaces', order: 1 },
  { slug: 'channels-and-invites', title: 'Channels & Invites', order: 2 },
  { slug: 'agents', title: 'Agents', order: 3 },
  { slug: 'mini-apps', title: 'Mini Apps', order: 4 },
  { slug: 'huddles', title: 'Huddles', order: 5 },
  { slug: 'scheduled-messages', title: 'Scheduled Messages', order: 6 },
  { slug: 'meet', title: 'Meet', order: 7 },
];

// "What's New" (#474) is the one topic with no file: the server generates it
// from the same changelog source as the build version menu's release notes.
const GENERATED = { slug: 'whats-new', title: "What's New", order: 90 };
const ALL = [...TOPICS, GENERATED];

const view = (slug: string) =>
  renderToStaticMarkup(
    <HelpViewer
      topics={ALL}
      page={{ slug, title: slug, markdown: read(slug) }}
      slug={slug}
      onSelect={() => {}}
      onClose={() => {}}
    />,
  );

describe('HelpViewer', () => {
  it('lists every topic beside the page, marking the selected one', () => {
    const html = view('home');
    for (const t of ALL) expect(html).toContain(`data-testid="help-topic-${t.slug}"`);
    expect(html).toContain('Channels &amp; Invites');
    expect(html).toMatch(/help-topic-home"[^>]*aria-current="page"/);
  });

  it('renders the Home page markdown as HTML', () => {
    const html = view('home');
    expect(html).toContain('Welcome to Flow');
    expect(html).toContain('<h1');
    expect(html).toContain('<li'); // the "Getting around" bullets
  });

  it('renders every seed topic page without throwing', () => {
    for (const t of TOPICS) {
      const html = view(t.slug);
      expect(html, t.slug).toContain('<h1');
      expect(html, t.slug).toContain('data-testid="help-page"');
    }
  });

  it('covers every markdown file in docs/help — a new file needs no client change', () => {
    const slugs = readdirSync(helpDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
    expect(slugs.sort()).toEqual(TOPICS.map((t) => t.slug).sort());
  });

  it('renders the generated release notes as a help page', async () => {
    // Same text the "Build …" → What's new lightbox shows: the server serves
    // this page straight from the FEATURES.md generator.
    const { buildFeatures } = await import('../../../../scripts/build-features.mjs');
    const html = renderToStaticMarkup(
      <HelpViewer
        topics={ALL}
        page={{ slug: GENERATED.slug, title: GENERATED.title, markdown: buildFeatures().markdown }}
        slug={GENERATED.slug}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("What&#x27;s new in Flow");
    expect(html).toContain('<li'); // the notes themselves
  });

  it('says so when the content cannot be loaded', () => {
    const html = renderToStaticMarkup(
      <HelpViewer topics={[]} page={undefined} slug="home" failed onSelect={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain("isn&#x27;t available");
  });
});
