import { useEffect, useRef, useState } from 'react';
import { formatGeneralNumber } from '../../../shared/values.ts';
import type { CommandHost } from '../commands.ts';
import { useController } from '../state/useController.ts';
import { MenuList } from './Menu.tsx';

function TabName({ host, tabId, name }: { host: CommandHost; tabId: string; name: string }) {
  const { ctl } = host;
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (commit && value.trim() !== name) {
      const problem = ctl.renameTab(tabId, value);
      if (problem) {
        setError(problem);
        host.notify(problem);
        return;
      }
    }
    ctl.setRenamingTab(null);
  };
  return (
    <input
      ref={ref}
      className={`tab-rename${error ? ' invalid' : ''}`}
      value={value}
      size={Math.max(4, value.length)}
      onChange={(e) => {
        setValue(e.target.value);
        setError(null);
      }}
      onBlur={() => finish(!error)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') ctl.setRenamingTab(null);
      }}
    />
  );
}

type StatKey = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'numCount';
const STAT_LABELS: Record<StatKey, string> = { sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max', count: 'Count', numCount: 'Count numbers' };

function SelectionStats({ host }: { host: CommandHost }) {
  const { ctl } = host;
  const [which, setWhich] = useState<StatKey>('sum');
  const [open, setOpen] = useState(false);
  const stats = ctl.selectionStats();
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  if (!stats) return null;
  const effective: StatKey = stats.numCount === 0 && which !== 'count' ? 'count' : which;
  const fmt = (k: StatKey) => (k === 'count' || k === 'numCount' ? String(stats[k]) : formatGeneralNumber(stats[k]));
  return (
    <div className="stats" onMouseDown={(e) => e.stopPropagation()}>
      <button className="stats-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>
        {STAT_LABELS[effective]}: {fmt(effective)} ▾
      </button>
      {open && (
        <div className="stats-menu" onMouseDown={(e) => e.preventDefault()}>
          {(Object.keys(STAT_LABELS) as StatKey[])
            .filter((k) => stats.numCount > 0 || k === 'count')
            .map((k) => (
              <button
                key={k}
                className={k === effective ? 'active' : ''}
                onClick={() => {
                  setWhich(k);
                  setOpen(false);
                }}
              >
                <span>{STAT_LABELS[k]}</span>
                <span>{fmt(k)}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

export function TabBar({ host }: { host: CommandHost }) {
  const { ctl } = host;
  useController(ctl);
  const tabs = ctl.store.workbook.tabs;
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [ctl.activeTabId]);

  useEffect(() => {
    if (!listOpen) return;
    const close = () => setListOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [listOpen]);

  return (
    <div className="tabbar">
      <button className="tab-icon-btn" title="Add sheet" aria-label="Add sheet" onMouseDown={(e) => e.preventDefault()} onClick={() => ctl.addTab()}>
        +
      </button>
      <div className="tb-drop" onMouseDown={(e) => e.stopPropagation()}>
        <button className="tab-icon-btn" title="All sheets" aria-label="All sheets" onMouseDown={(e) => e.preventDefault()} onClick={() => setListOpen(!listOpen)}>
          ☰
        </button>
        {listOpen && (
          <MenuList
            style={{ bottom: 34, left: 0 }}
            items={tabs.map((t) => ({ label: t.name, checked: t.id === ctl.activeTabId, action: () => ctl.switchTab(t.id) }))}
            onDone={() => setListOpen(false)}
          />
        )}
      </div>
      <div className="tabs" role="tablist">
        {tabs.map((t, i) => {
          const active = t.id === ctl.activeTabId;
          return (
            <div
              key={t.id}
              ref={active ? activeRef : undefined}
              role="tab"
              aria-selected={active}
              className={`tab${active ? ' active' : ''}${overIdx === i && dragIdx !== null && dragIdx !== i ? ' drop-target' : ''}`}
              draggable={ctl.renamingTabId !== t.id}
              onDragStart={(e) => {
                setDragIdx(i);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', t.name);
              }}
              onDragOver={(e) => {
                if (dragIdx === null) return;
                e.preventDefault();
                setOverIdx(i);
              }}
              onDragLeave={() => setOverIdx((o) => (o === i ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIdx !== null) ctl.moveTab(dragIdx, i);
                setDragIdx(null);
                setOverIdx(null);
              }}
              onDragEnd={() => {
                setDragIdx(null);
                setOverIdx(null);
              }}
              onMouseDown={(e) => {
                if (ctl.renamingTabId === t.id) return;
                if (e.button === 0) ctl.switchTab(t.id);
              }}
              onDoubleClick={() => ctl.setRenamingTab(t.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                ctl.switchTab(t.id);
                ctl.openMenu({ kind: 'tab', tabId: t.id, x: e.clientX, y: e.clientY });
              }}
            >
              {ctl.renamingTabId === t.id ? <TabName host={host} tabId={t.id} name={t.name} /> : <span className="tab-name">{t.name}</span>}
              {t.filter && <span className="tab-filter-dot" title="Filter active" />}
              <button
                className="tab-caret"
                aria-label={`Options for ${t.name}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  ctl.switchTab(t.id);
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  ctl.openMenu({ kind: 'tab', tabId: t.id, x: r.left, y: r.top - 190 });
                }}
              >
                ▾
              </button>
            </div>
          );
        })}
      </div>
      <SelectionStats host={host} />
    </div>
  );
}
