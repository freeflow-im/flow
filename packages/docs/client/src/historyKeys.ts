import { useEffect } from 'react';

/**
 * Whether a key is going to text being typed, where Cmd+arrows move the caret. The grid keeps the focus
 * in its cell editor even when no cell is being edited; it marks the editing with data-typing.
 */
const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.classList.contains('cell-editor') ? t.hasAttribute('data-typing') : t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement);

/**
 * Back and Forward from the keyboard as a browser has them (Cmd+Left/Right and Cmd+[/], Alt+Left/Right
 * elsewhere), for the desktop app, whose windows have none. In a browser they are the browser's own.
 * They give way to the page: a key typed into text, or one an editor took (the grid's Cmd+arrow jumps,
 * so in a spreadsheet Back is Cmd+[).
 */
export function useHistoryKeys(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    const mac = /Mac/.test(navigator.platform);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.shiftKey || typing(e.target)) return;
      const mod = mac ? e.metaKey && !e.altKey && !e.ctrlKey : e.altKey && !e.metaKey && !e.ctrlKey;
      if (!mod) return;
      const back = e.key === 'ArrowLeft' || (mac && e.key === '[');
      const forward = e.key === 'ArrowRight' || (mac && e.key === ']');
      if (!back && !forward) return;
      e.preventDefault();
      if (back) history.back();
      else history.forward();
    };
    // Bubbling, after the page's own handlers have had the key.
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [on]);
}
