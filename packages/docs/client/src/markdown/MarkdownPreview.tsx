// The rendered side of a Markdown document: GitHub-flavored Markdown (tables, task lists, strikethrough,
// autolinks) in GitHub's styles. Raw HTML in the text is not rendered, and unsafe link targets are dropped.
// Front matter at the top is shown as-is instead of being mistaken for a heading. A ```mermaid code block is
// drawn as its diagram when the page gives a way to load Mermaid (MermaidDiagram.tsx). Given the document's
// folder, a picture named by a relative path is read from it (imagePaths.ts).
import { isValidElement, memo, useMemo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import 'github-markdown-css/github-markdown-light.css';
import { frontMatterAsCode } from './frontMatter.ts';
import { imgTags } from './imgTags.ts';
import { imageSrc, SOURCE_ATTR, type ImageRoot } from './imagePaths.ts';
import { MermaidDiagram, type MermaidLoader } from './MermaidDiagram.tsx';

export const PLUGINS = [remarkFrontmatter, remarkGfm, frontMatterAsCode, imgTags];

/** The text of a code block that is written in Mermaid, or null for any other block. */
function mermaidCode(children: ReactNode): string | null {
  const code = Array.isArray(children) ? children.find((c) => isValidElement(c)) : children;
  if (!isValidElement<{ className?: string; children?: ReactNode }>(code) || !/\blanguage-mermaid\b/.test(code.props.className ?? '')) return null;
  const text = code.props.children;
  return typeof text === 'string' ? text : Array.isArray(text) ? text.join('') : null;
}

/**
 * How the preview draws diagrams and pictures. An editable preview (WysiwygPreview.tsx) also keeps each picture's
 * address as written (SOURCE_ATTR), so its HTML reads back as the same Markdown, and lets task boxes be ticked.
 */
export function usePreviewComponents(loadMermaid: MermaidLoader | undefined, folder: string | undefined, root?: ImageRoot, editable = false): Components {
  return useMemo<Components>(
    () => ({
      ...(loadMermaid && {
        pre: ({ node: _node, children, ...rest }) => {
          const code = mermaidCode(children);
          return code === null ? <pre {...rest}>{children}</pre> : <MermaidDiagram code={code.trim()} load={loadMermaid} />;
        },
      }),
      ...((folder !== undefined || editable) && {
        img: ({ node: _node, src, ...rest }) => {
          const written = typeof src === 'string' ? src : undefined;
          return <img {...rest} src={folder === undefined ? written : imageSrc(written, folder, root)} {...(editable && { [SOURCE_ATTR]: written })} />;
        },
      }),
      ...(editable && {
        input: ({ node: _node, disabled: _disabled, checked, ...rest }) => <input {...rest} defaultChecked={checked} />,
      }),
    }),
    [loadMermaid, folder, root, editable],
  );
}

export const MarkdownPreview = memo(function MarkdownPreview({ text, loadMermaid, folder, root }: {
  text: string;
  /** How to load Mermaid; without it a diagram's code block stays code. */
  loadMermaid?: MermaidLoader;
  /** The document's folder, which relative picture paths are read from; without it they are left as written. */
  folder?: string;
  /** The root the document is in, which those pictures are read from too. */
  root?: ImageRoot;
}) {
  const components = usePreviewComponents(loadMermaid, folder, root);
  return (
    <article className="markdown-body md-preview-body">
      {text.trim() === '' ? (
        <p className="md-preview-empty">Nothing to preview yet. Start typing Markdown on the left.</p>
      ) : (
        <ReactMarkdown remarkPlugins={PLUGINS} components={components}>
          {text}
        </ReactMarkdown>
      )}
    </article>
  );
});
