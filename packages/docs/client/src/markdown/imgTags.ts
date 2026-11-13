// `<img>` tags in Markdown, as GitHub draws them: the one piece of raw HTML the preview shows, since Markdown's
// own `![alt](src)` cannot give a picture a size. Only the tag's src, alt, width, height and title are kept;
// any other HTML in the text is still not drawn. A pasted picture is written as one (pastedImage.ts).

interface Node {
  type: string;
  value?: string;
  children?: Node[];
  data?: { hName?: string; hProperties?: Record<string, string> };
}

const KEPT = new Set(['src', 'alt', 'width', 'height', 'title']);
const TAGS_RE = /^\s*(?:<img\b[^<>]*>\s*)+$/i;
const TAG_RE = /<img\b([^<>]*)>/gi;
const ATTR_RE = /([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/gi;

function decode(s: string): string {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|quot|apos|lt|gt));/gi, (m, dec: string, hex: string, name: string) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[name.toLowerCase()] ?? m;
  });
}

/** The pictures of a piece of HTML made only of `<img>` tags, with their kept attributes; null for any other HTML. */
export function parseImgTags(html: string): Record<string, string>[] | null {
  if (!TAGS_RE.test(html)) return null;
  return [...html.matchAll(TAG_RE)].map(([, attrs]) => {
    const props: Record<string, string> = {};
    for (const [, name, a, b, c] of attrs.matchAll(ATTR_RE)) {
      const key = name.toLowerCase();
      if (KEPT.has(key)) props[key] = decode(a ?? b ?? c ?? '');
    }
    return props;
  });
}

/** Marks a picture drawn from an `<img>` tag, so editing it in the preview writes it back as one (wysiwyg.ts). */
export const TAG_ATTR = 'data-md-tag';

/** A remark plugin: HTML that is only `<img>` tags becomes those pictures (their addresses are checked like any other). */
export function imgTags() {
  const walk = (node: Node) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      const pictures = child.type === 'html' && child.value ? parseImgTags(child.value) : null;
      if (!pictures) {
        walk(child);
        return [child];
      }
      return pictures.map((p) => ({ type: 'imgTag', data: { hName: 'img', hProperties: { ...p, [TAG_ATTR]: '' } } }));
    });
  };
  return walk;
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An `<img>` tag for a picture, its attributes in a fixed order. */
export function imgTag(props: { src: string; alt?: string; width?: string | number; height?: string | number; title?: string }): string {
  const attrs = (['src', 'alt', 'width', 'height', 'title'] as const).filter((k) => props[k] !== undefined && props[k] !== '').map((k) => `${k}="${escapeAttr(String(props[k]))}"`);
  return `<img ${attrs.join(' ')}>`;
}
