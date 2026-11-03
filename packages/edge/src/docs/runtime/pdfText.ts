// A PDF's text as Markdown, with pdf.js, in place of LiteParse (which cannot load on Workers: cloudflare-spikes.md).
// pdf.js gives each run of text with its position and size; this puts the runs back into lines, the lines into
// paragraphs, headings (larger than the body text) and list items, and leaves out running headers, footers and page
// numbers. Links keep their address. Tables come out as lines of text, and pictures are left out. A page that is a
// picture of text (a scan) has no text here: reading it needs OCR, which does not run on Workers.
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

// Loaded when first needed, so that a request that reads no PDF does not pay for it. Its worker runs in this thread.
let loading: Promise<PdfJs> | null = null;
function pdfjs(): Promise<PdfJs> {
  loading ??= (async () => {
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs');
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return (await import('pdfjs-dist/legacy/build/pdf.min.mjs')) as unknown as PdfJs;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

export class PdfReadError extends Error {
  readonly reason: 'password' | 'damaged';
  constructor(message: string, reason: 'password' | 'damaged') { super(message); this.reason = reason; }
}

export interface PdfText {
  /** Markdown of each page read, in order; '' for a page with no text. */
  pages: string[];
  totalPages: number;
  /** Pages (1-based) with no text: blank, or scans. */
  emptyPages: number[];
}

interface Run { text: string; x: number; y: number; width: number; size: number; link?: string }
interface Line { text: string; x: number; y: number; right: number; size: number }

const round = (n: number) => Math.round(n * 2) / 2;
const BULLET = /^[•●◦▪▫■□‣⁃∙·\-–—*\uf0b7\uf0a7\uf076\uf0d8]\s*/u;
const NUMBERED = /^(\d{1,3})[.)]\s+/;
/** A numbered section, "4.2 Rail.", starts a paragraph of its own. */
const SECTION = /^\d{1,3}(\.\d{1,3})+\.?\s+\p{Lu}/u;
const PAGE_NUMBER = /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i;

/** The runs of one page: its text with positions, each link's address on the runs it covers. */
async function readRuns(doc: PDFDocumentProxy, n: number): Promise<Run[]> {
  const page = await doc.getPage(n);
  try {
    const [content, annotations] = await Promise.all([page.getTextContent(), page.getAnnotations({ intent: 'display' }).catch(() => [])]);
    const links = (annotations as { subtype?: string; url?: string; rect?: number[] }[])
      .filter((a) => a.subtype === 'Link' && a.url && /^(https?|mailto):/i.test(a.url) && a.rect?.length === 4)
      .map((a) => ({ url: a.url!, x1: Math.min(a.rect![0], a.rect![2]), x2: Math.max(a.rect![0], a.rect![2]), y1: Math.min(a.rect![1], a.rect![3]), y2: Math.max(a.rect![1], a.rect![3]) }));
    const runs: Run[] = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str) continue;
      const [, , c, d, x, y] = item.transform as number[];
      const size = Math.hypot(c, d) || item.height || 1;
      const cx = x + item.width / 2, cy = y + size / 3;
      const link = links.find((l) => cx >= l.x1 && cx <= l.x2 && cy >= l.y1 - 2 && cy <= l.y2 + 2 && item.width <= l.x2 - l.x1 + size);
      runs.push({ text: item.str, x, y, width: item.width, size, ...(link ? { link: link.url } : {}) });
    }
    return runs;
  } finally {
    page.cleanup();
  }
}

