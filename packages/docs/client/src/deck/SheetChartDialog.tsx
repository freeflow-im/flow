// "Chart from spreadsheet": pick one of the user's spreadsheets and one of its charts, see it, and put it on the
// slide, linked to the spreadsheet's chart (it then follows the chart and its data, linkedTables.ts) or as a copy.
import { useEffect, useMemo, useState } from 'react';
import { chartOfSlide, CHART_TYPE_NAMES, type LinkedChart, type SheetChartList } from '../../../shared/chart.ts';
import type { SheetMeta } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { ChartView } from '../chart/ChartView.tsx';
import { Modal } from '../components/Modal.tsx';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function SheetChartDialog({ onInsert, onClose }: { onInsert(sheetId: string, chartId: string, chart: LinkedChart, linked: boolean): void; onClose(): void }) {
  const [sheets, setSheets] = useState<SheetMeta[] | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [list, setList] = useState<SheetChartList | null>(null);
  const [chartId, setChartId] = useState<string | null>(null);
  const [chart, setChart] = useState<LinkedChart | null>(null);
  const [linked, setLinked] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listSheets()
      .then((r) => setSheets(r.sheets))
      .catch((e) => setError(message(e)));
  }, []);
  const shown = useMemo(() => (sheets ?? []).filter((s) => s.title.toLowerCase().includes(query.trim().toLowerCase())), [sheets, query]);

  const pickSheet = async (id: string) => {
    setPicked(id);
    setList(null);
    setChartId(null);
    setChart(null);
    setError(null);
    try {
      const l = await api.sheetCharts(id);
      setList(l);
      if (l.charts.length) void pickChart(id, l.charts[0].id);
    } catch (e) {
      setError(message(e));
    }
  };
  const pickChart = async (sheetId: string, id: string) => {
    setChartId(id);
    setChart(null);
    try {
      setChart(await api.sheetChart(sheetId, id));
    } catch (e) {
      setError(message(e));
    }
  };

  const previewW = 440;
  const previewH = chart ? Math.round(previewW * Math.min(1, chart.h / Math.max(1, chart.w))) : 260;
  return (
    <Modal title="Chart from spreadsheet" onClose={onClose} className="sheet-table-dialog">
      <div className="sheet-table-body">
        <div className="sheet-table-pick">
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your spreadsheets" aria-label="Search your spreadsheets" />
          <div className="sheet-table-list" role="listbox" aria-label="Spreadsheets">
            {sheets === null ? (
              !error && <div className="muted">Loading…</div>
            ) : shown.length === 0 ? (
              <div className="muted">{sheets.length ? 'No spreadsheet matches your search.' : 'You have no spreadsheets yet.'}</div>
            ) : (
              shown.map((s) => (
                <button key={s.id} role="option" aria-selected={picked === s.id} className={picked === s.id ? 'picked' : undefined} onClick={() => void pickSheet(s.id)}>
                  {s.title}
                </button>
              ))
            )}
          </div>
        </div>
        <div className="sheet-table-detail">
          {!picked ? (
            <div className="muted sheet-table-hint">Choose a spreadsheet.</div>
          ) : !list ? (
            <div className="muted sheet-table-hint">{error ? '' : 'Reading…'}</div>
          ) : !list.charts.length ? (
            <div className="muted sheet-table-hint">This spreadsheet has no charts. Make one there (Insert › Chart), then put it here.</div>
          ) : (
            <>
              <label className="field">
                <span>Chart</span>
                <select value={chartId ?? ''} onChange={(e) => picked && void pickChart(picked, e.target.value)}>
                  {list.charts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title || `${CHART_TYPE_NAMES[c.type]} chart`} · {c.tab}
                    </option>
                  ))}
                </select>
              </label>
              <div className="sheet-chart-preview">{chart ? <ChartView chart={chartOfSlide(chart.chart, previewW, previewH)} data={chart.data} width={previewW} height={previewH} /> : <div className="muted">Reading…</div>}</div>
              <label className="sheet-table-link">
                <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} />
                Keep it linked: the chart changes when the spreadsheet does
              </label>
            </>
          )}
        </div>
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!picked || !chartId || !chart}
          onClick={() => {
            if (!picked || !chartId || !chart) return;
            onInsert(picked, chartId, chart, linked);
            onClose();
          }}
        >
          Insert
        </button>
      </div>
    </Modal>
  );
}
