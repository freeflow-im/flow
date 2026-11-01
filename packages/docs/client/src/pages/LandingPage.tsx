// The hosted app's front page for visitors who are not signed in: what MCP Docs is, the promo video, a box for each
// kind of file it edits, and the ways in: the desktop app first, then the web version (in beta), whose sign-in and
// sign-up are their own pages (/login, /register). The pictures and video are in client/public/marketing (made from marketing/ at the repo root).
// A box whose feature has a page of its own (content/features, served by the server: server/marketing.ts) links to it.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { HomeIcon } from '../components/Logo.tsx';
import { appName } from '../brand.ts';

const GITHUB = 'https://github.com/freeflow-im/mcp-docs';
const RELEASES = `${GITHUB}/releases/latest`;

// The latest release's file for each system, named as desktop/updater.js finds them; until GitHub answers (or if it
// does not) the buttons go to the release's page.
type Platform = 'mac' | 'win';
const ASSETS: Record<Platform, RegExp> = { mac: /^MCP-Docs-[\d.]+-mac-arm64\.zip$/, win: /^MCP-Docs-[\d.]+-win-x64-setup\.exe$/ };

function useDownloads(): Record<Platform, string> {
  const [links, setLinks] = useState<Record<Platform, string>>({ mac: RELEASES, win: RELEASES });
  useEffect(() => {
    let live = true;
    fetch('https://api.github.com/repos/freeflow-im/mcp-docs/releases/latest')
      .then((r) => (r.ok ? r.json() : null))
      .then((release: { assets?: { name: string; browser_download_url: string }[] } | null) => {
        const url = (p: Platform) => release?.assets?.find((a) => ASSETS[p].test(a.name))?.browser_download_url ?? RELEASES;
        if (live) setLinks({ mac: url('mac'), win: url('win') });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return links;
}

const visitorOnWindows = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent);

function AppleIcon() {
  return (
    <svg className="landing-os" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 7.6c-1.3-1-2.8-1.2-4-.7C5.8 7.8 4.8 10.3 5.3 13.2c.5 3.1 2.3 6.6 4.2 7.1.9.3 1.6-.3 2.5-.3s1.6.6 2.5.3c1.9-.5 3.7-4 4.2-7.1.5-2.9-.5-5.4-2.7-6.3-1.2-.5-2.7-.3-4 .7ZM12.4 6.3c0-1.9 1.3-3.5 3.2-3.8 0 1.9-1.3 3.5-3.2 3.8Z"
      />
    </svg>
  );
}

function WindowsIcon() {
  return (
    <svg className="landing-os" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M3 5.1 10.4 4v7.4H3V5.1Zm8.4-1.2L21 2.5v8.9h-9.6V3.9ZM3 12.6h7.4V20L3 18.9v-6.3Zm8.4 0H21v8.9l-9.6-1.4v-7.5Z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

// The two download buttons, the visitor's own system first.
function DownloadButtons({ links, big, first, second }: { links: Record<Platform, string>; big?: boolean; first: string; second: string }) {
  const mac = (
    <a key="mac" className={`landing-btn ${big ? 'big ' : ''}${visitorOnWindows ? second : first}`} href={links.mac}>
      <AppleIcon />
      {big ? 'Download for macOS' : 'macOS'}
    </a>
  );
  const win = (
    <a key="win" className={`landing-btn ${big ? 'big ' : ''}${visitorOnWindows ? first : second}`} href={links.win}>
      <WindowsIcon />
      {big ? 'Download for Windows' : 'Windows'}
    </a>
  );
  return <>{visitorOnWindows ? [win, mac] : [mac, win]}</>;
}

const FEATURES: { image: string; title: string; text: string; alt: string; page?: string }[] = [
  {
    image: 'slides',
    title: 'Presentations',
    page: 'presentations',
    text: 'Open and save PowerPoint files. Diagrams, tables, charts, videos and themes, then present right from the browser.',
    alt: 'A presentation on multi-head attention, with a diagram of eight attention heads',
  },
  {
    image: 'spreadsheet',
    page: 'spreadsheets',
    title: 'Spreadsheets',
    text: 'Excel files with formulas, filters, charts and formatting. Ask the assistant to sort, clean up or fill in the data.',
    alt: 'A spreadsheet of recent YC companies with their batch, industry and website',
  },
  {
    image: 'document',
    page: 'documents',
    title: 'Documents',
    text: 'Word documents with headings, pictures and video. Write them yourself, or have an agent draft and edit them.',
    alt: 'A document with a story and a picture of a corgi surfing beside a cat on a jet ski',
  },
  {
    image: 'markdown',
    page: 'markdown',
    title: 'Markdown',
    text: 'GitHub-flavored Markdown with a live preview beside the text, and Mermaid diagrams drawn as you type.',
    alt: 'A Markdown summary of a paper, its text on the left and the formatted preview on the right',
  },
  {
    image: 'pdf',
    title: 'PDFs',
    page: 'pdfs',
    text: 'Read, sign and fill in PDFs. Turn any PDF, scanned pages included, into Markdown your agents can work with.',
    alt: 'A PDF open in the viewer with its page thumbnails and a Convert to Markdown button',
  },
  {
    image: 'image',
    page: 'images',
    title: 'Images',
    text: 'Crop, draw, add text, adjust colors and stack layers. Or just ask: the assistant can remove a background in one step.',
    alt: 'A photo of a running dog in the image editor, its background removed by the assistant',
  },
];

/** `origin` is the app's address; the copy rendered when the app is built (`landingPrerender.tsx`) is given a mark the
 * server replaces. */
export function LandingPage({ origin = window.location.origin }: { origin?: string }) {
  const name = appName();
  const mcpUrl = `${origin}/mcp/v2`;
  const downloads = useDownloads();
  return (
    <div className="landing">
      <header className="landing-nav">
        <Link to="/" className="landing-logo">
          <HomeIcon size={30} />
          <span>{name}</span>
        </Link>
        <nav className="landing-links" aria-label="Sections">
          <a href="#features">Features</a>
          <a href="#agents">Agents</a>
          <a href="#web">Web version</a>
        </nav>
        <div className="landing-nav-cta">
          <a className="landing-github" href={GITHUB} target="_blank" rel="noreferrer" aria-label="MCP Docs on GitHub" title="MCP Docs on GitHub">
            <GitHubIcon />
          </a>
          <DownloadButtons links={downloads} first="ghost" second="ghost" />
        </div>
      </header>

      <main>
        <section className="landing-hero">
          <p className="landing-eyebrow">Office files, PDFs, Markdown and more</p>
          <h1>
            A universal document editor,
            <br />
            <span className="landing-grad">built for you and your agent.</span>
          </h1>
          <p className="landing-lede">
            One app for Word, PowerPoint and Excel files, PDFs, Markdown, web pages and pictures. Every file is open to your AI agents over MCP: connect
            Claude Code, Codex or any MCP client, or ask the built-in assistant, and watch it work on the same files you do.
          </p>
          <pre className="landing-code landing-npx">
            <code>npx @freeflow-im/mcp-docs</code>
          </pre>
          <div className="landing-cta">
            <DownloadButtons links={downloads} big first="primary" second="dark" />
          </div>
          <p className="landing-fine">
            Free and open source. For Macs with Apple silicon and 64-bit Windows. Or <a href="#web">try it on the web</a> (beta).
          </p>
          <div className="landing-video">
            <video src="/marketing/promo.mp4" poster="/marketing/promo-poster.webp" controls playsInline preload="metadata" aria-label={`${name} in action: editing a spreadsheet, a presentation and a PDF with the assistant`} />
          </div>
        </section>

        <section className="landing-formats" aria-label="File types">
          {['Word', 'PowerPoint', 'Excel', 'PDF', 'Markdown', 'CSV', 'HTML', 'Images', 'Video'].map((f) => (
            <span key={f}>{f}</span>
          ))}
        </section>

        <section className="landing-section" id="features">
          <h2>One editor for every file</h2>
          <div className="landing-grid">
            {FEATURES.map((f) => {
              const body = (
                <>
                  <div className="landing-shot">
                    <img src={`/marketing/${f.image}.webp`} alt={f.alt} loading="lazy" width="1600" height="964" />
                  </div>
                  <h3>{f.title}</h3>
                  <p>{f.text}</p>
                  {f.page && <span className="landing-more">Learn more →</span>}
                </>
              );
              // The pages are the server's, not the app's routes: a plain link loads them.
              return f.page ? (
                <a key={f.image} className="landing-card" href={`/features/${f.page}`}>
                  {body}
                </a>
              ) : (
                <article key={f.image} className="landing-card">
                  {body}
                </article>
              );
            })}
          </div>
        </section>

        <section className="landing-section landing-agents" id="agents">
          <h2>Built for agents, not just people</h2>
          <p className="landing-sub">
            Two ways to put AI to work on your files. Every change shows up live, and every change can be undone.{' '}
            <a className="landing-more-link" href="/features/ai-agents">
              More on MCP Docs for agents →
            </a>
          </p>
          <div className="landing-pair">
            <div className="landing-panel">
              <h3>The built-in assistant</h3>
              <p>
                Open the assistant beside any file and ask: “sort by location”, “turn this paper into slides”, “make the button blue”. It reads the file, makes the
                edits and shows you each step. Use ours, or your own Anthropic, OpenAI or OpenRouter key.
              </p>
            </div>
            <div className="landing-panel">
              <h3>Your agent, over MCP</h3>
              <p>Connect Claude Code, Codex, Cursor or any MCP client. It can open, read, create and edit your documents while you watch.</p>
              <pre className="landing-code">
                <code>claude mcp add --transport http universal-docs {mcpUrl}</code>
              </pre>
            </div>
          </div>
        </section>

        <section className="landing-section landing-desktop" id="web">
          <div>
            <h2>
              Also on the web <span className="landing-beta">Beta</span>
            </h2>
            <p className="landing-sub">
              Nothing to install: your files are kept in your account, and the built-in assistant and your agents work on them from anywhere. The web version is
              in beta, so expect some rough edges.
            </p>
          </div>
          <div className="landing-desktop-cta">
            <div className="landing-row">
              <Link to="/register" className="landing-btn primary big">
                Sign up for free
              </Link>
              <Link to="/login" className="landing-btn ghost big">
                Sign in
              </Link>
            </div>
          </div>
        </section>

        <section className="landing-final">
          <h2>Start editing with AI today</h2>
          <p>Download the app, or install it and connect it to Claude Code and Codex in one step:</p>
          <pre className="landing-code landing-npx">
            <code>npx @freeflow-im/mcp-docs</code>
          </pre>
          <div className="landing-cta">
            <DownloadButtons links={downloads} big first="light" second="outline" />
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <span>
          © {new Date().getFullYear()} {name}
        </span>
        <nav aria-label="About">
          <a href={GITHUB} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href={`${GITHUB}/issues`} target="_blank" rel="noreferrer">
            Support
          </a>
        </nav>
      </footer>
    </div>
  );
}
