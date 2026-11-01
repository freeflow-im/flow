import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FilterConditionType } from '../../../shared/types.ts';
import type { SheetController } from '../state/controller.ts';

const CONDITIONS: { type: FilterConditionType; label: string; needsValue: boolean }[] = [
  { type: 'none', label: 'None', needsValue: false },
  { type: 'empty', label: 'Is empty', needsValue: false },
  { type: 'notEmpty', label: 'Is not empty', needsValue: false },
  { type: 'contains', label: 'Text contains', needsValue: true },
  { type: 'notContains', label: 'Text does not contain', needsValue: true },
  { type: 'startsWith', label: 'Text starts with', needsValue: true },
  { type: 'endsWith', label: 'Text ends with', needsValue: true },
  { type: 'eq', label: 'Is equal to', needsValue: true },
  { type: 'neq', label: 'Is not equal to', needsValue: true },
  { type: 'gt', label: 'Greater than', needsValue: true },
  { type: 'gte', label: 'Greater than or equal to', needsValue: true },
  { type: 'lt', label: 'Less than', needsValue: true },
  { type: 'lte', label: 'Less than or equal to', needsValue: true },
];

export function FilterMenu({ ctl }: { ctl: SheetController }) {
  const fm = ctl.filterMenu!;
  const f = ctl.tab.filter!;
  const existing = f.cols[fm.col];
  const values = useMemo(() => ctl.filterValues(fm.col), [ctl, fm.col]);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(existing?.hidden ?? []));
  const [condType, setCondType] = useState<FilterConditionType>(existing?.cond?.type ?? 'none');
  const [condValue, setCondValue] = useState(existing?.cond?.value ?? '');
  const [search, setSearch] = useState('');
  const [section, setSection] = useState<'cond' | 'values'>(existing?.cond && existing.cond.type !== 'none' ? 'cond' : 'values');
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: fm.x - 260, top: fm.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(fm.x - r.width, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(fm.y, window.innerHeight - r.height - 4)),
    });
  }, [fm.x, fm.y]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) ctl.openFilterMenu(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') ctl.openFilterMenu(null);
    };
    // Defer so the mousedown that opened the menu doesn't immediately close it.
    const t = setTimeout(() => window.addEventListener('mousedown', close));
    window.addEventListener('keydown', key);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [ctl]);

  const shown = values.filter((v) => (v.value || '(Blanks)').toLowerCase().includes(search.toLowerCase()));
  const cond = CONDITIONS.find((c) => c.type === condType)!;

  const apply = () => {
    ctl.setColumnFilter(fm.col, {
      hidden: hidden.size ? [...hidden] : undefined,
      cond: condType !== 'none' ? { type: condType, value: cond.needsValue ? condValue : undefined } : undefined,
    });
    ctl.openFilterMenu(null);
  };

  return (
    <div className="filter-menu" ref={ref} style={pos} role="dialog" aria-label="Filter">
      <button className="fm-action" onClick={() => (ctl.sortFilterColumn(fm.col, true), ctl.openFilterMenu(null))}>
        Sort A → Z
      </button>
      <button className="fm-action" onClick={() => (ctl.sortFilterColumn(fm.col, false), ctl.openFilterMenu(null))}>
        Sort Z → A
      </button>
      <div className="fm-sep" />
      <button className="fm-section" onClick={() => setSection(section === 'cond' ? 'values' : 'cond')} aria-expanded={section === 'cond'}>
        {section === 'cond' ? '▾' : '▸'} Filter by condition
      </button>
      {section === 'cond' && (
        <div className="fm-body">
          <select value={condType} onChange={(e) => setCondType(e.target.value as FilterConditionType)} aria-label="Condition">
            {CONDITIONS.map((c) => (
              <option key={c.type} value={c.type}>
                {c.label}
              </option>
            ))}
          </select>
          {cond.needsValue && (
            <input
              placeholder="Value"
              value={condValue}
              onChange={(e) => setCondValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
              autoFocus
            />
          )}
        </div>
      )}
      <button className="fm-section" onClick={() => setSection(section === 'values' ? 'cond' : 'values')} aria-expanded={section === 'values'}>
        {section === 'values' ? '▾' : '▸'} Filter by values
      </button>
      {section === 'values' && (
        <div className="fm-body">
          <div className="fm-links">
            <button className="link" onClick={() => setHidden(new Set())}>
              Select all {values.length}
            </button>
            <span> - </span>
            <button className="link" onClick={() => setHidden(new Set(values.map((v) => v.value)))}>
              Clear
            </button>
          </div>
          <input placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search values" />
          <div className="fm-values">
            {shown.map((v) => (
              <label key={v.value} className="fm-value">
                <input
                  type="checkbox"
                  checked={!hidden.has(v.value)}
                  onChange={(e) => {
                    const next = new Set(hidden);
                    if (e.target.checked) next.delete(v.value);
                    else next.add(v.value);
                    setHidden(next);
                  }}
                />
                <span className="fm-value-text">{v.value || '(Blanks)'}</span>
                <span className="fm-count">{v.count}</span>
              </label>
            ))}
            {!shown.length && <div className="muted">No matching values</div>}
          </div>
        </div>
      )}
      <div className="fm-footer">
        <button className="btn" onClick={() => ctl.openFilterMenu(null)}>
          Cancel
        </button>
        <button className="btn primary" onClick={apply}>
          OK
        </button>
      </div>
    </div>
  );
}
