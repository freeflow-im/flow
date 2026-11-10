// The earlier messages quoted at the end of a message: what the sender's mail app put under what they wrote. Found
// here so both the message read (MessageBody.tsx) and the composer (ComposeForm.tsx) can fold it behind "⋯", as Gmail
// does, so the reply itself, and the Send button, stay in view. Each app marks its quote its own way: Gmail with a
// div.gmail_quote, Apple Mail with blockquote[type=cite], Outlook with an <hr> and div#divRplyFwdMsg, Thunderbird with
// div.moz-cite-prefix, Yahoo with div.yahoo_quoted, and this app (and many others) with an "On <date>, <who> wrote:"
// line followed by a blockquote.

/** The attribution line a quote starts with, in a line of text. */
const ATTRIBUTION = /^\s*(on\s.{0,400}?wrote:|-{2,}\s*original message\s*-{2,}|-{2,}\s*forwarded message\s*-{2,}|from:\s.{0,300}(sent|date):)/is;

const MARKERS = 'div.gmail_quote, blockquote[type="cite"], div#divRplyFwdMsg, div.yahoo_quoted, div.moz-cite-prefix, div[id^="appendonsend"], div.protonmail_quote';

/** Whether an element's text is an attribution line (short, and starting as one). */
function isAttribution(el: Element | null): el is Element {
  if (!el) return false;
  const text = (el.textContent ?? '').trim();
  return text.length <= 500 && ATTRIBUTION.test(text);
}

const isElement = (n: Node | null): n is Element => !!n && n.nodeType === Node.ELEMENT_NODE;
/** A bare text node that is an attribution line. */
const isAttributionText = (n: Node | null): n is Text => !!n && n.nodeType === Node.TEXT_NODE && ATTRIBUTION.test((n.textContent ?? '').trim());

/** Whether a node is blank: whitespace text, a <br>, or an element with no text and no picture. */
function isBlank(n: Node): boolean {
  if (n.nodeType === Node.TEXT_NODE) return !(n.textContent ?? '').trim();
  if (!isElement(n)) return true;
  return n.tagName === 'BR' || (!(n.textContent ?? '').trim() && !n.querySelector('img') && n.tagName !== 'HR');
}

/** The previous sibling that says something (not blank). */
function previous(node: Node): Node | null {
  let n = node.previousSibling;
  while (n && isBlank(n)) n = n.previousSibling;
  return n;
}

/**
 * The node the quoted part starts at (it and everything after it in the document is the quote), or null when the
 * message has no quote, or (unless `allowEmptyHead`, for a reply not written yet) is nothing but one, when there is
 * nothing to fold it behind.
 */
export function quoteStart(root: Element, allowEmptyHead = false): Node | null {
  const doc = root.ownerDocument;
  let start: Node | null = null;
  const marker = root.querySelector(MARKERS);
  if (marker) {
    start = marker;
    const before = previous(marker);
    // Outlook's rule above the header; Apple Mail's and Gmail's "On … wrote:" line before the quote itself.
    if (isElement(before) && (before.tagName === 'HR' || isAttribution(before))) start = before;
    else if (isAttributionText(before)) start = before;
  } else {
    // A plain blockquote after an attribution line, as this app writes replies.
    for (const bq of root.querySelectorAll('blockquote')) {
      const before = previous(bq);
      if ((isElement(before) && isAttribution(before)) || isAttributionText(before)) {
        start = before;
        break;
      }
    }
    if (!start) {
      // An attribution line on its own (a quoted plain-text message, say) counts when something follows it.
      for (const el of root.querySelectorAll('p, div')) {
        if (!el.querySelector('p, div, blockquote') && isAttribution(el) && (el.nextElementSibling || el.nextSibling?.textContent?.trim())) {
          start = el;
          break;
        }
      }
    }
  }
  if (!start) return null;
  if (allowEmptyHead) return start;
  // Something must come before it, or the whole message would be folded away.
  const range = doc.createRange();
  range.setStart(root, 0);
  range.setEndBefore(start);
  const head = range.cloneContents();
  if (!(head.textContent ?? '').trim() && !head.querySelector('img')) return null;
  return start;
}

/**
 * Marks the quoted part of a sanitized body with `data-quoted` on every node of it, so a style sheet can hide it. Text
 * nodes get wrapped in a span to carry the attribute. Returns the marked HTML and whether anything was marked.
 */
export function markQuote(html: string): { html: string; quoted: boolean } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.body;
  const start = quoteStart(root);
  if (!start) return { html, quoted: false };
  const nodes: Node[] = [];
  // From the start to the end of the document, in order: the start and its following siblings, then the following
  // siblings of each ancestor up to the root.
  for (let n: Node | null = start; n; n = climb(n, root)) for (let s: Node | null = n; s; s = s.nextSibling) nodes.push(s);
  for (const n of nodes) {
    if (n.nodeType === Node.ELEMENT_NODE) (n as Element).setAttribute('data-quoted', '');
    else if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim()) {
      const span = doc.createElement('span');
      span.setAttribute('data-quoted', '');
      n.parentNode?.replaceChild(span, n);
      span.appendChild(n);
    }
  }
  return { html: root.innerHTML, quoted: true };
}

/** The next sibling of the nearest ancestor of `node` (below `root`) that has one. */
function climb(node: Node, root: Node): Node | null {
  for (let p: Node | null = node.parentNode; p && p !== root; p = p.parentNode) if (p.nextSibling) return p.nextSibling;
  return null;
}

/**
 * A composer's starting HTML split into what is written above the quote and the quote itself, when the quote starts
 * at the top level (as this app's replies do), so the editor can hold the first and keep the second aside until asked.
 */
export function splitQuote(html: string): { head: string; quote: string } | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.body;
  const start = quoteStart(root, true);
  if (!start || start.parentNode !== root) return null;
  const range = doc.createRange();
  range.setStart(root, 0);
  range.setEndBefore(start);
  const head = doc.createElement('div');
  head.appendChild(range.cloneContents());
  range.setStartBefore(start);
  range.setEnd(root, root.childNodes.length);
  const quote = doc.createElement('div');
  quote.appendChild(range.cloneContents());
  return { head: head.innerHTML, quote: quote.innerHTML };
}

/** Quoted HTML as plain text, the way the editor renders text (a blank line between blocks), for a message's text part. */
export function quoteText(html: string): string {
  const doc = new DOMParser().parseFromString(
    html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|blockquote|tr|pre)>/gi, '\n\n'),
    'text/html',
  );
  return (doc.body.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * A plain-text body split at its quote: the "On … wrote:" line, or the first line beginning with ">", and all that
 * follows. Null when there is no quote or nothing before it.
 */
export function splitQuotedText(text: string): { head: string; quote: string } | null {
  const lines = text.split(/\r?\n/);
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (ATTRIBUTION.test(line) && lines.slice(i + 1).some((l) => l.trim())) {
      at = i;
      break;
    }
    if (/^\s*>/.test(line)) {
      // The attribution may sit a line or two above the first ">" line.
      at = i;
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        if (!lines[j]!.trim()) continue;
        if (ATTRIBUTION.test(lines[j]!)) at = j;
        break;
      }
      break;
    }
  }
  if (at <= 0) return null;
  const head = lines.slice(0, at).join('\n');
  if (!head.trim()) return null;
  return { head: head.replace(/\s+$/, ''), quote: lines.slice(at).join('\n') };
}
