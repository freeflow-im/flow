// The feature pages the front page's boxes link to (/features/<slug>), written as Markdown in content/features and
// served two ways: as HTML, for people and for crawlers that do not run the app's scripts, and as the Markdown itself
// (/features/<slug>.md), for agents, which /llms.txt points to. /sitemap.xml and /robots.txt list them. The pages are
// plain HTML from the server, as the legal pages are, styled by client/public/marketing/site.css.
// `{{origin}}` in a page's text is the app's address.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { marked, type Token, type Tokens } from 'marked';

const DIR = fileURLToPath(new URL('../content/features/', import.meta.url));
const GITHUB = 'https://github.com/freeflow-im/mcp-docs';
const NPX = 'npx @freeflow-im/mcp-docs';

export interface FeaturePage {
  slug: string;
  /** The page's title for search results and the browser's tab, without the app's name. */
  title: string;
  description: string;
  /** The screenshot, by its name in /marketing (`slides` is /marketing/slides.webp). */
  image: string;
  alt: string;
  /** Where it comes among the features (the front page's order). */
  order: number;
  /** The heading, the paragraph under it, and the rest, as Markdown. */
  h1: string;
  lede: string;
  rest: string;
  faq: { q: string; a: string }[];
}

/** One file: its front matter (`key: value` lines between `---`) and its Markdown, which starts with its `# ` heading. */
export function parseFeature(slug: string, text: string): FeaturePage {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const meta: Record<string, string> = {};
  for (const line of (m?.[1] ?? '').split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const md = text.slice(m ? m[0].length : 0).trim();
  const tokens = marked.lexer(md);
  const h1 = tokens.find((t): t is Tokens.Heading => t.type === 'heading' && t.depth === 1);
  const lede = tokens.find((t): t is Tokens.Paragraph => t.type === 'paragraph');
  const rest = tokens.filter((t) => t !== h1 && t !== lede).map((t) => t.raw).join('').trim();
  return {
    slug,
    title: meta.title ?? h1?.text ?? slug,
    description: meta.description ?? '',
    image: meta.image ?? slug,
    alt: meta.alt ?? '',
    order: Number(meta.order ?? 100),
    h1: h1?.text ?? meta.title ?? slug,
    lede: lede?.raw.trim() ?? '',
    rest,
    faq: faqOf(tokens),
  };
}

/** The questions under a "Frequently asked questions" heading: each `### ` heading and the paragraphs after it. */
function faqOf(tokens: Token[]): { q: string; a: string }[] {
  const start = tokens.findIndex((t) => t.type === 'heading' && t.depth === 2 && /frequently asked/i.test((t as Tokens.Heading).text));
  if (start < 0) return [];
  const faq: { q: string; a: string }[] = [];
  for (const t of tokens.slice(start + 1)) {
    if (t.type === 'heading' && (t as Tokens.Heading).depth <= 2) break;
    if (t.type === 'heading') faq.push({ q: plain((t as Tokens.Heading).text), a: '' });
    else if (t.type === 'paragraph' && faq.length) faq[faq.length - 1].a += (faq[faq.length - 1].a ? ' ' : '') + plain((t as Tokens.Paragraph).text);
  }
  return faq.filter((f) => f.a);
}

/** Markdown inline text as plain text (for structured data). */
const plain = (md: string) =>
  md
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*|\*([^*]*)\*/g, '$1$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

let cache: FeaturePage[] | null = null;

/** Every feature page, in order. Read once in production; in development on each request, so edits show at once. */
export function featurePages(): FeaturePage[] {
  if (cache) return cache;
  const pages = existsSync(DIR)
    ? readdirSync(DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => parseFeature(f.slice(0, -3), readFileSync(DIR + f, 'utf8')))
        .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug))
    : [];
  if (process.env.NODE_ENV === 'production') cache = pages;
  return pages;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** JSON for a <script> element: nothing in it can end the element. */
const ldJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const imageUrl = (origin: string, p: FeaturePage) => `${origin}/marketing/${p.image}.webp`;

