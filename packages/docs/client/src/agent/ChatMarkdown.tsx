// Assistant chat replies rendered as GitHub-flavored Markdown. Display only: raw HTML is never rendered,
// link targets with unsafe schemes are dropped (react-markdown's default URL check), and links open in a new tab
// without access to this page. A picture loads only from the app itself (a relative address: an attached or stored
// picture) or from an address an image_search in the same chat returned (`pictures`, from picturesOf): a reply cannot
// be made to send data elsewhere in a picture's address. Any other picture shows as a link with its title.
// Partial Markdown while a reply streams in simply renders as far as it parses.
import { memo, useMemo, type ComponentProps } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatItem } from '../../../shared/agent/protocol.ts';

const PLUGINS = [remarkGfm];

/** An address as the browser would request it, so the same picture matches however it was written. */
const canon = (url: string): string => {
  try {
    return new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.origin).href;
  } catch {
    return url;
  }
};

/** The pictures the image searches in a chat found, by address: the ones a reply may show (ChatMarkdown's `pictures`). */
export function picturesOf(items: readonly ChatItem[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const it of items) {
    if (it.kind !== 'tool' || it.name !== 'image_search' || it.status !== 'ok' || !it.result) continue;
    try {
      const r = JSON.parse(it.result) as { results?: { image_url?: unknown }[] };
      for (const x of r.results ?? []) if (typeof x.image_url === 'string') out.add(canon(x.image_url));
    } catch {
      // Not a result this version can read: nothing to show.
    }
  }
  return out;
}

const NO_PICTURES: ReadonlySet<string> = new Set();

const components = (pictures: ReadonlySet<string>): Components => ({
  a: ({ node: _node, href, children, ...rest }: ComponentProps<'a'> & { node?: unknown }) =>
    href ? (
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ src, alt }) => {
    const url = typeof src === 'string' ? src : '';
    const label = alt ? `[${alt}]` : '[image]';
    if (!url) return <span className="agent-md-img">{label}</span>;
    const own = url.startsWith('/') && !url.startsWith('//');
    if (own || pictures.has(canon(url))) {
      return (
        <a className="agent-md-picture" href={url} target="_blank" rel="noopener noreferrer">
          <img src={url} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />
        </a>
      );
    }
    return (
      <a className="agent-md-img" href={url} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  },
  table: ({ node: _node, ...props }) => (
    <div className="agent-md-table">
      <table {...props} />
    </div>
  ),
});

/** Keep only http(s), mailto and relative link targets. */
export function chatUrl(url: string): string {
  const safe = defaultUrlTransform(url);
  if (!safe) return '';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(safe)?.[1]?.toLowerCase();
  return !scheme || scheme === 'http' || scheme === 'https' || scheme === 'mailto' ? safe : '';
}

export const ChatMarkdown = memo(function ChatMarkdown({ text, pictures = NO_PICTURES }: { text: string; /** Addresses of pictures the reply may load (picturesOf). */ pictures?: ReadonlySet<string> }) {
  const comps = useMemo(() => components(pictures), [pictures]);
  return (
    <div className="agent-md">
      <ReactMarkdown remarkPlugins={PLUGINS} components={comps} urlTransform={chatUrl} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** Opens a picture full size in a new tab: through a blob address, since browsers refuse to open a data: address. */
function openPicture(src: string): void {
  void fetch(src)
    .then((r) => r.blob())
    .then((b) => window.open(URL.createObjectURL(b), '_blank', 'noopener'));
}

/** The pictures a tool took for the person to see (a browser screenshot, SHOWN_PICTURE_TOOLS), under its line in the chat. */
export function ToolPictures({ images }: { images?: string[] }) {
  if (!images?.length) return null;
  return (
    <div className="agent-tool-pictures" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
      {images.map((src, i) => (
        <button key={i} type="button" onClick={() => openPicture(src)} title="Open full size" style={{ padding: 0, border: '1px solid #dadce0', borderRadius: 8, background: 'none', cursor: 'zoom-in', overflow: 'hidden', alignSelf: 'flex-start', maxWidth: '100%' }} data-testid="tool-picture">
          <img src={src} alt="A screenshot the assistant took" style={{ display: 'block', maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }} />
        </button>
      ))}
    </div>
  );
}
