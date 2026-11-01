// Document style: the default font, body size, line spacing and space after paragraphs.
import { useState } from 'react';
import { cleanFontFamily, FONT_FAMILIES, FONT_SIZES, fontFamilyCss, MAX_LINE_HEIGHT, MAX_PARAGRAPH_SPACE, MIN_LINE_HEIGHT, type DocStyle } from '../../../shared/doc.ts';
import { Modal } from '../components/Modal.tsx';
import type { DocController } from './controller.ts';

const LINE_OPTIONS = [1, 1.15, 1.3, 1.5, 1.65, 2];
const SORTED_FONTS = [...FONT_FAMILIES].sort((a, b) => a.localeCompare(b));

export function DocStyleDialog({ ctl, onClose }: { ctl: DocController; onClose: () => void }) {
  const [style, setStyle] = useState<DocStyle>(() => ctl.docStyle());
  const [space, setSpace] = useState(() => String(ctl.docStyle().spaceAfter));
  const [line, setLine] = useState(() => String(ctl.docStyle().lineHeight));
  const [error, setError] = useState<string | null>(null);
  const fonts = SORTED_FONTS.includes(style.font as (typeof SORTED_FONTS)[number]) ? SORTED_FONTS : [style.font, ...SORTED_FONTS];

  const apply = () => {
    const lineHeight = Number(line);
    const spaceAfter = Number(space);
    if (!Number.isFinite(lineHeight) || lineHeight < MIN_LINE_HEIGHT || lineHeight > MAX_LINE_HEIGHT) return setError(`Line spacing must be between ${MIN_LINE_HEIGHT} and ${MAX_LINE_HEIGHT}.`);
    if (!Number.isFinite(spaceAfter) || spaceAfter < 0 || spaceAfter > MAX_PARAGRAPH_SPACE) return setError(`Paragraph spacing must be between 0 and ${MAX_PARAGRAPH_SPACE} points.`);
    if (!cleanFontFamily(style.font)) return setError('Choose a font.');
    ctl.setDocStyle({ ...style, lineHeight: Math.round(lineHeight * 100) / 100, spaceAfter: Math.round(spaceAfter * 10) / 10 });
    onClose();
    ctl.focus();
  };

  return (
    <Modal title="Document style" onClose={onClose}>
      <div className="page-setup">
        <label className="page-setup-field">
          <span>Default font</span>
          <select value={style.font} style={{ fontFamily: fontFamilyCss(style.font) }} onChange={(e) => setStyle({ ...style, font: e.target.value })}>
            {fonts.map((f) => (
              <option key={f} value={f} style={{ fontFamily: fontFamilyCss(f) }}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="page-setup-field">
          <span>Body size</span>
          <select value={style.size} onChange={(e) => setStyle({ ...style, size: Number(e.target.value) })}>
            {!(FONT_SIZES as readonly number[]).includes(style.size) && <option value={style.size}>{style.size} pt</option>}
            {FONT_SIZES.map((s) => (
              <option key={s} value={s}>
                {s} pt
              </option>
            ))}
          </select>
        </label>
        <label className="page-setup-field">
          <span>Line spacing</span>
          <select value={LINE_OPTIONS.includes(Number(line)) ? line : 'custom'} onChange={(e) => e.target.value !== 'custom' && setLine(e.target.value)}>
            {!LINE_OPTIONS.includes(Number(line)) && <option value="custom">{line}</option>}
            {LINE_OPTIONS.map((l) => (
              <option key={l} value={String(l)}>
                {l === 1 ? 'Single (1.0)' : l === 2 ? 'Double (2.0)' : l}
              </option>
            ))}
          </select>
        </label>
        <label className="page-setup-field">
          <span>Space after paragraphs</span>
          <input type="number" step="0.5" min={0} max={MAX_PARAGRAPH_SPACE} value={space} onChange={(e) => setSpace(e.target.value)} style={{ width: 90 }} /> <span className="muted">pt</span>
        </label>
        <div className="muted page-setup-hint">Text without its own font or size uses these; headings scale with the body size.</div>
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