const APP = (origin: string) => ({
  '@type': 'SoftwareApplication',
  name: 'MCP Docs',
  url: `${origin}/`,
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'macOS, Windows, Web',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  downloadUrl: `${GITHUB}/releases/latest`,
});

const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';

/** The page around a feature's (or the index's) content: head, the front page's nav, the closing band and footer. */
function frame(o: { origin: string; path: string; title: string; description: string; image?: string; markdown?: string; ld: unknown[]; main: string }): string {
  const url = `${o.origin}${o.path}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(url)}">
${o.markdown ? `<link rel="alternate" type="text/markdown" href="${esc(o.markdown)}" title="This page as Markdown">\n` : ''}<link rel="icon" type="image/svg+xml" href="/favicon-home.svg">
<link rel="stylesheet" href="/marketing/site.css">
<meta property="og:type" content="website">
<meta property="og:site_name" content="MCP Docs">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(url)}">
${o.image ? `<meta property="og:image" content="${esc(o.image)}">\n<meta name="twitter:card" content="summary_large_image">\n` : ''}<script type="application/ld+json">${ldJson({ '@context': 'https://schema.org', '@graph': o.ld })}</script>
</head>
<body>
<header class="site-nav">
  <a href="/" class="site-logo"><img src="/favicon-home.svg" alt="" width="30" height="30"><span>MCP Docs</span></a>
  <nav class="site-links" aria-label="Sections"><a href="/features">Features</a><a href="/#agents">Agents</a><a href="/#web">Web version</a></nav>
  <div class="site-nav-cta">
    <a class="site-github" href="${GITHUB}" aria-label="MCP Docs on GitHub" title="MCP Docs on GitHub">${GITHUB_ICON}</a>
    <a class="site-btn primary" href="${GITHUB}/releases/latest">Download</a>
  </div>
</header>
<main>
${o.main}
<section class="site-final">
  <h2>Start editing with AI today</h2>
  <p>Free and open source, for Macs with Apple silicon and 64-bit Windows. Install the app and connect it to Claude Code and Codex in one step:</p>
  <pre class="site-code"><code>${NPX}</code></pre>
  <div class="site-cta"><a class="site-btn light big" href="${GITHUB}/releases/latest">Download MCP Docs</a><a class="site-btn outline big" href="/register">Try the web version (beta)</a></div>
</section>
</main>
<footer class="site-footer">
  <span>© ${new Date().getFullYear()} MCP Docs</span>
  <nav aria-label="About"><a href="/features">Features</a><a href="/llms.txt">llms.txt</a><a href="${GITHUB}">GitHub</a><a href="${GITHUB}/issues">Support</a></nav>
</footer>
</body>
</html>
`;
}

/** The boxes linking to other features, as on the front page. */
function cards(pages: FeaturePage[]): string {
  return `<div class="site-grid">${pages
    .map(
      (p) =>
        `<a class="site-card" href="/features/${p.slug}"><div class="site-shot"><img src="/marketing/${p.image}.webp" alt="${esc(p.alt)}" loading="lazy" width="1600" height="964"></div><h3>${esc(p.h1)}</h3><p>${esc(p.description)}</p></a>`,
    )
    .join('')}</div>`;
}

/** A page with the app's address in its text. */
const atOrigin = (p: FeaturePage, origin: string): FeaturePage => ({ ...p, lede: p.lede.replaceAll('{{origin}}', origin), rest: p.rest.replaceAll('{{origin}}', origin) });

