import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

export type MenuItem =
  | 'sep'
  | {
      label: ReactNode;
      shortcut?: string;
      action?: () => void;
      disabled?: boolean;
      danger?: boolean;
      checked?: boolean;
      submenu?: MenuItem[];
    };

/** A dropdown list of commands. Mouse-down is prevented so the grid keeps keyboard focus. */
export function MenuList({ items, onDone, style }: { items: MenuItem[]; onDone: () => void; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [pos, setPos] = useState<CSSProperties>(style ?? {});

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !style) return;
    const r = el.getBoundingClientRect();
    const next: CSSProperties = { ...style };
    const overRight = r.right - (window.innerWidth - 4);
    const overBottom = r.bottom - (window.innerHeight - 4);
    if (overRight > 0 && typeof style.left === 'number') next.left = style.left - overRight;
    if (overBottom > 0 && typeof style.top === 'number') next.top = Math.max(style.position === 'fixed' ? 4 : -Infinity, style.top - overBottom);
    if (next.left !== pos.left || next.top !== pos.top) setPos(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style?.left, style?.top]);

  return (
    <div className="menu" ref={ref} style={pos} onMouseDown={(e) => e.preventDefault()} role="menu">
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="menu-sep" />
        ) : (
          <div
            key={i}
            role="menuitem"
            aria-disabled={it.disabled}
            className={`menu-item${it.disabled ? ' disabled' : ''}${it.danger ? ' danger' : ''}${open === i ? ' open' : ''}`}
            onMouseEnter={() => setOpen(it.submenu ? i : null)}
            onClick={(e) => {
              e.stopPropagation();
              if (it.disabled || it.submenu) return;
              onDone();
              it.action?.();
            }}
          >
            <span className="menu-check">{it.checked ? '✓' : ''}</span>
            <span className="menu-label">{it.label}</span>
            {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
            {it.submenu && <span className="menu-arrow">▸</span>}
            {it.submenu && open === i && (
              <div className="submenu-anchor">
                <MenuList items={it.submenu} onDone={onDone} />
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}
