// PDFs of documents, presentations, Markdown files and stored web pages (docs/web-and-pdf.md). A headless
// browser loads the file's page in the app with `?print=pdf`, which lays it out as Print does and says when it
// is drawn (client/src/print.ts), and prints it. The browser is let in with a print ticket: a cookie that makes
// its requests the user's, for reading only. A stored web page is someone else's HTML, so it is printed from
// its text with every request it makes checked as an import's are (webFetch.ts).
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { HTML_TYPE, type StoredFile } from '../shared/types.ts';
import { titleBase } from '../shared/docNames.ts';
import type { FileStore } from './files.ts';
import type { SheetStore } from './sheets.ts';
import { fetchPublicFile, WebFetchError } from './webFetch.ts';

export type Paper = 'letter' | 'a4';

export interface PdfOptions {
  /** The paper when the page names no size of its own (Markdown, web pages, a document in flowing mode). */
  paper: Paper;
  /** Margins in inches around what the page draws; 0 for pages that draw their own (documents in Pages mode, slides). */
  margin: number;
  /** How long the page may take to be drawn and printed. */
  timeoutMs: number;
}

export interface PdfRenderer {
  /** Load `url` with the print ticket as its cookie, wait for the page to say it is drawn, and print it. */
  page(url: string, ticket: { name: string; value: string }, opts: PdfOptions): Promise<Buffer>;
  /** Print untrusted HTML: its requests go out only to the public internet, and only to read. */
  html(html: string, opts: PdfOptions): Promise<Buffer>;
  close(): Promise<void>;
}

export class PrintError extends Error {}
/** The file is not one that can be made into a PDF (a spreadsheet, a picture...). */
export class NotPrintableError extends PrintError {}

/** The cookie a print ticket is sent in. */
export const PRINT_COOKIE = 'print';
const TICKET_TTL_MS = 2 * 60 * 1000;

/** Short-lived tokens that make the headless browser's requests a user's, for reading only. Kept in memory. */
export class PrintTickets<U> {
  private tickets = new Map<string, { user: U; expires: number }>();

  create(user: U): string {
    const now = Date.now();
    for (const [t, v] of this.tickets) if (v.expires <= now) this.tickets.delete(t);
    const token = randomBytes(32).toString('base64url');
    this.tickets.set(token, { user, expires: now + TICKET_TTL_MS });
    return token;
  }

  userFor(token: string | undefined): U | null {
    if (!token) return null;
    const t = this.tickets.get(token);
    if (!t) return null;
    if (t.expires <= Date.now()) {
      this.tickets.delete(token);
      return null;
    }
    return t.user;
  }

  revoke(token: string): void {
    this.tickets.delete(token);
  }
}

/** Letter where it is the custom (the US, Canada, Mexico, the Philippines, Chile, Colombia), else A4. */
export function paperFor(locale: string | undefined): Paper {
  const region = /[-_]([A-Za-z]{2})\b/.exec(locale ?? '')?.[1]?.toUpperCase();
  return region && ['US', 'CA', 'MX', 'PH', 'CL', 'CO'].includes(region) ? 'letter' : 'a4';
}

/** A file name for the PDF of a file called `title`. */
export function pdfName(title: string): string {
  const base = titleBase(title.replace(/\.html?$/i, '')).replace(/[\\/\u0000-\u001f]/g, '_').trim() || 'document';
  return `${base}.pdf`;
}

// --- Making a file's PDF ---------------------------------------------------------------------------------

/** What can be made into a PDF: a document, presentation or Markdown file, or a stored web page. */
const PAGES = { doc: 'doc', deck: 'd', markdown: 'md' } as const;

export interface MadePdf {
  pdf: Buffer;
  /** The PDF's file name, after the file's. */
  name: string;
  /** The file's folder, where a PDF kept beside it goes. */
  folder: string;
  /** The file's revision (documents, presentations, Markdown), for following its changes. */
  revision?: string;
}

/**
 * Makes the PDF of a user's file: the Download as PDF route, the assistant's export_pdf and the MCP's. A
 * file's page is loaded from `origin()` (the app's own address) with a print ticket; a web page is printed from
 * its HTML. The tickets are checked by the app's onRequest hook, which makes their requests the user's.
 */