/** A feature's page as HTML, or null when there is none by that name. */
export function featureHtml(slug: string, origin: string): string | null {
  const pages = featurePages();
  const found = pages.find((x) => x.slug === slug);
  if (!found) return null;
  const p = atOrigin(found, origin);
  const path = `/features/${p.slug}`;
  const others = pages.filter((x) => x !== found);
  const ld: unknown[] = [
    { ...APP(origin), '@id': `${origin}/#app` },
    {
      '@type': 'WebPage',
      '@id': `${origin}${path}`,
      url: `${origin}${path}`,
      name: p.title,
      description: p.description,
      primaryImageOfPage: imageUrl(origin, p),
      about: { '@id': `${origin}/#app` },
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'MCP Docs', item: `${origin}/` },
        { '@type': 'ListItem', position: 2, name: 'Features', item: `${origin}/features` },
        { '@type': 'ListItem', position: 3, name: p.h1, item: `${origin}${path}` },
      ],
    },
  ];
  if (p.faq.length) ld.push({ '@type': 'FAQPage', mainEntity: p.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
  const main = `<article class="site-article">
<nav class="site-crumbs" aria-label="Breadcrumb"><a href="/">MCP Docs</a> › <a href="/features">Features</a> › <span>${esc(p.h1)}</span></nav>
<h1>${esc(p.h1)}</h1>
<div class="site-lede">${marked.parse(p.lede, { async: false })}</div>
<div class="site-cta"><a class="site-btn primary big" href="${GITHUB}/releases/latest">Download for free</a><a class="site-btn ghost big" href="/register">Try it on the web</a></div>
<figure class="site-hero-shot"><img src="/marketing/${p.image}.webp" alt="${esc(p.alt)}" width="1600" height="964"></figure>
<div class="site-prose">${marked.parse(p.rest, { async: false })}</div>
</article>
${others.length ? `<section class="site-more"><h2>More of MCP Docs</h2>${cards(others)}</section>` : ''}`;
  return frame({ origin, path, title: `${p.title} | MCP Docs`, description: p.description, image: imageUrl(origin, p), markdown: `${path}.md`, ld, main });
}

/** A feature's page as Markdown, for agents: the file without its front matter, with its picture and the links an
 * agent needs (pictures and links absolute, since the text may be read away from the site). Null when there is none. */
export function featureMarkdown(slug: string, origin: string): string | null {
  const found = featurePages().find((x) => x.slug === slug);
  if (!found) return null;
  const p = atOrigin(found, origin);
  const others = featurePages().filter((x) => x !== found);
  return `# ${p.h1}

> ${p.description}

${p.lede}

![${p.alt}](${imageUrl(origin, p)})

${p.rest}

## Get MCP Docs

- Download the desktop app for macOS or Windows: ${GITHUB}/releases/latest
- Install it and add it to Claude Code and Codex: \`${NPX}\`
- The web version (beta): ${origin}/register
- How an agent connects to MCP Docs: ${origin}/llms.txt
${others.length ? `\n## Other features\n\n${others.map((x) => `- [${x.h1}](${origin}/features/${x.slug}.md): ${x.description}`).join('\n')}\n` : ''}`;
}

/** /features: every feature, as boxes. */
export function featuresIndexHtml(origin: string): string {
  const pages = featurePages();
  const ld = [
    { ...APP(origin), '@id': `${origin}/#app` },
    { '@type': 'CollectionPage', url: `${origin}/features`, name: 'MCP Docs features', hasPart: pages.map((p) => ({ '@type': 'WebPage', url: `${origin}/features/${p.slug}`, name: p.title })) },
  ];
  const main = `<section class="site-index">
<h1>One editor for every file</h1>
<p class="site-sub">Word, PowerPoint and Excel files, PDFs, Markdown and pictures, each with an AI assistant beside it and open to your agents over MCP.</p>
${cards(pages)}
</section>`;
  return frame({
    origin,
    path: '/features',
    title: 'Features | MCP Docs',
    image: `${origin}/marketing/og-image.jpg`,
    description: 'What MCP Docs edits: PowerPoint, Excel and Word files, PDFs, Markdown and pictures, with an AI assistant and an MCP server for Claude Code, Codex and other agents.',
    ld,
    main,
  });
}

/** The site's public pages for search engines. */
export function sitemapXml(origin: string): string {
  const urls = ['/', '/features', ...featurePages().map((p) => `/features/${p.slug}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(origin + u)}</loc></url>`).join('\n')}
</urlset>
`;
}

export function robotsTxt(origin: string): string {
  return `User-agent: *
Disallow: /api/
Disallow: /mcp
Disallow: /oauth/

Sitemap: ${origin}/sitemap.xml
`;
}
