// Assistant chat replies rendered as GitHub-flavored Markdown. Display only: raw HTML is never rendered,
// link targets with unsafe schemes are dropped (react-markdown's default URL check), remote images are not
// loaded (their alt text is shown), and links open in a new tab without access to this page.
// Partial Markdown while a reply streams in simply renders as far as it parses.
import { memo, type ComponentProps } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const PLUGINS = [remarkGfm];

const COMPONENTS: Components = {
  a: ({ node: _node, href, children, ...rest }: ComponentProps<'a'> & { node?: unknown }) =>
    href ? (
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span className="agent-md-img">{alt ? `[${alt}]` : '[image]'}</span>,
  table: ({ node: _node, ...props }) => (
    <div className="agent-md-table">
      <table {...props} />
    </div>
  ),
};

/** Keep only http(s), mailto and relative link targets. */
export function chatUrl(url: string): string {
  const safe = defaultUrlTransform(url);
  if (!safe) return '';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(safe)?.[1]?.toLowerCase();
  return !scheme || scheme === 'http' || scheme === 'https' || scheme === 'mailto' ? safe : '';
}

export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="agent-md">
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS} urlTransform={chatUrl} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
