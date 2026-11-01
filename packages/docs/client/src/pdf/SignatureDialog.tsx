// Making a signature to sign PDFs with: drawn with the mouse, pen or finger, typed in a handwriting font, or a
// picture of one (a scan or a photo, its white paper made see-through). The result is a PNG cut to the ink.
import { useEffect, useRef, useState } from 'react';
import SignaturePad from 'signature_pad';
import { Modal } from '../components/Modal.tsx';

type Mode = 'draw' | 'type' | 'upload';

/** Handwriting fonts the systems have: macOS first, then Windows, then whatever the browser calls cursive. */
const SCRIPT_FONTS = [
  { label: 'Flowing', css: "'Snell Roundhand', 'Segoe Script', 'Lucida Handwriting', cursive" },
  { label: 'Hand', css: "'Bradley Hand', 'Segoe Print', 'Comic Sans MS', cursive" },
  { label: 'Brush', css: "'Brush Script MT', 'Brush Script Std', 'Lucida Calligraphy', cursive" },
];

/** The canvas cut to what is drawn on it (with a little room around), as a PNG data: address; null when it is blank. */
export function trimToInk(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let top = height,
    left = width,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return null;
  const pad = 4;
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  const w = Math.min(width, right + pad + 1) - left;
  const h = Math.min(height, bottom + pad + 1) - top;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d')!.drawImage(canvas, left, top, w, h, 0, 0, w, h);
  return out.toDataURL('image/png');
}

/** A picture of a signature on a canvas, at most 1200 pixels wide, with paper-white made see-through. */
async function pictureCanvas(file: Blob, clearWhite: boolean): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1200 / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  if (clearWhite) {
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      const light = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // Paper fades out between light grey and white, so the ink's edges stay smooth.
      const keep = Math.max(0, Math.min(1, (235 - light) / 60));
      d[i + 3] = Math.round(d[i + 3] * keep);
    }
    ctx.putImageData(image, 0, 0);
  }
  return canvas;
}

/** A name written in a font, on a canvas big enough for it. */
function typedCanvas(name: string, font: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const size = 96;
  const ctx = canvas.getContext('2d')!;
  ctx.font = `${size}px ${font}`;
  const width = Math.ceil(ctx.measureText(name).width + size);
  canvas.width = width;
  canvas.height = Math.ceil(size * 1.8);
  ctx.font = `${size}px ${font}`;
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, size / 2, canvas.height / 2);
  return canvas;
}

export function SignatureDialog({ onUse, onClose }: { onUse(image: string, remember: boolean): void | Promise<void>; onClose(): void }) {
  const [mode, setMode] = useState<Mode>('draw');
  const [name, setName] = useState('');
  const [font, setFont] = useState(SCRIPT_FONTS[0].css);
  const [picture, setPicture] = useState<File | null>(null);
  const [clearWhite, setClearWhite] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const [drawn, setDrawn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pad = useRef<SignaturePad | null>(null);

  // The drawing pad, at the screen's resolution so the strokes are sharp.
  useEffect(() => {
    const el = canvas.current;
    if (mode !== 'draw' || !el) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 2);
    el.width = el.offsetWidth * ratio;
    el.height = el.offsetHeight * ratio;
    el.getContext('2d')!.scale(ratio, ratio);
    const p = new SignaturePad(el, { penColor: '#000', minWidth: 0.8, maxWidth: 2.6 });
    p.addEventListener('endStroke', () => setDrawn(!p.isEmpty()));
    pad.current = p;
    setDrawn(false);
    return () => {
      p.off();
      pad.current = null;
    };
  }, [mode]);

  // The picture as it will be used, so the effect of making white see-through can be seen.
  useEffect(() => {
    if (mode !== 'upload' || !picture) return setPreview(null);
    let stale = false;
    pictureCanvas(picture, clearWhite).then(
      (c) => !stale && setPreview(trimToInk(c)),
      () => !stale && setError('This file is not a picture that can be read.'),
    );
    return () => {
      stale = true;
    };
  }, [mode, picture, clearWhite]);

  const ready = mode === 'draw' ? drawn : mode === 'type' ? !!name.trim() : !!preview;

  const use = async () => {
    setError(null);
    let image: string | null = null;
    if (mode === 'draw' && canvas.current) image = trimToInk(canvas.current);
    else if (mode === 'type') image = trimToInk(typedCanvas(name.trim(), font));
    else image = preview;
    if (!image) return setError('There is no signature to use yet.');
    setBusy(true);
    try {
      await onUse(image, remember);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Add a signature" onClose={onClose} className="signature-dialog">
      <div className="signature-tabs" role="tablist">
        {(['draw', 'type', 'upload'] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} className={`signature-tab${mode === m ? ' active' : ''}`} onClick={() => setMode(m)}>
            {m === 'draw' ? 'Draw' : m === 'type' ? 'Type' : 'Upload'}
          </button>
        ))}
      </div>
      {mode === 'draw' && (
        <div className="signature-pad-wrap">
          <canvas ref={canvas} className="signature-pad" />
          <div className="signature-pad-line" />
          <button className="link-button signature-clear" disabled={!drawn} onClick={() => (pad.current?.clear(), setDrawn(false))}>
            Clear
          </button>
        </div>
      )}
      {mode === 'type' && (
        <div className="signature-type">
          <label className="field">
            <input autoFocus placeholder="Your name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="signature-fonts">
            {SCRIPT_FONTS.map((f) => (
              <button key={f.label} className={`signature-font${font === f.css ? ' active' : ''}`} style={{ fontFamily: f.css }} onClick={() => setFont(f.css)} title={f.label}>
                {name.trim() || 'Your name'}
              </button>
            ))}
          </div>
        </div>
      )}
      {mode === 'upload' && (
        <div className="signature-upload">
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => (setError(null), setPicture(e.target.files?.[0] ?? null))} />
          <label>
            <input type="checkbox" checked={clearWhite} onChange={(e) => setClearWhite(e.target.checked)} /> Make the white paper see-through
          </label>
          <div className="signature-preview">{preview ? <img src={preview} alt="The signature" /> : <span className="muted">A photo or scan of your signature on white paper works best.</span>}</div>
        </div>
      )}
      <label className="signature-remember">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Save this signature to use again
      </label>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!ready || busy} onClick={() => void use()}>
          Use signature
        </button>
      </div>
    </Modal>
  );
}
