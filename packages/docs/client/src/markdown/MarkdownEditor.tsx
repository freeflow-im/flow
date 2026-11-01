// The plain text editor of a Markdown document (the page around it is MarkdownPage; the plugin has its own).
import { memo, useEffect, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';
import type { TextEdit } from '../../../shared/agent/markdownBlocks.ts';
import type { MarkdownController } from './controller.ts';

/**
 * Replace text[from, to) in the textarea as the user would type it, so the change joins the browser's undo
 * history (setRangeText does not). Falls back to setRangeText where execCommand is unavailable.
 */
export function replaceRange(ta: HTMLTextAreaElement, from: number, to: number, text: string) {
  ta.focus();
  ta.setSelectionRange(from, to);
  let done = false;
  try {
    done = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
  } catch {
    done = false;
  }
  if (!done || ta.value.slice(from, from + text.length) !== text) {
    ta.setRangeText(text, from, to, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** Wrap the textarea's selection (or insert placeholder text) keeping the browser's undo history. */
export function wrapSelection(ta: HTMLTextAreaElement, before: string, after: string, placeholder: string) {
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const selected = value.slice(s, e);
  const inner = selected || placeholder;
  replaceRange(ta, s, e, before + inner + after);
  ta.setSelectionRange(s + before.length, s + before.length + inner.length);
}

/**
 * The text editor. It is memoized with stable props so React never updates the textarea after mounting it:
 * a controlled (or re-rendered) textarea has its defaultValue rewritten by React on every render, which
 * clears the browser's undo history. The textarea owns the text; the controller mirrors it, and only a
 * version saved elsewhere is written back into the element.
 */
export const MarkdownEditor = memo(function MarkdownEditor({ ctl, editorRef, previewRef }: { ctl: MarkdownController; editorRef: RefObject<HTMLTextAreaElement | null>; previewRef: RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    const ta = editorRef.current;
    if (!ta) return;
    ta.value = ctl.text;
    // The assistant's edits go through the textarea so they join the browser's undo history.
    ctl.onApplyEdit = (edit: TextEdit) => {
      replaceRange(ta, edit.from, edit.to, edit.insert);
      const lines = ta.value.split('\n').length;
      const line = ta.value.slice(0, edit.from).split('\n').length - 1;
      // Scroll the change into view (the textarea's lines are roughly even in height).
      ta.scrollTop = Math.max(0, (line / Math.max(1, lines)) * ta.scrollHeight - ta.clientHeight / 3);
    };
    // A version saved elsewhere replaces the text (that one change is not undoable).
    const unsub = ctl.subscribe(() => {
      if (ta.value !== ctl.text) ta.value = ctl.text;
    });
    return () => {
      ctl.onApplyEdit = null;
      unsub();
    };
  }, [ctl, editorRef]);

  // Keep the preview roughly in step with the editor while scrolling it.
  const syncScroll = (e: SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const pv = previewRef.current;
    if (!pv) return;
    const max = ta.scrollHeight - ta.clientHeight;
    if (max <= 0) return;
    pv.scrollTop = (ta.scrollTop / max) * (pv.scrollHeight - pv.clientHeight);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Tab' && !mod) {
      e.preventDefault();
      replaceRange(ta, ta.selectionStart, ta.selectionEnd, '  ');
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      wrapSelection(ta, '**', '**', 'bold text');
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      wrapSelection(ta, '_', '_', 'italic text');
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      wrapSelection(ta, '[', '](https://)', 'link text');
    }
  };

  return (
    <textarea
      ref={editorRef}
      className="md-editor"
      spellCheck
      aria-label="Markdown text"
      placeholder="# Start writing Markdown…"
      onInput={(e) => {
        ctl.cursor = e.currentTarget.selectionStart;
        ctl.setText(e.currentTarget.value);
      }}
      onSelect={(e) => {
        ctl.cursor = e.currentTarget.selectionStart;
      }}
      onKeyDown={onKeyDown}
      onScroll={syncScroll}
    />
  );
});
