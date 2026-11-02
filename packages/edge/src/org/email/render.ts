// Markdown → sanitized, inline-styled HTML for community broadcast emails
// (#481). Server-side and server-side only: the web composer's Preview tab
// calls POST /v1/workspaces/:id/email/preview, which runs *this* function, so
// what an admin previews and what recipients receive cannot drift apart.
//
// Email clients strip <style> blocks and <head>, so every rule here is an
// inline attribute on the element it styles. The sanitizer runs AFTER the
// renderer (never before — sanitizing markdown source is meaningless) and is
// allow-list based: anything not named below is dropped.
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

/** Inline styles applied to the rendered tags, since email clients ignore CSS. */
const INLINE: Record<string, string> = {
  h1: 'margin:0 0 12px;font-size:24px;line-height:1.25;font-weight:700;color:#111827',
  h2: 'margin:20px 0 10px;font-size:20px;line-height:1.3;font-weight:700;color:#111827',
  h3: 'margin:18px 0 8px;font-size:16px;line-height:1.35;font-weight:700;color:#111827',
  p: 'margin:0 0 14px;font-size:15px;line-height:1.6;color:#1f2937',
  // `list-style` is spelled out rather than left to the default: the Preview
  // tab renders this inside the web app, whose CSS reset strips list markers,
  // so a list without it previewed as unbulleted lines while the real email
  // showed bullets — the one thing this tab exists to prevent.
  ul: 'margin:0 0 14px;padding-left:22px;list-style:disc;font-size:15px;line-height:1.6;color:#1f2937',
  ol: 'margin:0 0 14px;padding-left:22px;list-style:decimal;font-size:15px;line-height:1.6;color:#1f2937',
  li: 'margin:0 0 6px',
  a: 'color:#4f46e5;text-decoration:underline',
  code: 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#f3f4f6;padding:1px 4px;border-radius:4px',
  pre: 'margin:0 0 14px;padding:12px;background:#f3f4f6;border-radius:8px;overflow-x:auto;font-size:13px',
  blockquote: 'margin:0 0 14px;padding:2px 0 2px 14px;border-left:3px solid #e5e7eb;color:#4b5563',
  img: 'max-width:100%;height:auto;border-radius:8px;display:block',
  hr: 'border:0;border-top:1px solid #e5e7eb;margin:20px 0',
  table: 'border-collapse:collapse;margin:0 0 14px;font-size:14px',
  th: 'border:1px solid #e5e7eb;padding:6px 10px;text-align:left;background:#f9fafb',
  td: 'border:1px solid #e5e7eb;padding:6px 10px',
};

/**
 * Is this an image source a mail client can actually fetch? Only an absolute
 * http(s) URL is — a relative `/logo.png` has nothing to resolve against once
 * the message is in an inbox, and `allowProtocolRelative` catches `//host` but
 * not that. Pasted images (#492) always carry an absolute URL from the server,
 * so this only bites markdown someone typed by hand; a dropped image is a
 * better answer than a broken one.
 */
function fetchableImageSrc(src: string | undefined): boolean {
  return typeof src === 'string' && /^https?:\/\//i.test(src);
}

/**
 * Render the admin's markdown to the email's inner HTML: sanitized, styled,
 * without the shell. Exported for tests; production goes through
 * `renderBroadcastEmailHtml`.
 */
export function renderMarkdownToEmailHtml(markdown: string): string {
  // `marked` is synchronous with these options; the async overload is only
  // reachable via async extensions, which we don't register.
  const raw = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string;
  return sanitizeHtml(raw, {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'p', 'br', 'hr',
      'strong', 'b', 'em', 'i', 'del', 's',
      'code', 'pre', 'blockquote',
      'ul', 'ol', 'li',
      'a', 'img',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    allowedAttributes: {
      // target/rel are set by the transform below, so they must be allowed
      // here or the sanitizer strips them straight back off.
      a: ['href', 'title', 'style', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'style'],
      '*': ['style'],
    },
    // http/https only: no javascript:, no data: payloads smuggled into an <a>.
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https'], a: ['http', 'https', 'mailto'] },
    // A relative src/href in an email has nothing to resolve against, and is
    // the shape a protocol-relative bypass takes — drop them.
    allowProtocolRelative: false,
    // Only the styles we set ourselves survive; an author-supplied style
    // attribute is dropped rather than merged (position/background tricks).
    allowedStyles: {},
    transformTags: {
      ...Object.fromEntries(
        Object.entries(INLINE).map(([tag, style]) => [tag, sanitizeHtml.simpleTransform(tag, { style })]),
      ),
      // Links leave the mail client; name the target and disown the opener.
      a: sanitizeHtml.simpleTransform('a', { style: INLINE.a!, target: '_blank', rel: 'noopener noreferrer' }),
    },
    // Text inside a stripped tag is kept (so <script>alert(1)</script> would
    // leave "alert(1)" behind) — for these it is markup, not prose.
    nonTextTags: ['script', 'style', 'textarea', 'noscript', 'iframe', 'title'],
    // Drop the whole <img> rather than emit one with no usable src — an image
    // element that cannot load is the broken-picture icon, which is worse in a
    // mail client than the image simply not being there.
    exclusiveFilter: (frame: { tag: string; attribs: Record<string, string> }) => frame.tag === 'img' && !fetchableImageSrc(frame.attribs.src),
  });
}

/** Escape for interpolation into the shell's own markup (subject, footer). */
function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * The full email document: rendered body + the attribution footer. The
 * from-address is a noreply, so the footer is the only way a recipient can
 * tell who sent this and why they got it.
 */
export function renderBroadcastEmailHtml(args: {
  markdown: string;
  senderName: string;
  workspaceName: string;
}): string {
  const body = renderMarkdownToEmailHtml(args.markdown);
  const footer = `— Sent by ${esc(args.senderName)} to all members of the ${esc(args.workspaceName)} workspace on Flow.`;
  return [
    '<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6">',
    '<div style="max-width:600px;margin:0 auto;padding:24px;background:#ffffff;',
    'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;color:#1f2937">',
    body,
    '<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0 12px">',
    `<p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280;font-style:italic">${footer}</p>`,
    '</div></body></html>',
  ].join('');
}

/** Plain-text alternative: the markdown source, with the same footer appended. */
export function renderBroadcastEmailText(args: {
  markdown: string;
  senderName: string;
  workspaceName: string;
}): string {
  return `${args.markdown}\n\n— Sent by ${args.senderName} to all members of the ${args.workspaceName} workspace on Flow.\n`;
}
