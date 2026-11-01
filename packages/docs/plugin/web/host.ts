// The app's connection to ChatGPT: an MCP App talking to the host over postMessage, which proxies tool calls
// to our MCP server. Everything the app loads or saves goes through tools; it never calls the app's REST API
// (the iframe has no session cookie).
import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';

export type FileKind = 'doc' | 'deck' | 'sheet' | 'markdown';
/** Everything the library lists: the editable kinds, and stored files (PDFs and videos) shown in the viewer. */
export type LibraryKind = FileKind | 'file';

export interface OpenFile {
  kind: LibraryKind;
  id: string;
  title: string;
  rev: string;
}

export interface AppState {
  open: OpenFile | null;
  /** Picture edits the model asked for, for the app to make (imageJobs.ts). */
  jobs?: import('./imageJobs.ts').ImageJob[];
}

export class Host {
  readonly app = new App({ name: 'freeflow-docs', version: '0.2.0' });
  readonly ext = new OpenAIExtensions(this.app);
  /** Where the full app lives (from the page the server rendered), for "Open in Freeflow"; null when unknown. */
  readonly appUrl: string | null = document.querySelector<HTMLMetaElement>('meta[name="freeflow-url"]')?.content.replace(/\/$/, '') || null;
  /** structuredContent of the tool call that showed the app (docs_app or open_file), once it arrives. */
  initial: Partial<AppState> | null = null;
  private initialListeners = new Set<(s: Partial<AppState>) => void>();

  constructor() {
    this.app.addEventListener('toolresult', (r) => {
      const s = (r.structuredContent ?? {}) as Partial<AppState>;
      this.initial = s;
      for (const l of this.initialListeners) l(s);
    });
    this.app.addEventListener('hostcontextchanged', (c) => this.applyContext(c as McpUiHostContext));
  }

  async connect(): Promise<void> {
    await this.app.connect();
    this.applyContext(this.app.getHostContext());
  }

  onInitial(fn: (s: Partial<AppState>) => void): () => void {
    this.initialListeners.add(fn);
    if (this.initial) fn(this.initial);
    return () => this.initialListeners.delete(fn);
  }

  private applyContext(c: McpUiHostContext | undefined): void {
    if (!c) return;
    if (c.theme) applyDocumentTheme(c.theme);
    if (c.styles?.variables) applyHostStyleVariables(c.styles.variables);
    this.applySize(c);
  }

  /**
   * The host sizes the iframe from the height the page reports, and the app's layout fills whatever it is
   * given, so the page must decide: a fixed, comfortable height inline (within what the host allows), the
   * whole viewport in fullscreen.
   */
  private applySize(c: McpUiHostContext): void {
    const root = document.documentElement;
    const mode = c.displayMode ?? root.dataset.displayMode ?? 'inline';
    root.dataset.displayMode = mode;
    if (mode === 'fullscreen' || mode === 'pip') {
      root.style.setProperty('--app-height', '100vh');
      return;
    }
    const dims = c.containerDimensions as { maxHeight?: number; height?: number } | undefined;
    const max = dims?.height ?? dims?.maxHeight;
    const wanted = 720;
    root.style.setProperty('--app-height', `${max ? Math.min(max, wanted) : wanted}px`);
  }

  /** Call one of our server's tools; an error result becomes a thrown Error. */
  async call<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.app.callServerTool({ name, arguments: args });
    const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    if (r.isError) {
      const err = new Error(text || `${name} failed`) as Error & { data?: unknown };
      err.data = r.structuredContent;
      throw err;
    }
    return (r.structuredContent ?? (text ? JSON.parse(text) : {})) as T;
  }

  /** Put something in ChatGPT's composer as a message from the user (the host may decline). */
  async ask(prompt: string): Promise<void> {
    await this.app.sendMessage({ role: 'user', content: [{ type: 'text', text: prompt }] });
  }

  /** Tell the model what the user is looking at (shown to the user as an attachment on the composer). */
  async setModelContext(text: string, structured: Record<string, unknown>, title: string): Promise<void> {
    const mc = this.ext.modelContext;
    if (!mc) return;
    await mc.update({ content: [{ type: 'text', text, _meta: { 'openai/title': title } }], structuredContent: structured });
  }

  /** The full app's address for a file, or for its home page. */
  appLink(file?: { kind: LibraryKind; id: string }): string | null {
    if (!this.appUrl) return null;
    if (!file) return this.appUrl;
    const prefix = { doc: '/doc/', deck: '/d/', sheet: '/s/', markdown: '/md/', file: '/f/' }[file.kind];
    return `${this.appUrl}${prefix}${encodeURIComponent(file.id)}`;
  }

  /** Open a web address in a new browser tab: through the host (the iframe cannot navigate the top window),
   *  or directly when there is no host (the harness). */
  async openLink(url: string): Promise<void> {
    try {
      const r = await this.app.openLink({ url });
      if (!r.isError) return;
    } catch {
      // No host, or one that does not open links.
    }
    window.open(url, '_blank', 'noopener');
  }

  async fullscreen(): Promise<void> {
    try {
      await this.app.requestDisplayMode({ mode: 'fullscreen' });
    } catch {
      // The host decides; inline is fine too.
    }
  }

  /** Upload an image through the server, for the editors' paste and insert actions. */
  async uploadImage(blob: Blob): Promise<string> {
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    return (await this.call<{ src: string }>('upload_image', { type: blob.type, data })).src;
  }
}
