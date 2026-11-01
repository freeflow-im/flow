// After `vite build`: dist/client/landing.html, the app's page with the front page already drawn in it
// (client/src/landingPrerender.tsx) and the head a search engine and a link preview read. The server sends it to
// visitors at / (server/app.ts), with the app's address where the mark is.
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const DIST = new URL('../dist/client/', import.meta.url);
const vite = await createServer({ configFile: new URL('../vite.config.ts', import.meta.url).pathname, server: { middlewareMode: true }, appType: 'custom', logLevel: 'warn' });
try {
  const { renderLanding, ORIGIN_MARK } = (await vite.ssrLoadModule('/src/landingPrerender.tsx')) as typeof import('../client/src/landingPrerender.tsx');
  const O = ORIGIN_MARK;
  const title = 'MCP Docs: a universal document editor for you and your AI agent';
  const description =
    'A free, open-source editor for Word, PowerPoint and Excel files, PDFs, Markdown and pictures, with a built-in AI assistant and an MCP server for Claude Code, Codex and other agents.';
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        '@id': `${O}/#app`,
        name: 'MCP Docs',
        url: `${O}/`,
        description,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'macOS, Windows, Web',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        downloadUrl: 'https://github.com/freeflow-im/mcp-docs/releases/latest',
        image: `${O}/marketing/og-image.jpg`,
      },
      { '@type': 'WebSite', name: 'MCP Docs', url: `${O}/` },
    ],
  };
  const head = `<title>${title}</title>
    <meta name="description" content="${description}" />
    <link rel="canonical" href="${O}/" />
    <link rel="alternate" type="text/markdown" href="${O}/llms.txt" title="MCP Docs for agents" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="MCP Docs" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${O}/" />
    <meta property="og:image" content="${O}/marketing/og-image.jpg" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="A presentation open in MCP Docs, with the assistant answering a question about it" />
    <meta name="twitter:card" content="summary_large_image" />
    <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
  const index = readFileSync(new URL('index.html', DIST), 'utf8');
  if (!index.includes('<title>MCP Docs</title>') || !index.includes('<div id="root"></div>')) throw new Error('dist/client/index.html is not the page this expects');
  const page = index.replace('<title>MCP Docs</title>', head).replace('<div id="root"></div>', `<div id="root">${renderLanding()}</div>`);
  writeFileSync(new URL('landing.html', DIST), page);
  console.log(`landing.html: ${page.length} bytes`);
} finally {
  await vite.close();
}
