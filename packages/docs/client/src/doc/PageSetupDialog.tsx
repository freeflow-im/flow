// Page setup: pages or pageless, paper size, orientation, margins, page numbers, header and footer.
import { useState } from 'react';
import { MAX_HEADER_CHARS, MAX_MARGIN, MIN_MARGIN, PAGE_NUMBER_POSITIONS, PAGE_SIZE_IDS, PAGE_SIZES, type PageNumberPosition, type PageSetup, type PageSizeId } from '../../../shared/doc.ts';
import { Modal } from '../components/Modal.tsx';
import type { DocController } from './controller.ts';

const NUMBER_LABELS: Record<PageNumberPosition, string> = { none: 'None', 'bottom-center': 'Bottom center', 'bottom-right': 'Bottom right', 'top-right': 'Top right' };
const SIDES = ['top', 'bottom', 'left', 'right'] as const;

export function PageSetupDialog({ ctl, onClose }: { ctl: DocController; onClose: () => void }) {
  const [setup, setSetup] = useState<PageSetup>(() => ctl.pageSetup());
  const [margins, setMargins] = useState<Record<(typeof SIDES)[number], string>>(() => {
    const m = ctl.pageSetup().margins;
    return { top: String(m.top), bottom: String(m.bottom), left: String(m.left), right: String(m.right) };
  });
  const [error, setError] = useState<string | null>(null);
  const paged = setup.mode === 'pages';

  const apply = () => {
    const parsed = { ...setup.margins };
    for (const side of SIDES) {
      const v = Number(margins[side]);
      if (!Number.isFinite(v) || v < MIN_MARGIN || v > MAX_MARGIN) return setError(`Margins must be between ${MIN_MARGIN} and ${MAX_MARGIN} inches.`);
      parsed[side] = Math.round(v * 100) / 100;
    }
    ctl.setPageSetup({ ...setup, margins: parsed });
    onClose();
    ctl.focus();
  };

  return (
    <Modal title="Page setup" onClose={onClose}>
      <div className="page-setup">
        <div className="page-setup-row">
          <label>
            <input type="radio" name="mode" checked={paged} onChange={() => setSetup({ ...setup, mode: 'pages' })} /> Pages
          </label>
          <label>
            <input type="radio" name="mode" checked={!paged} onChange={() => setSetup({ ...setup, mode: 'pageless' })} /> Pageless
          </label>
        </div>
        <label className="page-setup-field">
          <span>Paper size</span>
          <select value={setup.size} disabled={!paged} onChange={(e) => setSetup({ ...setup, size: e.target.value as PageSizeId })}>
            {PAGE_SIZE_IDS.map((id) => (
              <option key={id} value={id}>
                {PAGE_SIZES[id].name}
              </option>
            ))}
          </select>
        </label>
        <label className="page-setup-field">
          <span>Orientation</span>
          <select value={setup.orientation} disabled={!paged} onChange={(e) => setSetup({ ...setup, orientation: e.target.value as PageSetup['orientation'] })}>
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </label>
        <div className="page-setup-field">
          <span>Margins (inches)</span>
          <div className="page-setup-margins">
            {SIDES.map((side) => (
              <label key={side}>
                <span>{side[0].toUpperCase() + side.slice(1)}</span>
                <input type="number" step="0.25" min={MIN_MARGIN} max={MAX_MARGIN} disabled={!paged} value={margins[side]} onChange={(e) => setMargins({ ...margins, [side]: e.target.value })} />
              </label>
            ))}
          </div>
        </div>
        <label className="page-setup-field">
          <span>Page numbers</span>
          <select value={setup.pageNumbers} disabled={!paged} onChange={(e) => setSetup({ ...setup, pageNumbers: e.target.value as PageNumberPosition })}>
            {PAGE_NUMBER_POSITIONS.map((p) => (
              <option key={p} value={p}>
                {NUMBER_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="page-setup-field">
          <span>Header</span>
          <input type="text" maxLength={MAX_HEADER_CHARS} disabled={!paged} placeholder="Text for the top of every page" value={setup.header} onChange={(e) => setSetup({ ...setup, header: e.target.value })} />
        </label>
        <label className="page-setup-field">
          <span>Footer</span>
          <input type="text" maxLength={MAX_HEADER_CHARS} disabled={!paged} placeholder="{page} of {pages}" value={setup.footer} onChange={(e) => setSetup({ ...setup, footer: e.target.value })} />
        </label>
        <div className="muted page-setup-hint">In the header and footer, {'{page}'} and {'{pages}'} become the page number and the page count.</div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </Modal>
  );
}
