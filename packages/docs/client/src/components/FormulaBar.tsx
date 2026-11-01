import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { parseRangeString, rangeToString } from '../../../shared/cellref.ts';
import type { SheetController } from '../state/controller.ts';
import { useController } from '../state/useController.ts';

export function FormulaBar({ ctl }: { ctl: SheetController }) {
  useController(ctl);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const edit = ctl.edit;
  const sel = ctl.sel;
  const { r, c } = sel.active;
  const raw = ctl.store.cell(ctl.tab.id, r, c)?.v ?? '';
  const value = edit ? edit.text : raw;
  const multi = sel.ranges.length === 1 && (ctl.primary.r1 !== ctl.primary.r2 || ctl.primary.c1 !== ctl.primary.c2);
  const nameText = multi ? rangeToString(ctl.primary) : rangeToString({ r1: r, c1: c, r2: r, c2: c });
  const [name, setName] = useState(nameText);
  const [nameFocused, setNameFocused] = useState(false);
  useEffect(() => {
    if (!nameFocused) setName(nameText);
  }, [nameText, nameFocused]);

  // Keep the caret in sync with controller-driven edits while the bar has focus.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || !edit || edit.source !== 'bar' || document.activeElement !== el) return;
    if (el.selectionStart !== edit.caret) el.setSelectionRange(edit.caret, edit.caret);
  }, [edit]);

  const goTo = () => {
    const rg = parseRangeString(name, ctl.tab.rows, ctl.tab.cols);
    if (rg && rg.r2 < ctl.tab.rows && rg.c2 < ctl.tab.cols) ctl.selectRange(rg);
    else setName(nameText);
    setNameFocused(false);
    ctl.emit();
  };

  return (
    <div className="formula-bar">
      <input
        className="name-box"
        aria-label="Name box"
        value={name}
        onFocus={(e) => {
          setNameFocused(true);
          e.currentTarget.select();
        }}
        onBlur={() => setNameFocused(false)}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            goTo();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setName(nameText);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <span className="fx">fx</span>
      <textarea
        ref={inputRef}
        className="formula-input"
        aria-label="Formula bar"
        rows={1}
        spellCheck={false}
        value={value}
        onFocus={() => {
          if (!ctl.edit) ctl.beginEdit({ mode: 'edit', source: 'bar' });
          else ctl.setEditMode('edit', 'bar');
        }}
        onChange={(e) => {
          if (!ctl.edit) ctl.beginEdit({ mode: 'edit', source: 'bar' });
          ctl.setEditText(e.target.value, e.target.selectionStart);
        }}
        onKeyUp={(e) => ctl.setEditCaret(e.currentTarget.selectionStart)}
        onClick={(e) => ctl.setEditCaret(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.altKey && !e.shiftKey) {
            e.preventDefault();
            ctl.commitEdit([1, 0]);
            inputRef.current?.blur();
          } else if (e.key === 'Enter' && e.altKey) {
            e.preventDefault();
            const el = e.currentTarget;
            const s = el.selectionStart;
            ctl.setEditText(value.slice(0, s) + '\n' + value.slice(el.selectionEnd), s + 1);
          } else if (e.key === 'Tab') {
            e.preventDefault();
            ctl.commitEdit([0, e.shiftKey ? -1 : 1]);
            inputRef.current?.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            ctl.cancelEdit();
            inputRef.current?.blur();
          }
        }}
      />
    </div>
  );
}