/** Runs into lines, in the order the page draws them (which keeps columns apart better than sorting by position). */
function toLines(runs: Run[]): Line[] {
  const lines: (Line & { runs: Run[] })[] = [];
  for (const run of runs) {
    const cur = lines.at(-1);
    if (cur && Math.abs(run.y - cur.y) <= 0.45 * Math.max(run.size, cur.size) && run.x >= cur.right - 0.5 * run.size) {
      cur.runs.push(run);
      cur.right = Math.max(cur.right, run.x + run.width);
      if (run.text.trim() && run.size > cur.size) cur.size = run.size;
    } else {
      lines.push({ text: '', x: run.x, y: run.y, right: run.x + run.width, size: run.text.trim() ? run.size : 0, runs: [run] });
    }
  }
  const out: Line[] = [];
  for (const line of lines) {
    let text = '';
    let end = -Infinity;
    // Neighbouring runs with the same link become one link.
    const parts: { text: string; link?: string }[] = [];
    for (const run of line.runs) {
      const gap = run.x - end;
      const space = text && !/\s$/.test(text) && !/^\s/.test(run.text) && gap > 0.15 * run.size ? ' ' : '';
      text += space + run.text;
      end = run.x + run.width;
      const last = parts.at(-1);
      if (last && last.link === run.link) last.text += space + run.text;
      else parts.push({ text: (space && last ? space : '') + run.text, ...(run.link ? { link: run.link } : {}) });
    }
    const md = parts.map((p) => {
      if (!p.link) return p.text;
      const lead = p.text.match(/^\s*/)![0];
      const label = p.text.trim();
      // A link whose text is its address stays as written; Markdown makes it a link.
      return label && label !== p.link && `mailto:${label}` !== p.link ? `${lead}[${label.replace(/[[\]]/g, '\\$&')}](${p.link.replace(/[()\s]/g, encodeURIComponent)})` : p.text;
    }).join('').replace(/\s+/g, ' ').trim();
    if (!md || !line.size) continue;
    out.push({ text: md, x: line.x, y: line.y, right: line.right, size: line.size });
  }
  return out;
}

/** Lines repeated at the top or bottom of most pages (running headers and footers), and lone page numbers there. */
function dropRunning(pages: Line[][]): Line[][] {
  const key = (l: Line) => l.text.replace(/\d+/g, '#').toLowerCase();
  // The lines within about two lines of the top and of the bottom, and at least two at each: a footer is often a line
  // of text over a page number, or a few pieces side by side.
  const edges = (p: Line[]) => {
    if (!p.length) return [];
    const byY = [...p].sort((a, b) => b.y - a.y);
    const top = byY[0].y, bottom = byY.at(-1)!.y;
    return byY.filter((l, i) => i < 2 || i >= byY.length - 2 || l.y >= top - 30 || l.y <= bottom + 30);
  };
  const counts = new Map<string, number>();
  for (const p of pages) for (const k of new Set(edges(p).map(key))) counts.set(k, (counts.get(k) ?? 0) + 1);
  const withText = pages.filter((p) => p.length).length;
  const repeated = (l: Line) => withText >= 3 && (counts.get(key(l)) ?? 0) >= Math.max(3, withText / 2);
  return pages.map((p) => {
    const byY = [...p].sort((a, b) => b.y - a.y);
    const outermost = new Set([byY[0], byY.at(-1)]);
    const drop = new Set(edges(p).filter((l) => repeated(l) || (p.length > 1 && outermost.has(l) && PAGE_NUMBER.test(l.text))));
    return p.filter((l) => !drop.has(l));
  });
}

