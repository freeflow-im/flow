// The preview of a Markdown document, editable in place (design in wysiwyg.ts). Each top-level block is its own
// contentEditable element. The block being edited is frozen while it has the focus: React does not render it
// again (it would fight the browser over the element's contents), while its Markdown is written into the text
// as the user types. When it loses the focus it is drawn again from the text.
import type { Element as HastElement } from 'hast';
import { fromDom } from 'hast-util-from-dom';
import { memo, useCallback, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import 'github-markdown-css/github-markdown-light.css';
import { markdownBlocks } from '../../../shared/agent/markdownBlocks.ts';
import type { MarkdownController } from './controller.ts';
import { imageSrc, SOURCE_ATTR, type ImageRoot } from './imagePaths.ts';
import type { StoreImage } from './MarkdownEditor.tsx';
import { PLUGINS, usePreviewComponents } from './MarkdownPreview.tsx';
import type { MermaidLoader } from './MermaidDiagram.tsx';
import { imageIn } from './pastedImage.ts';
import { blockKeys, childrenOf, editableBlock, hastToMarkdown, spliceBlock } from './wysiwyg.ts';

/** The block being edited: where its Markdown is in the text now, and what it was when the edit began. */
interface Editing {
  key: string;
  from: number;
  to: number;
  /** The block's text when editing began, and the Markdown its HTML read as then (so an edit undone puts that text back exactly). */
  source: string;
  baseline: string;
  /** The document's text after this block's last change; any other text means it changed elsewhere. */
  text: string;
  /** What the block was drawn with, kept so it is not drawn again while it is edited. */
  defs: string;
  placeholder?: string;
}

const NEW_BLOCK = '\u0000new';
const PENDING_ATTR = 'data-md-pending';

/** Markdown for what an editable block shows now. */
function markdownOf(host: HTMLElement, now = true): string {
  // A ticked box changes its property, not its attribute, which is what is read: the attribute is what it was
  // drawn with until it is brought up to date here.
  if (now) for (const box of host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) box.toggleAttribute('checked', box.checked);
  return hastToMarkdown(childrenOf(fromDom(host) as HastElement));
}

const Block = memo(function Block({ id, source, defs, components, editable, placeholder }: { id: string; source: string; defs: string; components: Components; editable: boolean; placeholder?: string }) {
  return (
    <div className={`md-wy-block${placeholder ? ' md-wy-new' : ''}`} data-block={id} data-placeholder={placeholder} contentEditable={editable} suppressContentEditableWarning spellCheck>
      {source && (
        <ReactMarkdown remarkPlugins={PLUGINS} components={components}>
          {defs ? `${source}\n\n${defs}` : source}
        </ReactMarkdown>
      )}
    </div>
  );
});

function caretAtEdge(host: HTMLElement, end: boolean): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
  const r = document.createRange();
  r.selectNodeContents(host);
  if (end) r.setStart(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  else r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return r.toString().trim() === '';
}

function focusBlock(host: HTMLElement, atEnd: boolean) {
  host.focus();
  const r = document.createRange();
  r.selectNodeContents(host);
  r.collapse(!atEnd);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

export function WysiwygPreview({ ctl, text, loadMermaid, folder, root, storeImage }: {
  ctl: MarkdownController;
  /** The document's text (the page re-renders on every change). */
  text: string;
  loadMermaid?: MermaidLoader;
  folder: string;
  root?: ImageRoot;
  storeImage: StoreImage;
}) {
  const components = usePreviewComponents(loadMermaid, folder, root, true);
  const blocks = useMemo(() => markdownBlocks(text), [text]);
  const defs = useMemo(() => blocks.filter((b) => b.type === 'definition').map((b) => b.markdown).join('\n'), [blocks]);
  const editing = useRef<Editing | null>(null);
  const [newBlock, setNewBlock] = useState(0);
  const [, rerender] = useState(0);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Where each block shown is in the text, by its key. */
  const ranges = useRef(new Map<string, { from: number; to: number; source: string; defs: string }>());

  // The text changed elsewhere (the text editor, the assistant, another tab): the block being edited is drawn again.
  if (editing.current && editing.current.text !== text) editing.current = null;
  const ed = editing.current;

  const outside = ed ? blocks.filter((b) => b.end <= ed.from || b.start >= ed.to) : blocks;
  const keys = blockKeys(outside, ed ? [ed.key] : []);
  const newKey = `${NEW_BLOCK}${newBlock}`;
  ranges.current = new Map(outside.map((b, i) => [keys[i], { from: b.start, to: b.end, source: b.markdown, defs }]));
  ranges.current.set(newKey, { from: text.length, to: text.length, source: '', defs: '' });

  const frozen = ed && <Block key={ed.key} id={ed.key} source={ed.source} defs={ed.defs} components={components} editable placeholder={ed.placeholder} />;
  const items: ReactNode[] = [];
  outside.forEach((b, i) => {
    if (frozen && !items.includes(frozen) && b.start >= ed.to) items.push(frozen);
    items.push(<Block key={keys[i]} id={keys[i]} source={b.markdown} defs={defs} components={components} editable={editableBlock(b)} />);
  });
  if (frozen && !items.includes(frozen)) items.push(frozen);
  if (ed?.key !== newKey) items.push(<Block key={newKey} id={newKey} source="" defs="" components={components} editable placeholder={placeholderFor(text)} />);

  const hostOf = (target: EventTarget | null): HTMLElement | null => (target instanceof Element ? target.closest<HTMLElement>('[data-block]') : null);

  const begin = useCallback(
    (host: HTMLElement): Editing | null => {
      const key = host.dataset.block!;
      if (editing.current?.key === key) return editing.current;
      const r = ranges.current.get(key);
      if (!r) return null;
      editing.current = { key, from: r.from, to: r.to, source: r.source, baseline: markdownOf(host, false), text: ctl.text, defs: r.defs, placeholder: host.dataset.placeholder };
      return editing.current;
    },
    [ctl],
  );

  /** Write the block's Markdown into the text, replacing its lines. */
  const commit = useCallback(
    (host: HTMLElement) => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
      commitTimer.current = null;
      const e = editing.current;
      if (!e || e.key !== host.dataset.block || e.text !== ctl.text || host.querySelector(`[${PENDING_ATTR}]`)) return;
      const md = markdownOf(host);
      const insert = md === e.baseline ? e.source : md;
      if (ctl.text.slice(e.from, e.to) === insert) return;
      const r = spliceBlock(ctl.text, e.from, e.to, insert);
      // The blocks after this one moved; a block focused before the page draws again must find its place.
      const delta = r.text.length - ctl.text.length;
      for (const range of ranges.current.values()) {
        if (range.from >= e.to) {
          range.from += delta;
          range.to += delta;
        }
      }
      e.from = r.from;
      e.to = r.to;
      e.text = r.text;
      ctl.setText(r.text);
    },
    [ctl],
  );

  /** The block lost the focus: written one last time, then drawn again from the text. */
  const finish = useCallback(
    (host: HTMLElement) => {
      commit(host);
      const e = editing.current;
      if (!e || e.key !== host.dataset.block || host.querySelector(`[${PENDING_ATTR}]`)) return;
      editing.current = null;
      if (e.key.startsWith(NEW_BLOCK)) setNewBlock((n) => n + 1);
      rerender((n) => n + 1);
    },
    [commit],
  );

  /** Put a picture at the selection: shown at once from memory, then stored beside the document and written as a link to it. */
  const insertPicture = async (host: HTMLElement, file: File) => {
    if (!begin(host)) return;
    const id = String(Math.random()).slice(2);
    const local = URL.createObjectURL(file);
    document.execCommand('insertHTML', false, `<img ${PENDING_ATTR}="${id}" src="${local}" alt="">`);
    const md = await storeImage(file);
    const img = host.querySelector<HTMLImageElement>(`[${PENDING_ATTR}="${id}"]`);
    const m = md && /^!\[(.*)\]\((.*)\)$/.exec(md);
    if (img) {
      if (m) {
        img.alt = m[1];
        img.setAttribute(SOURCE_ATTR, m[2]);
        img.src = imageSrc(m[2], folder, root) ?? m[2];
        img.removeAttribute(PENDING_ATTR);
      } else img.remove();
    }
    URL.revokeObjectURL(local);
    if (!host.isConnected) return;
    begin(host);
    if (host.contains(document.activeElement)) commit(host);
    else finish(host);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const host = hostOf(e.target);
    if (!host || host.contentEditable !== 'true') return;
    const sel = window.getSelection();
    const inCode = !!sel?.anchorNode && !!(sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode.parentElement)?.closest('pre');
    if (e.key === 'Enter' && inCode && !e.shiftKey) {
      // A new line in a code block, not a new paragraph.
      e.preventDefault();
      document.execCommand('insertText', false, '\n');
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowRight') && caretAtEdge(host, true)) {
      const next = nextEditable(host, 1);
      if (next) {
        e.preventDefault();
        focusBlock(next, false);
      }
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowLeft') && caretAtEdge(host, false)) {
      const prev = nextEditable(host, -1);
      if (prev) {
        e.preventDefault();
        focusBlock(prev, true);
      }
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLElement>) => {
    const host = hostOf(e.target);
    const file = host && imageIn(e.clipboardData);
    if (!host || !file) return;
    e.preventDefault();
    void insertPicture(host, file);
  };

  const onDrop = (e: DragEvent<HTMLElement>) => {
    const host = hostOf(e.target);
    const file = host && host.contentEditable === 'true' && imageIn(e.dataTransfer);
    if (!host || !file) return;
    e.preventDefault();
    // The picture goes where it was dropped.
    const at = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    host.focus();
    if (at) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(at);
    }
    void insertPicture(host, file);
  };

  // A link in an editable block puts the caret in it; with ⌘ or Ctrl held it opens.
  const onClick = (e: MouseEvent<HTMLElement>) => {
    const a = e.target instanceof Element ? e.target.closest('a') : null;
    if (a && (e.metaKey || e.ctrlKey) && a.href) {
      e.preventDefault();
      window.open(a.href, '_blank', 'noopener');
    }
  };

  return (
    <article
      className="markdown-body md-preview-body md-wy"
      onFocus={(e) => {
        const host = hostOf(e.target);
        if (host?.contentEditable === 'true') begin(host);
      }}
      onBlur={(e) => {
        const host = hostOf(e.target);
        if (host && !host.contains(e.relatedTarget as Node | null)) finish(host);
      }}
      onInput={(e) => {
        const host = hostOf(e.target);
        if (!host || !begin(host)) return;
        if (commitTimer.current) clearTimeout(commitTimer.current);
        // A ticked box is written at once; typing a moment after the last key.
        if (e.target instanceof HTMLInputElement) commit(host);
        else commitTimer.current = setTimeout(() => commit(host), 250);
      }}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files') && hostOf(e.target)) e.preventDefault();
      }}
      onDrop={onDrop}
      onClick={onClick}
      onMouseDown={(e) => {
        // A click on the page around the blocks, below the last, starts a new one at the end.
        if (e.target !== e.currentTarget) return;
        const blocks = e.currentTarget.querySelectorAll<HTMLElement>('.md-wy-block');
        const last = blocks[blocks.length - 1];
        if (last && e.clientY > last.getBoundingClientRect().top) {
          e.preventDefault();
          focusBlock(last, true);
        }
      }}
    >
      {items}
    </article>
  );
}

function placeholderFor(text: string): string {
  return text.trim() ? 'Click to add more…' : 'Start writing here, or type Markdown on the left…';
}

/** The editable block before or after this one. */
function nextEditable(host: HTMLElement, dir: 1 | -1): HTMLElement | null {
  let el = (dir > 0 ? host.nextElementSibling : host.previousElementSibling) as HTMLElement | null;
  while (el && el.contentEditable !== 'true') el = (dir > 0 ? el.nextElementSibling : el.previousElementSibling) as HTMLElement | null;
  return el;
}