export class PdfMaker {
  readonly tickets = new PrintTickets<string>();
  readonly renderer: PdfRenderer;
  private sheets: SheetStore;
  private files: FileStore;
  private origin: () => string;

  constructor(o: { renderer: PdfRenderer; sheets: SheetStore; files: FileStore; origin: () => string }) {
    this.renderer = o.renderer;
    this.sheets = o.sheets;
    this.files = o.files;
    this.origin = o.origin;
  }

  /** The PDF of file `id`, or null when the user has no such file. Throws PrintError for one that cannot be printed. */
  async make(userId: string, id: string, o: { paper: Paper; origin?: string }): Promise<MadePdf | null> {
    const meta = this.sheets.get(userId, id);
    if (meta) {
      if (meta.kind === 'sheet') throw new NotPrintableError('A spreadsheet cannot be made into a PDF yet.');
      const ticket = this.tickets.create(userId);
      try {
        const url = `${o.origin ?? this.origin()}/${PAGES[meta.kind]}/${encodeURIComponent(id)}?print=pdf`;
        const deck = meta.kind === 'deck';
        const pdf = await this.renderer.page(url, { name: PRINT_COOKIE, value: ticket }, { paper: o.paper, margin: deck ? 0 : 0.5, timeoutMs: deck ? 60_000 : 30_000 });
        return { pdf, name: pdfName(meta.title), folder: meta.folder ?? '', revision: meta.updatedAt };
      } finally {
        this.tickets.revoke(ticket);
      }
    }
    const stored = this.files.get(userId, id);
    if (!stored) return null;
    if (stored.meta.type !== HTML_TYPE) throw new NotPrintableError('Only documents, presentations, Markdown files and web pages can be made into PDFs.');
    const pdf = await this.renderer.html(await readFile(stored.file, 'utf8'), { paper: o.paper, margin: 0.5, timeoutMs: 30_000 });
    return { pdf, name: pdfName(stored.meta.filename), folder: stored.meta.folder ?? '' };
  }

  /** Make file `id`'s PDF and keep it as a stored file beside it (same folder, same name); null when there is no such file. */
  async save(userId: string, id: string, paper: Paper): Promise<StoredFile | null> {
    const made = await this.make(userId, id, { paper });
    return made && this.files.create(userId, made.name, 'application/pdf', made.pdf, made.folder);
  }
}

// --- Playwright -------------------------------------------------------------------------------------------

const MAX_RESOURCE_BYTES = 20 * 1024 * 1024;
/** Renders at once; the rest wait their turn. */
const MAX_RENDERS = 2;

type Browser = import('playwright-core').Browser;
type BrowserContext = import('playwright-core').BrowserContext;

/**
 * Chromium driven by Playwright: the hosted app's and `npm run dev`'s renderer. One browser is started on the
 * first PDF and kept; each PDF gets a context of its own (no shared cookies or storage), closed after.
 * The browser is CHROMIUM_PATH when set, else Playwright's own Chromium, else the machine's Chrome.
 */
export class PlaywrightRenderer implements PdfRenderer {
  private browser: Promise<Browser> | null = null;
  private running = 0;
  private waiting: (() => void)[] = [];

  private launch(): Promise<Browser> {
    this.browser ??= (async () => {
      const { chromium } = await import('playwright-core');
      const path = process.env.CHROMIUM_PATH;
      if (path) return chromium.launch({ executablePath: path });
      try {
        return await chromium.launch();
      } catch {
        try {
          return await chromium.launch({ channel: 'chrome' });
        } catch {
          throw new PrintError('PDFs cannot be made here: no Chromium or Chrome was found (set CHROMIUM_PATH).');
        }
      }
    })();
    this.browser.then(
      (b) => b.on('disconnected', () => (this.browser = null)),
      () => (this.browser = null),
    );
    return this.browser;
  }

