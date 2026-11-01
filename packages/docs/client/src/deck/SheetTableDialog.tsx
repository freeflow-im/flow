// "Table from spreadsheet": pick one of the user's spreadsheets, a tab and a range (its used part to start with),
// see the cells, and put them on the slide as a table, linked to the range (it then follows the spreadsheet,
// client/src/deck/linkedTables.ts) or as a copy.
import { useEffect, useMemo, useState } from 'react';
import type { SheetMeta } from '../../../shared/types.ts';
import type { LinkedTable, SheetTableRef } from '../../../shared/sheetTable.ts';
import { api } from '../api.ts';
import { Modal } from '../components/Modal.tsx';

const PREVIEW_ROWS = 8;
const PREVIEW_COLS = 8;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function SheetTableDialog({ onInsert, onClose }: { /** `used`: the range is the tab's used part, which the table then follows. */ onInsert(sheetId: string, table: LinkedTable, linked: boolean, used: boolean): void; onClose(): void }) {
  const [sheets, setSheets] = useState<SheetMeta[] | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [table, setTable] = useState<LinkedTable | null>(null);
  const [range, setRange] = useState('');
  /** The tab's used part, as read when no range was asked for. */
  const [usedRange, setUsedRange] = useState<string | null>(null);
  const [linked, setLinked] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listSheets()
      .then((r) => setSheets(r.sheets))
      .catch((e) => setError(message(e)));
  }, []);

  const shown = useMemo(() => (sheets ?? []).filter((s) => s.title.toLowerCase().includes(query.trim().toLowerCase())), [sheets, query]);

  /** Read the cells for the picked spreadsheet; the tab's used part when no range is given. */
  const read = async (id: string, ref: SheetTableRef) => {
    setLoading(true);
    setError(null);
    try {
      const t = await api.sheetTable(id, ref);
      setTable(t);
      setRange(t.range);
      if (!ref.range) setUsedRange(t.range);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  };

  // Left at the tab's used part, a linked table follows it (rows added at the bottom show up).
  const following = !!table && linked && table.range === usedRange && range === usedRange;

  const pick = (id: string) => {
    setPicked(id);
    setTable(null);
    void read(id, {});
  };

  return (
    <Modal title="Table from spreadsheet" onClose={onClose} className="sheet-table-dialog">
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
                <button key={s.id} role="option" aria-selected={picked === s.id} className={picked === s.id ? 'picked' : undefined} onClick={() => pick(s.id)} title={s.folder ? `${s.folder}/${s.title}` : s.title}>
                  {s.title}
                  {s.folder ? <span className="muted"> · {s.folder}</span> : null}
                </button>
              ))
            )}
          </div>
        </div>
        <div className="sheet-table-detail">
          {picked && table ? (
            <>
              <div className="sheet-table-fields">
                <label className="field">
                  <span>Tab</span>
                  <select value={table.tab} onChange={(e) => void read(picked, { tab: e.target.value })}>
                    {table.tabs.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                <form
                  className="field"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void read(picked, { tab: table.tab, range });
                  }}
                >
                  <span>Range</span>
                  <input value={range} onChange={(e) => setRange(e.target.value)} onBlur={() => range !== table.range && void read(picked, { tab: table.tab, range })} placeholder="A1:D10" maxLength={40} aria-label="Range" />
                </form>
              </div>
              <div className="sheet-table-preview" aria-label="Preview">
                <table>
                  <tbody>
                    {table.rows.slice(0, PREVIEW_ROWS).map((row, r) => (
                      <tr key={r}>
                        {row.slice(0, PREVIEW_COLS).map((c, k) => (
                          <td key={k} style={{ fontWeight: c.bold ? 700 : undefined, fontStyle: c.italic ? 'italic' : undefined, color: c.color, background: c.fill, textAlign: c.align }}>
                            {c.text}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="muted">
                  {table.rows.length} rows × {table.rows[0]?.length ?? 0} columns
                  {table.rows.length > PREVIEW_ROWS || (table.rows[0]?.length ?? 0) > PREVIEW_COLS ? ' (the first ones shown)' : ''}
                </div>
              </div>
              <label className="sheet-table-link">
                <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} />
                Keep it linked: the table changes when the spreadsheet does
                {following ? ', and grows with the data' : ''}
              </label>
            </>
          ) : (
            <div className="muted sheet-table-hint">{loading ? 'Reading…' : picked ? '' : 'Choose a spreadsheet.'}</div>
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
          disabled={!picked || !table || loading || range !== table.range}
          onClick={() => {
            if (!picked || !table) return;
            onInsert(picked, table, linked, following);
            onClose();
          }}
        >
          Insert
        </button>
      </div>
    </Modal>
  );
}