/** The size most of the text is set in, and the usual distance between its lines. */
function bodyMetrics(pages: Line[][]): { body: number; leading: number } {
  const chars = new Map<number, number>();
  for (const p of pages) for (const l of p) chars.set(round(l.size), (chars.get(round(l.size)) ?? 0) + l.text.length);
  const body = [...chars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 12;
  const gaps: number[] = [];
  for (const p of pages) {
    for (let i = 1; i < p.length; i++) {
      const gap = p[i - 1].y - p[i].y;
      if (round(p[i].size) === body && round(p[i - 1].size) === body && gap > 0 && gap < 3 * body) gaps.push(gap);
    }
  }
  gaps.sort((a, b) => a - b);
  return { body, leading: gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1.2 * body };
}

const escapeLine = (s: string) => s.replace(/^(#{1,6}\s|>|\+\s|=+$)/, '\\$1');

/** One page's lines as Markdown blocks. */
function toMarkdown(lines: Line[], body: number, leading: number, headingLevel: (size: number) => number): string {
  const blocks: string[] = [];
  let block: { kind: 'p' | 'h' | 'li'; text: string; size: number; x: number } | null = null;
  const right = Math.max(0, ...lines.map((l) => l.right));
  const flush = () => {
    if (!block) return;
    if (block.kind === 'h') blocks.push(`${'#'.repeat(headingLevel(block.size))} ${block.text}`);
    else if (block.kind === 'li') blocks.push(block.text);
    else blocks.push(escapeLine(block.text));
    block = null;
  };
  let prev: Line | null = null;
  for (const line of lines) {
    const heading = line.size >= body * 1.15 && line.text.length <= 200 && /\p{L}/u.test(line.text);
    const bullet = BULLET.exec(line.text);
    const numbered = NUMBERED.exec(line.text);
    const item = (bullet && line.text.length > bullet[0].length && !/^[-–—*]\S/.test(line.text)) || numbered;
    const gap = prev ? prev.y - line.y : 0;
    const sameSize = prev && Math.abs(line.size - prev.size) <= Math.max(1, 0.1 * body);
    const prevEnded = prev && /[.!?:;"”)]$/.test(prev.text) && prev.right < right - 4 * body;
    const joins = block && prev && sameSize && gap > 0 && gap <= 1.6 * Math.max(leading, line.size * 1.1) && !item && !SECTION.test(line.text) &&
      (block.kind === 'h' ? heading : !heading && !prevEnded && !(block.kind === 'li' && line.x <= block.x + 0.5 * body));
    if (joins) {
      // A word broken at the end of a line is put back together.
      block!.text = /\p{Ll}-$/u.test(block!.text) && /^\p{Ll}/u.test(line.text) ? block!.text.slice(0, -1) + line.text : `${block!.text} ${line.text}`;
    } else {
      flush();
      if (heading) block = { kind: 'h', text: line.text, size: line.size, x: line.x };
      else if (numbered) block = { kind: 'li', text: `${numbered[1]}. ${line.text.slice(numbered[0].length)}`, size: line.size, x: line.x };
      else if (item) block = { kind: 'li', text: `- ${line.text.slice(bullet![0].length)}`, size: line.size, x: line.x };
      else block = { kind: 'p', text: line.text, size: line.size, x: line.x };
    }
    prev = line;
  }
  flush();
  // List items one after another make one list; everything else is a paragraph of its own.
  return blocks.reduce((out, b, i) => (i === 0 ? b : `${out}${/^(- |\d+\. )/.test(b) && /^(- |\d+\. )/.test(blocks[i - 1]) ? '\n' : '\n\n'}${b}`), '');
}

/**
 * The text of a PDF's first `maxPages` pages as Markdown, page by page. Stops early, with the pages read so far,
 * when `deadline` (a time in ms) passes. Throws PdfReadError for a locked or unreadable PDF.
 */
export async function readPdfText(bytes: Uint8Array, opts: { maxPages: number; deadline: number }): Promise<PdfText> {
  const lib = await pdfjs();
  // A copy: pdf.js may take over the buffer it is given.
  const task = lib.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, stopAtErrors: false, verbosity: 0 });
  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy().catch(() => {});
    const name = (e as Error)?.name ?? '';
    if (name === 'PasswordException' || /password/i.test(String((e as Error)?.message))) throw new PdfReadError('locked', 'password');
    throw new PdfReadError(String((e as Error)?.message ?? e), 'damaged');
  }
  try {
    const pages: Line[][] = [];
    const last = Math.min(doc.numPages, opts.maxPages);
    for (let n = 1; n <= last; n++) {
      if (n > 1 && Date.now() > opts.deadline) break;
      let runs: Run[] = [];
      try { runs = await readRuns(doc, n); } catch { /* a damaged page is left out */ }
      pages.push(toLines(runs));
    }
    const kept = dropRunning(pages);
    const { body, leading } = bodyMetrics(kept);
    // Heading sizes, largest first: the largest is #, the next ##, and so on.
    const sizes = [...new Set(kept.flat().filter((l) => l.size >= body * 1.15).map((l) => round(l.size)))].sort((a, b) => b - a);
    const level = (size: number) => Math.min(sizes.indexOf(round(size)) + 1 || 1, 4);
    const markdown = kept.map((p) => toMarkdown(p, body, leading, level));
    return { pages: markdown, totalPages: doc.numPages, emptyPages: markdown.flatMap((m, i) => (/[\p{L}\p{N}]/u.test(m) ? [] : [i + 1])) };
  } finally {
    await task.destroy().catch(() => {});
  }
}
