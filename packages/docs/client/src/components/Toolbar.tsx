import { useEffect, useState, type ReactNode } from 'react';
import { insertChart, MOD, numberFormatItems, type CommandHost } from '../commands.ts';
import { useController } from '../state/useController.ts';
import { MenuList } from './Menu.tsx';

const PALETTE = [
  ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff'],
  ['#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff'],
  ['#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc'],
  ['#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd'],
  ['#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0'],
  ['#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79'],
];

function Btn({ title, active, onClick, children, disabled }: { title: string; active?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      className={`tb-btn${active ? ' active' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ColorPicker({ title, icon, value, onPick }: { title: string; icon: ReactNode; value?: string; onPick: (c: string | undefined) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="tb-drop">
      <Btn title={title} onClick={() => setOpen(!open)}>
        <span className="color-icon">
          {icon}
          <span className="color-bar" style={{ background: value ?? 'transparent', borderColor: value ? value : '#bbb' }} />
        </span>
      </Btn>
      {open && (
        <div className="palette" onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}>
          <button
            className="palette-reset"
            onClick={() => {
              onPick(undefined);
              setOpen(false);
            }}
          >
            Reset
          </button>
          {PALETTE.map((row, i) => (
            <div key={i} className="palette-row">
              {row.map((c) => (
                <button
                  key={c}
                  className={`swatch${value === c ? ' sel' : ''}`}
                  style={{ background: c }}
                  title={c}
                  aria-label={c}
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

function FormatDropdown({ host }: { host: CommandHost }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="tb-drop" onMouseDown={(e) => e.stopPropagation()}>
      <Btn title="More formats" onClick={() => setOpen(!open)}>
        123 ▾
      </Btn>
      {open && <MenuList items={numberFormatItems(host.ctl)} onDone={() => setOpen(false)} style={{ top: 30, left: 0 }} />}
    </div>
  );
}

export function Toolbar({ host }: { host: CommandHost }) {
  const { ctl } = host;
  useController(ctl);
  const st = ctl.activeCellStyle();
  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <Btn title={`Undo (${MOD}Z)`} onClick={() => ctl.undo()} disabled={!ctl.store.canUndo()}>
        ↶
      </Btn>
      <Btn title={`Redo (${MOD}Y)`} onClick={() => ctl.redo()} disabled={!ctl.store.canRedo()}>
        ↷
      </Btn>
      <span className="tb-sep" />
      <Btn title="Format as currency" active={st.fmt === 'currency'} onClick={() => ctl.setStyle({ fmt: st.fmt === 'currency' ? undefined : 'currency', dp: undefined })}>
        $
      </Btn>
      <Btn title="Format as percent" active={st.fmt === 'percent'} onClick={() => ctl.setStyle({ fmt: st.fmt === 'percent' ? undefined : 'percent', dp: undefined })}>
        %
      </Btn>
      <Btn title="Decrease decimal places" onClick={() => ctl.adjustDecimals(-1)}>
        .0
      </Btn>
      <Btn title="Increase decimal places" onClick={() => ctl.adjustDecimals(1)}>
        .00
      </Btn>
      <FormatDropdown host={host} />
      <span className="tb-sep" />
      <Btn title={`Bold (${MOD}B)`} active={!!st.b} onClick={() => ctl.toggleStyle('b')}>
        <b>B</b>
      </Btn>
      <Btn title={`Italic (${MOD}I)`} active={!!st.i} onClick={() => ctl.toggleStyle('i')}>
        <i style={{ fontFamily: 'serif' }}>I</i>
      </Btn>
      <Btn title="Strikethrough" active={!!st.s} onClick={() => ctl.toggleStyle('s')}>
        <s>S</s>
      </Btn>
      <Btn title={`Underline (${MOD}U)`} active={!!st.u} onClick={() => ctl.toggleStyle('u')}>
        <u>U</u>
      </Btn>
      <ColorPicker title="Text color" icon={<span className="a-icon">A</span>} value={st.color} onPick={(c) => ctl.setStyle({ color: c })} />
      <ColorPicker title="Fill color" icon={<span className="fill-icon">◧</span>} value={st.bg} onPick={(c) => ctl.setStyle({ bg: c })} />
      <span className="tb-sep" />
      <Btn title="Align left" active={st.align === 'left'} onClick={() => ctl.setStyle({ align: st.align === 'left' ? undefined : 'left' })}>
        <AlignIcon kind="left" />
      </Btn>
      <Btn title="Align center" active={st.align === 'center'} onClick={() => ctl.setStyle({ align: st.align === 'center' ? undefined : 'center' })}>
        <AlignIcon kind="center" />
      </Btn>
      <Btn title="Align right" active={st.align === 'right'} onClick={() => ctl.setStyle({ align: st.align === 'right' ? undefined : 'right' })}>
        <AlignIcon kind="right" />
      </Btn>
      <Btn title="Wrap text" active={!!st.wrap} onClick={() => ctl.toggleStyle('wrap')}>
        <WrapIcon />
      </Btn>
      <span className="tb-sep" />
      <Btn title={ctl.tab.filter ? 'Remove filter' : 'Create a filter'} active={!!ctl.tab.filter} onClick={() => (ctl.tab.filter ? ctl.removeFilter() : ctl.createFilter())}>
        <FilterIcon />
      </Btn>
      <Btn title="Insert chart" onClick={() => insertChart(host)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 14h12M4 12V8M7.3 12V4M10.6 12V6.5M13.5 12V2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </Btn>
      <Btn title={`Clear formatting (${MOD}\\)`} onClick={() => ctl.clearFormatting()}>
        T̸
      </Btn>
    </div>
  );
}

function AlignIcon({ kind }: { kind: 'left' | 'center' | 'right' }) {
  const lines = [14, 9, 14, 9];
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
      {lines.map((w, i) => {
        const x = kind === 'left' ? 1 : kind === 'right' ? 15 - w : (16 - w) / 2;
        return <rect key={i} x={x} y={1 + i * 3.5} width={w} height="1.6" fill="currentColor" />;
      })}
    </svg>
  );
}

function WrapIcon() {
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
      <rect x="1" y="1" width="14" height="1.6" fill="currentColor" />
      <path d="M1 6.5h10.5a2.5 2.5 0 0 1 0 5H8" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9.5 9.5 7.5 11.5l2 2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="1" y="10.7" width="4" height="1.6" fill="currentColor" />
    </svg>
  );
}

export function FilterIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 3h12l-4.5 5.5V13l-3-1.5V8.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}
