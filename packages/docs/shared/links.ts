// Hyperlinks in cells: plain-text http(s) URLs and =HYPERLINK(url, [label]) formulas.

/** A cell whose whole text is an http(s) URL is shown as a link. */
const AUTO_LINK_RE = /^https?:\/\/[^\s/?#]+[^\s]*$/i;
const SAFE_LINK_RE = /^(https?:\/\/[^\s/?#]+[^\s]*|mailto:[^\s]+)$/i;

/** The URL if `s` is a link the app may open (http, https or mailto), otherwise null. */
export function safeLinkUrl(s: string): string | null {
  const t = s.trim();
  return SAFE_LINK_RE.test(t) ? t : null;
}

/** The URL if a plain-text cell value is a full http(s) URL, otherwise null. */
export function autoLinkUrl(text: string): string | null {
  const t = text.trim();
  return AUTO_LINK_RE.test(t) ? t : null;
}

/** A HYPERLINK formula that shows `label` (or the URL) and links to `url`. */
export function hyperlinkFormula(url: string, label?: string): string {
  const q = (s: string) => '"' + s.replace(/"/g, '""') + '"';
  return label === undefined || label === '' ? `=HYPERLINK(${q(url)})` : `=HYPERLINK(${q(url)}, ${q(label)})`;
}
