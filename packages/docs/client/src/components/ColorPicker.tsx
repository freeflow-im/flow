// A toolbar color swatch picker shared by the slide and document editors.
import { useEffect, useState, type ReactNode } from 'react';

export const PALETTE = [
  ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff'],
  ['#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff'],
  ['#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc'],
  ['#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0'],
  ['#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79'],
];

export function ColorPicker({ title, icon, value, onPick, disabled, resetLabel = 'Theme default' }: { title: string; icon: ReactNode; value?: string; onPick: (c: string | undefined) => void; disabled?: boolean; resetLabel?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="tb-drop" onMouseDown={(e) => e.stopPropagation()}>
      <button className={`tb-btn${open ? ' active' : ''}`} title={title} aria-label={title} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>
        <span className="color-icon">
          {icon}
          <span className="color-bar" style={{ background: value ?? 'transparent', borderColor: value ?? '#999' }} />
        </span>
      </button>
      {open && (
        <div className="palette">
          <button
            className="palette-reset"
            onClick={() => {
              onPick(undefined);
              setOpen(false);
            }}
          >
            {resetLabel}
          </button>
          {PALETTE.map((row, i) => (
            <div key={i} className="palette-row">
              {row.map((c) => (
                <button
                  key={c}
                  className={`swatch${value === c ? ' active' : ''}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => {
                    onPick(c);
                    setOpen(false);
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
