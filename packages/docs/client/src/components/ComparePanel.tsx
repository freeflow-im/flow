import { colToName } from '../../../shared/cellref.ts';
import type { CellData } from '../../../shared/types.ts';
import type { RowDiff, Side, TabDiff } from '../../../shared/diff.ts';
import { CHANGE_COLORS } from '../grid/render.ts';
import type { SheetController } from '../state/controller.ts';
import { useController } from '../state/useController.ts';

const SIDE_LABEL: Record<Side, string> = { mine: 'Yours', theirs: 'Original', conflict: 'Conflict' };
const MAX_ITEMS = 400;

const val = (c: CellData | undefined) => (c?.v ? c.v : '∅');

function rowPreview(r: RowDiff): string {
  const vals = Object.entries(r.cells)
    .sort((a, b) => +a[0] - +b[0])
    .map(([, c]) => c.v)
    .filter(Boolean);
  const text = vals.slice(0, 4).join(' · ');
  return vals.length > 4 ? `${text} …` : text || '(blank row)';
}

function Badge({ side }: { side: Side }) {
  return (
    <span className="cmp-badge" style={{ background: CHANGE_COLORS[side].fill, color: CHANGE_COLORS[side].solid }}>
      {SIDE_LABEL[side]}
    </span>
  );
}

function tabChangeText(t: TabDiff): string {
  const { base, branch, original } = t.names;
  switch (t.change) {
    case 'added':
      return t.changeSide === 'mine' ? 'Sheet added in your branch' : t.changeSide === 'theirs' ? 'Sheet added to the original (not in your branch)' : 'Sheet added on both sides';
    case 'removed':
      return t.changeSide === 'mine'
        ? 'You deleted this sheet'
        : t.changeSide === 'theirs'
          ? 'Deleted from the original'
          : branch
            ? 'Deleted from the original, but you edited it'
            : 'You deleted this sheet, but the original edited it';
    case 'renamed':
      return t.changeSide === 'conflict'
        ? `Renamed on both sides: "${branch}" (yours) vs "${original}"`
        : t.changeSide === 'mine'
          ? `Renamed by you: "${base}" → "${branch}"`
          : `Renamed in the original: "${base}" → "${original}"`;
    default:
      return '';
  }
}

export function ComparePanel({ ctl }: { ctl: SheetController }) {
  useController(ctl);
  const cmp = ctl.compare!;
  const diff = cmp.diff;
  const data = cmp.data;
  const detached = data && !data.original;
  let shown = 0;

  return (
    <aside className="compare-panel" aria-label="Compare with original">
      <header className="cmp-head">
        <div>
          <div className="cmp-title">Compare with original</div>
          <div className="cmp-sub">{data ? `“${data.parentTitle}”` : 'Loading…'}</div>
        </div>
        <button className="icon-btn" title="Fetch the original's latest changes" aria-label="Refresh" onClick={() => void ctl.openCompare()} disabled={cmp.status === 'loading'}>
          ↻
        </button>
        <button className="icon-btn" title="Close comparison" aria-label="Close comparison" onClick={() => ctl.closeCompare()}>
          ✕
        </button>
      </header>

      {cmp.status === 'error' && <div className="form-error">{cmp.error}</div>}
      {detached && <div className="cmp-note">The original was deleted. Comparing with how it looked when you branched.</div>}

      {diff && (
        <>
          <div className="cmp-chips">
            {(['mine', 'theirs', 'conflict'] as Side[]).map((side) => (
              <button
                key={side}
                className={`cmp-chip${cmp.show[side] ? ' on' : ''}`}
                style={cmp.show[side] ? { borderColor: CHANGE_COLORS[side].solid, background: CHANGE_COLORS[side].fill } : undefined}
                aria-pressed={cmp.show[side]}
                onClick={() => ctl.setCompareFilter(side, !cmp.show[side])}
              >
                <span className="cmp-dot" style={{ background: CHANGE_COLORS[side].solid }} />
                {SIDE_LABEL[side]} <strong>{diff.counts[side]}</strong>
              </button>
            ))}
          </div>
          {data && <div className="cmp-meta">Original as of {new Date(data.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Your edits update live.</div>}

          <div className="cmp-list">
            {diff.tabs.length === 0 && <div className="cmp-empty">No differences. Your branch matches the original.</div>}
            {diff.tabs.map((t) => {
              const inBranch = !!t.names.branch;
              const cells = t.cells.filter((c) => cmp.show[c.side]);
              const rows = t.rows.filter((r) => cmp.show[r.side]);
              const tabVisible = t.change && t.changeSide && cmp.show[t.changeSide];
              if (!cells.length && !rows.length && !tabVisible) return null;
              return (
                <section key={t.tabId} className="cmp-tab">
                  <button className="cmp-tab-name" disabled={!inBranch} onClick={() => inBranch && ctl.switchTab(t.tabId)}>
                    {t.name}
                  </button>
                  {tabVisible && (
                    <div className="cmp-item static">
                      <Badge side={t.changeSide!} />
                      <span>{tabChangeText(t)}</span>
                    </div>
                  )}
                  {rows.map((r, i) => {
                    if (++shown > MAX_ITEMS) return null;
                    const what =
                      r.kind === 'added'
                        ? r.inBranch
                          ? `Row ${r.at + 1} added`
                          : `Row added in the original, before row ${r.at + 1}`
                        : r.inBranch
                          ? `Row ${r.at + 1} deleted from the original`
                          : `Row deleted, was before row ${r.at + 1}`;
                    return (
                      <button key={`r${i}`} className="cmp-item" disabled={!inBranch} onClick={() => ctl.revealCell(t.tabId, r.at, 0)}>
                        <Badge side={r.side} />
                        <span className="cmp-what">{what}</span>
                        <span className="cmp-vals">{rowPreview(r)}</span>
                      </button>
                    );
                  })}
                  {cells.map((c) => {
                    if (++shown > MAX_ITEMS) return null;
                    const ref = `${colToName(c.c)}${c.r + 1}`;
                    const vals =
                      c.side === 'mine'
                        ? `${val(c.base)} → ${val(c.branch)}`
                        : c.side === 'theirs'
                          ? `${val(c.base)} → ${val(c.original)}`
                          : `yours ${val(c.branch)} · original ${val(c.original)}`;
                    return (
                      <button key={`${c.r},${c.c}`} className="cmp-item" onClick={() => ctl.revealCell(t.tabId, c.r, c.c)}>
                        <Badge side={c.side} />
                        <span className="cmp-what">
                          {ref}
                          {c.formatOnly ? ' (format)' : ''}
                        </span>
                        <span className="cmp-vals" title={vals}>
                          {vals}
                        </span>
                      </button>
                    );
                  })}
                </section>
              );
            })}
            {shown > MAX_ITEMS && <div className="cmp-empty">Showing the first {MAX_ITEMS} changes.</div>}
          </div>
        </>
      )}
      {!diff && cmp.status === 'loading' && <div className="cmp-empty">Comparing…</div>}
    </aside>
  );
}
