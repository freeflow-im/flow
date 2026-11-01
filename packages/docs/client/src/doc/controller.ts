// Editor state for an open document: the ProseMirror state (held by DocStore with undo/redo), the editor view
// when one is mounted, and the operations the toolbar, menus, keyboard and the assistant's document tools use.
import { baseKeymap, chainCommands, exitCode, lift, setBlockType as setTextblockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { InputRule, inputRules, textblockTypeInputRule, undoInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import type { Mark, MarkType, Node as PMNode, NodeType } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { EditorState, NodeSelection, TextSelection, type Command, type Plugin, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { useSyncExternalStore } from 'react';
import { editedImageWidth, docNode, docSchema, docStyleOf, pageSetupOf, type Alignment, type BlockType, type Doc, type DocStyle, type HeadingLevel, type MarkName, type PageSetup, type Spacing } from '../../../shared/doc.ts';
import { AutoSaver, TransactionRefused } from '../state/store.ts';
import { autoLinkOnEnter, autoLinkRule } from './autolink.ts';
import { paginationOf, paginationPlugin, type Pagination } from './pagination.ts';
import { CLOSE_HISTORY_META, DocStore } from './store.ts';
import { docMatches, type DocMatch } from '../find/docFind.ts';
import { stepIndex, type FindState } from '../find/find.ts';

const s = docSchema;
const n = s.nodes;

export type CurrentBlock = BlockType | 'image' | 'video' | 'horizontal_rule';

export class DocController {
  readonly store: DocStore;
  readonly saver: AutoSaver<Doc>;
  /** The page's link dialog, opened by Mod-K and the toolbar. */
  onLinkPrompt: (() => void) | null = null;
  /** Zoom of the page view: a percentage, or fit the page to the window width. */
  zoom: number | 'fit' = 'fit';
  /** Set by the editor where the app's assistant exists; without it Mod-J does nothing. */
  assistantEnabled = false;
  /** Whether the prompt to the assistant is open at the cursor (Mod-J). */
  assistantOpen = false;
  /** How many times replaceWith brought in a version saved elsewhere (the page can tell the user). */
  externalChanges = 0;
  version = 0;
  /** The find bar, while it is open (⌘F); its matches are drawn as decorations by the editor. */
  find: FindState | null = null;
  private findCache: { doc: PMNode; query: string; matchCase: boolean; hits: DocMatch[] } | null = null;
  private view: EditorView | null = null;
  private listeners = new Set<() => void>();

  constructor(doc: Doc, save: (doc: Doc) => Promise<void>) {
    this.store = new DocStore(doc, this.plugins());
    this.saver = new AutoSaver<Doc>(this.store, save);
    this.store.subscribe(() => this.emit());
  }

  dispose(): void {
    this.saver.dispose();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  get state(): EditorState {
    return this.store.state;
  }

  get doc(): PMNode {
    return this.state.doc;
  }

  /** The editor component reports its view while mounted. */
  attachView(view: EditorView | null): void {
    this.view = view;
    if (view) view.updateState(this.state);
  }

  focus(): void {
    this.view?.focus();
  }

  /** The editor's root element while mounted (for printing). */
  editorDom(): HTMLElement | null {
    return this.view?.dom ?? null;
  }

  /** Screen coordinates of a document position (for popovers), or null without a view. */
  coordsAt(pos: number): { left: number; top: number; bottom: number } | null {
    if (!this.view || pos < 0 || pos > this.doc.content.size) return null;
    try {
      const c = this.view.coordsAtPos(pos);
      return { left: c.left, top: c.top, bottom: c.bottom };
    } catch {
      return null;
    }
  }

  setAssistantOpen(open: boolean): boolean {
    if (open && !this.assistantEnabled) return false;
    if (this.assistantOpen === open) return true;
    this.assistantOpen = open;
    // Redraws the editor's decorations: they show the selection while the prompt has the focus.
    this.view?.updateState(this.state);
    this.emit();
    return true;
  }

  setZoom(zoom: number | 'fit'): void {
    this.zoom = zoom;
    this.emit();
  }

  /**
   * Told when the store's guard refuses one of the user's changes (a Word file, desktop app), with a retry
   * that makes it, for once the page has the user's answer. Unset, the refusal is thrown.
   */
  onRefused: ((reason: string, retry: () => void) => void) | null = null;

  dispatch = (tr: Transaction, group?: string): void => {
    try {
      this.store.apply(tr, group);
    } catch (e) {
      if (!(e instanceof TransactionRefused) || !this.onRefused) throw e;
      // Nothing changed, so the same transaction still applies once the user says yes.
      this.onRefused(e.message, () => this.dispatch(tr, group));
    }
    this.view?.updateState(this.store.state);
  };

  /** Run a ProseMirror command against the current state. */
  exec(cmd: Command): boolean {
    return cmd(this.state, (tr) => this.dispatch(tr), this.view ?? undefined);
  }

  /** Run several commands as one undo step; stops at the first that does not apply. */
  private execAll(cmds: Command[]): boolean {
    const group = `ui-${Date.now()}-${Math.random()}`;
    let any = false;
    for (const cmd of cmds) {
      const ok = cmd(this.state, (tr) => this.dispatch(tr, group), this.view ?? undefined);
      if (!ok) break;
      any = true;
    }
    return any;
  }

  /** Build and apply one transaction as one undoable step. */
  run(fn: (tr: Transaction) => void): boolean {
    const tr = this.state.tr;
    fn(tr);
    if (!tr.docChanged && !tr.selectionSet && !tr.storedMarksSet) return false;
    this.dispatch(tr);
    return tr.docChanged;
  }

  /** A change made by the agent. All changes with the same group (one agent request) undo as one step. */
  runAgent(group: string, fn: (tr: Transaction) => void): boolean {
    const tr = this.state.tr;
    fn(tr);
    tr.scrollIntoView();
    // A refusal goes to the agent's tool, not the page.
    this.store.apply(tr, group);
    this.view?.updateState(this.store.state);
    return tr.docChanged;
  }

  undo(): void {
    this.store.undo();
    this.view?.updateState(this.store.state);
    this.focus();
  }

  redo(): void {
    this.store.redo();
    this.view?.updateState(this.store.state);
    this.focus();
  }

  // --- Plugins ------------------------------------------------------------------

  private plugins(): Plugin[] {
    const hardBreak: Command = (state, dispatch) => {
      dispatch?.(state.tr.replaceSelectionWith(n.hard_break.create()).scrollIntoView());
      return true;
    };
    const rule = new InputRule(/^(?:---|\*\*\*|___)$/, (state, _m, start, end) => {
      const $start = state.doc.resolve(start);
      if ($start.depth !== 1 || $start.parent.type !== n.paragraph || $start.parent.content.size !== end - start) return null;
      const tr = state.tr.replaceWith($start.before(), $start.after(), [n.horizontal_rule.create(), n.paragraph.create()]);
      return tr.setSelection(TextSelection.create(tr.doc, $start.before() + 2));
    });
    return [
      inputRules({
        rules: [
          wrappingInputRule(/^\s*([-+*])\s$/, n.bullet_list),
          wrappingInputRule(
            /^(\d+)\.\s$/,
            n.ordered_list,
            (m) => ({ start: Number(m[1]) }),
            (m, node) => node.childCount + (node.attrs.start as number) === Number(m[1]),
          ),
          wrappingInputRule(/^\s*>\s$/, n.blockquote),
          textblockTypeInputRule(/^(#{1,3})\s$/, n.heading, (m) => ({ level: m[1].length })),
          textblockTypeInputRule(/^```$/, n.code_block),
          rule,
          autoLinkRule,
        ],
      }),
      // Links a just-typed URL before the Enter below splits the block (a separate plugin so it sees fresh state).
      keymap({ Enter: autoLinkOnEnter }),
      keymap({
        'Mod-z': () => (this.undo(), true),
        'Shift-Mod-z': () => (this.redo(), true),
        'Mod-y': () => (this.redo(), true),
        'Mod-b': toggleMark(s.marks.bold),
        'Mod-i': toggleMark(s.marks.italic),
        'Mod-u': toggleMark(s.marks.underline),
        'Shift-Mod-x': toggleMark(s.marks.strike),
        'Mod-e': toggleMark(s.marks.code),
        'Mod-k': () => (this.onLinkPrompt?.(), true),
        'Mod-j': () => this.setAssistantOpen(true),
        'Shift-Mod-7': () => this.setBlockType('ordered_list'),
        'Shift-Mod-8': () => this.setBlockType('bullet_list'),
        'Mod-Alt-0': () => this.setBlockType('paragraph'),
        'Mod-Alt-1': () => this.setBlockType('heading1'),
        'Mod-Alt-2': () => this.setBlockType('heading2'),
        'Mod-Alt-3': () => this.setBlockType('heading3'),
        'Shift-Mod-l': () => this.setAlign('left'),
        'Shift-Mod-e': () => this.setAlign('center'),
        'Shift-Mod-r': () => this.setAlign('right'),
        'Shift-Mod-j': () => this.setAlign('justify'),
        Enter: splitListItem(n.list_item),
        Tab: sinkListItem(n.list_item),
        'Shift-Tab': liftListItem(n.list_item),
        'Mod-Enter': () => this.insertPageBreak(),
        'Shift-Enter': chainCommands(exitCode, hardBreak),
        Backspace: undoInputRule,
      }),
      keymap(baseKeymap),
      paginationPlugin(),
    ];
  }

  // --- Document style and paragraph spacing ----------------------------------------

  docStyle(): DocStyle {
    return docStyleOf(this.doc);
  }

  /** Change the document's default font, size, line spacing or paragraph spacing (undoable). */
  setDocStyle(patch: Partial<DocStyle>): boolean {
    const cur = this.docStyle();
    const next = { ...cur, ...patch };
    if (JSON.stringify(next) === JSON.stringify(cur)) return false;
    return this.run((tr) => tr.setDocAttribute('style', next));
  }

  /** Spacing of the block at the cursor. */
  spacingAt(): Spacing {
    const sel = this.state.selection;
    const node = sel instanceof NodeSelection ? sel.node : sel.$from.parent;
    return (node.attrs.spacing as Spacing | null) ?? {};
  }

  /** Set spacing on the textblocks in the selection; undefined values are left alone, null removes one. */
  setSpacing(patch: { [K in keyof Spacing]?: number | null }): boolean {
    const { from, to } = this.state.selection;
    const ok = this.run((tr) => {
      this.state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isTextblock || node.type === n.code_block) return;
        const cur = { ...((node.attrs.spacing as Spacing | null) ?? {}) };
        for (const k of ['before', 'after', 'line'] as const) {
          const v = patch[k];
          if (v === undefined) continue;
          if (v === null) delete cur[k];
          else cur[k] = v;
        }
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, spacing: Object.keys(cur).length ? cur : null });
      });
    });
    this.focus();
    return ok;
  }

  // --- Pages ----------------------------------------------------------------------

  pageSetup(): PageSetup {
    return pageSetupOf(this.doc);
  }

  /** Change part of the page setup (undoable). */
  setPageSetup(patch: Partial<Omit<PageSetup, 'margins'>> & { margins?: Partial<PageSetup['margins']> }): boolean {
    const cur = this.pageSetup();
    const next: PageSetup = { ...cur, ...patch, margins: { ...cur.margins, ...(patch.margins ?? {}) } };
    if (JSON.stringify(next) === JSON.stringify(cur)) return false;
    return this.run((tr) => tr.setDocAttribute('page', next));
  }

  insertPageBreak(): boolean {
    const ok = this.insertBlock(n.page_break.create());
    this.focus();
    return ok;
  }

  /** Where the page boundaries fall (empty in Pageless mode or before the first measurement). */
  pagination(): Pagination {
    const p = paginationOf(this.state);
    return { spacers: p.spacers, pageCount: p.pageCount, blockPages: p.blockPages };
  }

  /** 1-based page a top-level block starts on, or null when pages are not shown. */
  pageOfBlock(index: number): number | null {
    if (this.pageSetup().mode !== 'pages') return null;
    const page = this.pagination().blockPages[index];
    return page === undefined ? null : page + 1;
  }

  // --- Marks ----------------------------------------------------------------------

  isMarkActive(name: MarkName): boolean {
    const { from, $from, to, empty } = this.state.selection;
    const type = s.marks[name];
    if (empty) return !!type.isInSet(this.state.storedMarks ?? $from.marks());
    return this.state.doc.rangeHasMark(from, to, type);
  }

  /** The first mark of this kind at the cursor (or the start of the selection). */
  markAt(name: MarkName): Mark | undefined {
    const { $from, empty } = this.state.selection;
    const marks = empty ? (this.state.storedMarks ?? $from.marks()) : $from.marks();
    const type = s.marks[name];
    return marks.find((m) => m.type === type) ?? (empty ? undefined : this.marksInRange(type)[0]);
  }

  private marksInRange(type: MarkType): Mark[] {
    const { from, to } = this.state.selection;
    const out: Mark[] = [];
    this.state.doc.nodesBetween(from, to, (node) => {
      for (const m of node.marks) if (m.type === type) out.push(m);
    });
    return out;
  }

  toggleMark(name: MarkName): boolean {
    const ok = this.exec(toggleMark(s.marks[name]));
    this.focus();
    return ok;
  }

  /** Set a mark with attributes (color, highlight, link) on the selection, or remove it with null. */
  setMark(name: MarkName, attrs: Record<string, unknown> | null): boolean {
    const type = s.marks[name];
    const { from, to, empty } = this.state.selection;
    const ok = this.run((tr) => {
      if (empty) {
        const marks = this.state.storedMarks ?? this.state.selection.$from.marks();
        tr.setStoredMarks(attrs ? type.create(attrs).addToSet(marks) : type.removeFromSet(marks));
        return;
      }
      tr.removeMark(from, to, type);
      if (attrs) tr.addMark(from, to, type.create(attrs));
    });
    this.focus();
    return ok;
  }

  /** The link at the cursor, if any, with the range it covers. */
  linkAtCursor(): { href: string; from: number; to: number } | null {
    const { $from } = this.state.selection;
    const type = s.marks.link;
    const mark = type.isInSet($from.marks()) ?? type.isInSet($from.nodeAfter?.marks ?? []);
    if (!mark) return null;
    const parent = $from.parent;
    const base = $from.start();
    const parts: { off: number; size: number; has: boolean }[] = [];
    parent.forEach((child, off) => parts.push({ off, size: child.nodeSize, has: child.marks.some((m) => m.eq(mark)) }));
    const i = parts.findIndex((p) => p.has && p.off <= $from.parentOffset && p.off + p.size >= $from.parentOffset);
    if (i < 0) return null;
    // Extend over the neighbours that carry the same link.
    let a = i;
    let b = i;
    while (a > 0 && parts[a - 1].has) a--;
    while (b < parts.length - 1 && parts[b + 1].has) b++;
    return { href: String(mark.attrs.href), from: base + parts[a].off, to: base + parts[b].off + parts[b].size };
  }

  /** Link the selection (or the link under the cursor) to href; null removes the link. */
  setLink(href: string | null): boolean {
    const sel = this.state.selection;
    let { from, to } = sel;
    if (sel.empty) {
      const link = this.linkAtCursor();
      if (!link) return false;
      ({ from, to } = link);
    }
    const ok = this.run((tr) => {
      tr.removeMark(from, to, s.marks.link);
      if (href) tr.addMark(from, to, s.marks.link.create({ href }));
    });
    this.focus();
    return ok;
  }

  /** Remove every mark from the selection and turn headings back into paragraphs. */
  clearFormatting(): boolean {
    const { from, to, empty } = this.state.selection;
    const ok = this.run((tr) => {
      if (empty) tr.setStoredMarks([]);
      else tr.removeMark(from, to);
      this.state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type === n.heading || node.type === n.title || node.type === n.subtitle) tr.setNodeMarkup(pos, n.paragraph, { align: node.attrs.align });
        else if ((node.type === n.paragraph || node.type === n.image || node.type === n.video) && node.attrs.align) tr.setNodeMarkup(pos, undefined, { ...node.attrs, align: null });
      });
    });
    this.focus();
    return ok;
  }

  // --- Blocks -----------------------------------------------------------------------

  /** The list the cursor is in, if any. */
  private listType(): NodeType | null {
    const { $from } = this.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const t = $from.node(d).type;
      if (t === n.bullet_list || t === n.ordered_list) return t;
    }
    return null;
  }

  private inBlockquote(): boolean {
    const { $from } = this.state.selection;
    for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === n.blockquote) return true;
    return false;
  }

  /** What kind of block the cursor is in (for the toolbar's block menu). */
  currentBlock(): CurrentBlock {
    const sel = this.state.selection;
    if (sel instanceof NodeSelection) {
      if (sel.node.type === n.image) return 'image';
      if (sel.node.type === n.video) return 'video';
      if (sel.node.type === n.horizontal_rule) return 'horizontal_rule';
    }
    const list = this.listType();
    if (list) return list === n.bullet_list ? 'bullet_list' : 'ordered_list';
    const parent = sel.$from.parent;
    if (parent.type === n.heading) return `heading${parent.attrs.level as HeadingLevel}`;
    if (parent.type === n.title) return 'title';
    if (parent.type === n.subtitle) return 'subtitle';
    if (parent.type === n.code_block) return 'code_block';
    if (this.inBlockquote()) return 'blockquote';
    return 'paragraph';
  }

  /** Make the selected blocks this kind (toggles lists and quotes off when they already are). */
  setBlockType(type: BlockType): boolean {
    const list = this.listType();
    const liftOut: Command[] = [];
    for (let k = 0; k < 6; k++) liftOut.push(liftListItem(n.list_item));
    let ok: boolean;
    if (type === 'bullet_list' || type === 'ordered_list') {
      const target = n[type];
      if (list === target) ok = this.exec(liftListItem(n.list_item));
      else if (list) ok = this.run((tr) => this.swapListType(tr, target));
      else ok = this.exec(wrapInList(target));
    } else if (type === 'blockquote') {
      ok = this.inBlockquote() ? this.exec(lift) : this.exec(wrapIn(n.blockquote));
    } else {
      const to =
        type === 'code_block' || type === 'paragraph' || type === 'title' || type === 'subtitle' ? setTextblockType(n[type]) : setTextblockType(n.heading, { level: Number(type.slice(-1)) });
      ok = list ? this.execAll([...liftOut.map((c) => this.untilNotInList(c)), to]) : this.exec(to);
    }
    this.focus();
    return ok;
  }

  /** A lift command that is a no-op (but succeeds) once the cursor has left every list. */
  private untilNotInList(cmd: Command): Command {
    return (state, dispatch, view) => {
      const $from = state.selection.$from;
      let inList = false;
      for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === n.list_item) inList = true;
      return inList ? cmd(state, dispatch, view) : true;
    };
  }

  /** Turn the innermost list around the cursor into the other kind. */
  private swapListType(tr: Transaction, target: NodeType): void {
    const { $from } = this.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (node.type === n.bullet_list || node.type === n.ordered_list) {
        tr.setNodeMarkup($from.before(d), target, target === n.ordered_list ? { start: 1 } : null);
        return;
      }
    }
  }

  indent(): boolean {
    const ok = this.exec(sinkListItem(n.list_item));
    this.focus();
    return ok;
  }

  outdent(): boolean {
    const ok = this.exec(liftListItem(n.list_item));
    this.focus();
    return ok;
  }

  currentAlign(): Alignment {
    const sel = this.state.selection;
    const node = sel instanceof NodeSelection ? sel.node : sel.$from.parent;
    return (node.attrs.align as Alignment | null) ?? 'left';
  }

  setAlign(align: Alignment): boolean {
    const { from, to } = this.state.selection;
    const ok = this.run((tr) => {
      this.state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type === n.paragraph || node.type === n.heading || node.type === n.title || node.type === n.subtitle || node.type === n.image || node.type === n.video) {
          const next = align === 'left' ? null : align;
          if ((node.attrs.align ?? null) !== next) tr.setNodeMarkup(pos, undefined, { ...node.attrs, align: next });
        }
      });
    });
    this.focus();
    return ok;
  }

  insertHorizontalRule(): boolean {
    const ok = this.insertBlock(n.horizontal_rule.create());
    this.focus();
    return ok;
  }

  /** Add an image block at the cursor (replacing an empty paragraph), with a paragraph after it to type in. */
  insertImage(src: string, attrs: { alt?: string; width?: number | null; align?: Alignment | null } = {}): boolean {
    const node = n.image.create({ src, alt: attrs.alt ?? '', width: attrs.width ?? null, align: attrs.align ?? null });
    const ok = this.insertBlock(node);
    this.focus();
    return ok;
  }

  /** Put a picture in the line at the cursor, in place of what is selected (a form's blank line, say). */
  insertInlineImage(src: string, attrs: { alt?: string; width?: number | null } = {}): boolean {
    const ok = this.run((tr) => {
      if (!this.state.selection.$from.parent.inlineContent) return;
      tr.replaceSelectionWith(n.inline_image.create({ src, alt: attrs.alt ?? '', width: attrs.width ?? null }), false).scrollIntoView();
    });
    this.focus();
    return ok;
  }

  /** Type text at the cursor, in place of what is selected. */
  insertText(text: string): boolean {
    const ok = this.run((tr) => {
      if (!this.state.selection.$from.parent.inlineContent) return;
      tr.insertText(text).scrollIntoView();
    });
    this.focus();
    return ok;
  }

  /** Add a video block (shared/video.ts) at the cursor, like an image. */
  insertVideo(src: string, attrs: { title?: string; width?: number | null; align?: Alignment | null } = {}): boolean {
    const node = n.video.create({ src, title: attrs.title ?? '', width: attrs.width ?? null, align: attrs.align ?? null });
    const ok = this.insertBlock(node);
    this.focus();
    return ok;
  }

  private insertBlock(node: PMNode): boolean {
    return this.run((tr) => {
      const { $from } = this.state.selection;
      const emptyPara = $from.depth === 1 && $from.parent.type === n.paragraph && $from.parent.content.size === 0;
      const at = emptyPara ? $from.before() : null;
      if (at !== null) tr.replaceWith(at, at + $from.parent.nodeSize, node);
      else tr.replaceSelectionWith(node);
      // Keep a paragraph after the block so the user can continue typing.
      const pos = at !== null ? at + node.nodeSize : tr.selection.to;
      const $pos = tr.doc.resolve(Math.min(pos, tr.doc.content.size));
      const after = $pos.depth === 0 ? $pos.nodeAfter : null;
      if ($pos.depth === 0 && (!after || !after.isTextblock)) tr.insert($pos.pos, n.paragraph.create());
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min($pos.pos + 1, tr.doc.content.size))));
      tr.scrollIntoView();
    });
  }

  /** The selected image block, if the selection is one. */
  selectedImage(): { node: PMNode; pos: number } | null {
    const sel = this.state.selection;
    return sel instanceof NodeSelection && sel.node.type === n.image ? { node: sel.node, pos: sel.from } : null;
  }

  /**
   * Put an edited picture in place of an image block's, as one step. The block is the one that was at `pos`
   * with the picture `from`; if the document changed while the image editor was open, the first block with
   * that picture. False when there is none any more.
   */
  replaceImage(pos: number, from: string, src: string, before: { width: number; height: number } | null, after: { width: number; height: number } | null): boolean {
    const doc = this.state.doc;
    const is = (node: PMNode | null | undefined) => !!node && node.type === n.image && node.attrs.src === from;
    let at = pos >= 0 && pos < doc.content.size && is(doc.nodeAt(pos)) ? pos : -1;
    if (at < 0) {
      doc.descendants((node, p) => {
        if (at < 0 && is(node)) at = p;
        return at < 0;
      });
    }
    if (at < 0) return false;
    const node = doc.nodeAt(at)!;
    return this.run((tr) => {
      tr.setNodeMarkup(at, undefined, { ...node.attrs, src, width: editedImageWidth(node.attrs.width as number | null, before, after) });
      tr.setSelection(NodeSelection.create(tr.doc, at));
    });
  }

  setImageAttrs(attrs: Partial<{ alt: string; width: number | null; align: Alignment | null }>): boolean {
    const img = this.selectedImage();
    if (!img) return false;
    return this.run((tr) => {
      tr.setNodeMarkup(img.pos, undefined, { ...img.node.attrs, ...attrs });
      tr.setSelection(NodeSelection.create(tr.doc, img.pos));
    });
  }

  /**
   * Swap in another version of the document (saved elsewhere, e.g. by the assistant in ChatGPT) as one
   * undoable step, keeping the cursor in the same block where possible. Bumps `externalChanges`.
   */
  replaceWith(doc: Doc): boolean {
    const node = docNode(doc);
    if (node.eq(this.doc) && JSON.stringify(node.attrs) === JSON.stringify(this.doc.attrs)) return false;
    const $head = this.state.selection.$head;
    const block = $head.depth ? $head.index(0) : 0;
    const offset = $head.depth ? $head.pos - $head.start(1) : 0;
    const changed = this.run((tr) => {
      tr.replaceWith(0, tr.doc.content.size, node.content);
      tr.setDocAttribute('page', node.attrs.page);
      tr.setDocAttribute('style', node.attrs.style);
      const count = tr.doc.childCount;
      if (!count) return;
      const i = Math.min(block, count - 1);
      let pos = 0;
      for (let k = 0; k < i; k++) pos += tr.doc.child(k).nodeSize;
      const child = tr.doc.child(i);
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos + 1 + Math.min(offset, child.content.size), tr.doc.content.size))));
    });
    if (changed) this.externalChanges++;
    return changed;
  }

  /** Start a fresh undo step (e.g. when the editor loses focus). */
  closeHistory(): void {
    this.store.closeHistory();
  }

  /** Mark the next transaction as a separate undo step. */
  separateStep(tr: Transaction): Transaction {
    return tr.setMeta(CLOSE_HISTORY_META, true);
  }

  // --- Find ---------------------------------------------------------------------------

  openFind(): void {
    this.find = this.find ? { ...this.find, focusSeq: this.find.focusSeq + 1 } : { query: '', matchCase: false, current: -1, focusSeq: 1 };
    this.emit();
  }

  /** Close the find bar; the match shown is selected in the text, ready to type over or copy. */
  closeFind(): void {
    if (!this.find) return;
    const hit = this.findMatches()[this.find.current];
    this.find = null;
    if (hit && this.view) this.view.dispatch(this.state.tr.setSelection(TextSelection.create(this.doc, hit.from, hit.to)));
    else this.view?.updateState(this.state);
    this.emit();
    this.focus();
  }

  /** The matches of the find bar's query (cached for each version of the document). */
  findMatches(): DocMatch[] {
    const f = this.find;
    if (!f?.query) return [];
    const c = this.findCache;
    if (c && c.doc === this.doc && c.query === f.query && c.matchCase === f.matchCase) return c.hits;
    const hits = docMatches(this.doc, f.query, f.matchCase);
    this.findCache = { doc: this.doc, query: f.query, matchCase: f.matchCase, hits };
    return hits;
  }

  /** A new query or case: shows the first match at or after the cursor. */
  setFind(patch: Partial<Pick<FindState, 'query' | 'matchCase'>>): void {
    if (!this.find) return;
    this.find = { ...this.find, ...patch, current: -1 };
    const hits = this.findMatches();
    const at = hits.findIndex((h) => h.from >= this.state.selection.from);
    this.showMatch(hits.length ? (at < 0 ? 0 : at) : -1);
  }

  findStep(dir: 1 | -1): void {
    if (!this.find) return;
    this.showMatch(stepIndex(this.find.current, this.findMatches().length, dir));
  }

  private showMatch(i: number): void {
    if (!this.find) return;
    this.find = { ...this.find, current: i };
    // The decorations are redrawn with the state; the match shown is scrolled to.
    this.view?.updateState(this.state);
    this.emit();
    const el = this.view?.dom.querySelector('.find-current');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  /** The find bar's matches as decorations, the one shown marked. */
  findDecorations(): { from: number; to: number; current: boolean }[] {
    const f = this.find;
    if (!f) return [];
    return this.findMatches().map((h, i) => ({ ...h, current: i === f.current }));
  }

  // --- For the assistant --------------------------------------------------------------

  /** 1-based number of the top-level block holding the cursor. */
  cursorBlock(): number {
    const $head = this.state.selection.$head;
    return Math.min($head.index(0) + 1, Math.max(1, this.doc.childCount));
  }

  selectedText(): string {
    const { from, to, empty } = this.state.selection;
    return empty ? '' : this.doc.textBetween(from, to, '\n');
  }

  /** Select a top-level block (0-based) and scroll to it, to show the user something. */
  selectBlock(index: number): void {
    const doc = this.doc;
    if (index < 0 || index >= doc.childCount) return;
    let pos = 0;
    for (let k = 0; k < index; k++) pos += doc.child(k).nodeSize;
    const node = doc.child(index);
    this.run((tr) => {
      tr.setSelection(node.isTextblock || node.isBlock ? (node.isLeaf || node.type === n.image ? NodeSelection.create(tr.doc, pos) : TextSelection.near(tr.doc.resolve(pos + 1))) : TextSelection.near(tr.doc.resolve(pos)));
      tr.scrollIntoView();
    });
  }
}

export function useDocController(ctl: DocController): number {
  return useSyncExternalStore(ctl.subscribe, ctl.getVersion);
}
