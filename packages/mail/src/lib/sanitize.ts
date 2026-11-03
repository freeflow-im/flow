// A message's HTML is written by whoever sent it, so it is never put in the page as it is. It is cleaned with
// DOMPurify (no scripts, forms, frames, objects or event handlers), its remote images are held back until the reader
// asks for them (they tell the sender the message was read, and when, and from where), its cid: images point at the
// message's own attachments, and then it is shown in a sandboxed iframe without allow-scripts, under a Content
// Security Policy that only lets it load images the reader allowed (MessageBody.tsx). Each layer stands without the
// others: a script that slipped through DOMPurify still cannot run in the sandbox, and a remote image that slipped
// past the rewriting is still refused by the policy.
import createDOMPurify, { type DOMPurify } from 'dompurify';

export interface SanitizeOptions {
  /** Load remote (http, https and protocol-relative) images. */
  allowRemote: boolean;
  /** The URL for an attachment by its Content-ID (without the angle brackets), or null if there is none. */
  cidUrl?: (contentId: string) => string | null;
}

export interface SanitizedHtml {
  html: string;
  /** The message has remote images or backgrounds (whether or not they were allowed). */
  hasRemote: boolean;
}

const FORBID_TAGS = ['script', 'noscript', 'form', 'input', 'button', 'select', 'option', 'textarea', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'link', 'meta', 'portal', 'template', 'math', 'svg'];
const FORBID_ATTR = ['action', 'formaction', 'srcset', 'ping', 'http-equiv'];
const REMOTE = /^\s*(https?:)?\/\//i;
const CSS_REMOTE_URL = /url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\)/gi;

let purifier: DOMPurify | null = null;
let current: { options: SanitizeOptions; hasRemote: boolean } | null = null;

/** One DOMPurify of our own (hooks are per instance), with the hooks reading the call in progress. */
function instance(): DOMPurify {
  if (purifier) return purifier;
  const p = createDOMPurify(window);
  p.addHook('uponSanitizeElement', (node, data) => {
    // A <style> element's remote url()s (backgrounds, fonts): noted, and removed unless allowed.
    if (data.tagName === 'style' && current) {
      const css = node.textContent ?? '';
      if (CSS_REMOTE_URL.test(css)) {
        current.hasRemote = true;
        if (!current.options.allowRemote) node.textContent = css.replace(CSS_REMOTE_URL, 'none');
      }
      CSS_REMOTE_URL.lastIndex = 0;
    }
  });
  p.addHook('afterSanitizeAttributes', (node) => {
    if (!current) return;
    const el = node as Element;
    const { options } = current;
    if (el.tagName === 'A' && el.hasAttribute('href')) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
    if (el.tagName === 'IMG' || el.tagName === 'IMAGE') {
      const src = el.getAttribute('src') ?? '';
      if (/^cid:/i.test(src)) {
        const url = options.cidUrl?.(decodeURIComponent(src.slice(4)).replace(/^<|>$/g, ''));
        if (url) el.setAttribute('src', url);
        else el.removeAttribute('src');
      } else if (REMOTE.test(src)) {
        current.hasRemote = true;
        if (!options.allowRemote) {
          el.setAttribute('data-remote-src', src);
          el.removeAttribute('src');
        }
      }
    }
    // Old-fashioned table and body backgrounds.
    const background = el.getAttribute('background');
    if (background && REMOTE.test(background)) {
      current.hasRemote = true;
      if (!options.allowRemote) el.removeAttribute('background');
    }
    const style = el.getAttribute('style');
    if (style && CSS_REMOTE_URL.test(style)) {
      current.hasRemote = true;
      if (!options.allowRemote) el.setAttribute('style', style.replace(CSS_REMOTE_URL, 'none'));
    }
    CSS_REMOTE_URL.lastIndex = 0;
  });
  purifier = p;
  return p;
}

/** The message's HTML, cleaned as above, as the inside of a <body>. */
export function sanitizeEmailHtml(html: string, options: SanitizeOptions): SanitizedHtml {
  const p = instance();
  current = { options, hasRemote: false };
  try {
    const out = p.sanitize(html, {
      WHOLE_DOCUMENT: false,
      FORBID_TAGS,
      FORBID_ATTR,
      // Email's own style sheets stay: the sandbox and the policy decide what they may load.
      ADD_TAGS: ['style'],
      FORCE_BODY: true,
      ALLOW_DATA_ATTR: false,
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    });
    return { html: out, hasRemote: current.hasRemote };
  } finally {
    current = null;
  }
}

/** The Content Security Policy of the iframe's document: no scripts, nothing fetched but the images allowed. */
export function contentPolicy(allowRemote: boolean, origin: string): string {
  const images = ["'self'", origin, 'data:', 'blob:', ...(allowRemote ? ['https:', 'http:'] : [])].join(' ');
  return [
    "default-src 'none'",
    `img-src ${images}`,
    `style-src 'unsafe-inline'${allowRemote ? ' https:' : ''}`,
    `font-src data:${allowRemote ? ' https:' : ''}`,
    "script-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
  ].join('; ');
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The iframe's whole document (`srcdoc`) for a sanitized body. */
export function buildSrcdoc(body: string, allowRemote: boolean, origin: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttr(contentPolicy(allowRemote, origin))}"><base target="_blank"><style>html,body{margin:0;padding:0;background:#fff;color:#1f1f1f;font:14px/1.5 Inter,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;overflow-wrap:anywhere}body{padding:4px 2px 16px}img{max-width:100%;height:auto}img:not([src]){display:inline-block;min-width:16px;min-height:16px;background:#f1f3f4}a{color:#1a73e8}blockquote{margin:0 0 0 8px;padding-left:12px;border-left:3px solid #dadce0;color:#5f6368}pre{white-space:pre-wrap}table{max-width:100%}</style></head><body>${body}</body></html>`;
}

export type TextSegment = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

const LINK = /\b((?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)\]}]|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi;

/** A plain-text body split into text and links (web addresses and email addresses), for rendering as escaped text. */
export function linkify(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
    const t = m[0];
    const href = t.includes('@') && !/^(https?:|www\.)/i.test(t) ? `mailto:${t}` : /^www\./i.test(t) ? `https://${t}` : t;
    out.push({ kind: 'link', text: t, href });
    last = start + t.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Plain text as HTML (escaped, links made links, line breaks kept), for quoting a text message in a reply. */
export function textToHtml(text: string): string {
  return linkify(text)
    .map((s) => (s.kind === 'text' ? escapeHtml(s.text) : `<a href="${escapeHtml(s.href)}">${escapeHtml(s.text)}</a>`))
    .join('')
    .split(/\r?\n\r?\n/)
    .map((p) => `<p>${p.replace(/\r?\n/g, '<br>')}</p>`)
    .join('');
}
