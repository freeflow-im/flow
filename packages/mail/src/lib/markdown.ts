// Markdown the assistant wrote, as the HTML the composer's editor starts with (draft_mail_reply). The same conversion
// as the server's create_mail_draft (packages/edge/src/imap/mailText.ts markdownToHtml): raw HTML in it is shown as
// text, never passed through, and the result is cleaned to the tags a message may carry.
import DOMPurify from 'dompurify';
import { marked } from 'marked';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TAGS = ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];

export function markdownToHtml(markdown: string): string {
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: true, renderer }) as string;
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan'], ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i });
}