  private async turn<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_RENDERS) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running++;
    try {
      return await work();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private async print(context: BrowserContext, load: (page: import('playwright-core').Page) => Promise<void>, opts: PdfOptions): Promise<Buffer> {
    const page = await context.newPage();
    page.setDefaultTimeout(opts.timeoutMs);
    page.on('dialog', (d) => void d.dismiss().catch(() => {}));
    await page.emulateMedia({ media: 'print' });
    await load(page);
    const margin = `${opts.margin}in`;
    return page.pdf({
      format: opts.paper === 'letter' ? 'Letter' : 'A4',
      preferCSSPageSize: true,
      printBackground: true,
      margin: { top: margin, right: margin, bottom: margin, left: margin },
      outline: true,
      tagged: true,
    });
  }

  page(url: string, ticket: { name: string; value: string }, opts: PdfOptions): Promise<Buffer> {
    return this.turn(async () => {
      const context = await (await this.launch()).newContext({ acceptDownloads: false });
      try {
        await context.addCookies([{ name: ticket.name, value: ticket.value, url: new URL(url).origin, httpOnly: true, sameSite: 'Lax' }]);
        return await this.print(
          context,
          async (page) => {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => (window as { __printReady?: boolean }).__printReady === true, null, { timeout: opts.timeoutMs });
          },
          opts,
        );
      } catch (e) {
        throw e instanceof PrintError ? e : new PrintError(`The PDF could not be made: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      } finally {
        await context.close().catch(() => {});
      }
    });
  }

  html(html: string, opts: PdfOptions): Promise<Buffer> {
    return this.turn(async () => {
      const context = await (await this.launch()).newContext({ acceptDownloads: false, serviceWorkers: 'block' });
      try {
        // Every request the page makes: data and blob addresses load; web addresses are fetched here, public
        // ones only and only to read, and handed back; anything else is refused.
        await context.route('**/*', async (route) => {
          const req = route.request();
          const url = req.url();
          if (/^(data|blob):/i.test(url)) return route.continue();
          if (req.method() !== 'GET' || !/^https?:/i.test(url)) return route.abort('blockedbyclient');
          try {
            const got = await fetchPublicFile(url, { limit: MAX_RESOURCE_BYTES, timeoutMs: 10_000 });
            await route.fulfill({ status: 200, body: got.bytes, contentType: got.type || undefined });
          } catch (e) {
            await route.abort(e instanceof WebFetchError ? 'blockedbyclient' : 'failed');
          }
        });
        return await this.print(
          context,
          async (page) => {
            page.on('popup', (p) => void p.close().catch(() => {}));
            await page.setContent(html, { waitUntil: 'load', timeout: opts.timeoutMs });
          },
          opts,
        );
      } catch (e) {
        throw e instanceof PrintError ? e : new PrintError(`The PDF could not be made: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      } finally {
        await context.close().catch(() => {});
      }
    });
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) await (await b.catch(() => null))?.close().catch(() => {});
  }
}

// --- The desktop app --------------------------------------------------------------------------------------

/** A request to the desktop app's main process (desktop/main.js), which prints in a hidden window. */
type PdfJob = ({ url: string; ticket: { name: string; value: string } } | { html: string }) & { opts: PdfOptions };
export type PdfRequest = { pdf: string } & PdfJob;
export type PdfAnswer = { pdfDone: string; data?: string; error?: string };

/**
 * The desktop app's renderer: its server is a child of Electron, which already is a browser, so the server
 * asks the main process to print (no Chromium is shipped). `send` is `process.send`; answers come back
 * through `answer`, which desktop/server.ts calls with each message from the parent.
 */
export class ElectronRenderer implements PdfRenderer {
  private pending = new Map<string, { resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  private send: (msg: PdfRequest) => void;

  constructor(send: (msg: PdfRequest) => void) {
    this.send = send;
  }

  private ask(req: PdfJob, opts: PdfOptions): Promise<Buffer> {
    const id = randomBytes(8).toString('hex');
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PrintError('The PDF took too long to make.'));
      }, opts.timeoutMs + 5_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...req, pdf: id });
    });
  }

  answer(msg: PdfAnswer): void {
    const p = this.pending.get(msg.pdfDone);
    if (!p) return;
    this.pending.delete(msg.pdfDone);
    clearTimeout(p.timer);
    if (msg.data !== undefined) p.resolve(Buffer.from(msg.data, 'base64'));
    else p.reject(new PrintError(msg.error ?? 'The PDF could not be made.'));
  }

  page(url: string, ticket: { name: string; value: string }, opts: PdfOptions): Promise<Buffer> {
    return this.ask({ url, ticket, opts }, opts);
  }

  html(html: string, opts: PdfOptions): Promise<Buffer> {
    return this.ask({ html, opts }, opts);
  }

  async close(): Promise<void> {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new PrintError('The app is closing.'));
    }
    this.pending.clear();
  }
}
