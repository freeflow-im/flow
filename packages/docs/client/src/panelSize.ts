// Widths of the resizable side panels (slide thumbnail tray, assistant panel): limits, clamping and the
// per-user value remembered in localStorage.

export interface PanelSpec {
  /** localStorage key the width is remembered under. */
  key: string;
  def: number;
  min: number;
  max: number;
}

/** The middle area (slide canvas, sheet grid) never gets narrower than this. */
export const MIN_CENTER_WIDTH = 400;
/** Arrow keys on a resize handle change the width by this much. */
export const KEY_STEP = 16;

export const SLIDE_TRAY: PanelSpec = { key: 'ui.slideTrayWidth', def: 200, min: 120, max: 400 };
export const DOC_TRAY: PanelSpec = { key: 'ui.docTrayWidth', def: 180, min: 100, max: 360 };
/** The rendered preview beside a Markdown editor. */
export const MARKDOWN_PREVIEW: PanelSpec = { key: 'ui.markdownPreviewWidth', def: 520, min: 240, max: 1400 };
export const ASSISTANT_PANEL: PanelSpec = { key: 'ui.assistantPanelWidth', def: 380, min: 280, max: 800 };

/**
 * Keep a width within the panel's limits. `available` is the room shared by the panel and the center area
 * (so the center keeps at least MIN_CENTER_WIDTH); `maxFraction` caps the panel at a share of the viewport.
 * The panel's minimum always wins over the other limits.
 */
export function clampWidth(w: number, spec: PanelSpec, opts: { available?: number; viewport?: number; maxFraction?: number } = {}): number {
  let max = spec.max;
  if (opts.available !== undefined) max = Math.min(max, opts.available - MIN_CENTER_WIDTH);
  if (opts.viewport !== undefined && opts.maxFraction !== undefined) max = Math.min(max, opts.viewport * opts.maxFraction);
  max = Math.max(spec.min, max);
  if (!Number.isFinite(w)) return spec.def;
  return Math.round(Math.min(max, Math.max(spec.min, w)));
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

const defaultStorage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** The remembered width, or the default when none is stored or the stored value is unusable. */
export function loadWidth(spec: PanelSpec, storage: Storage | undefined = defaultStorage()): number {
  try {
    const raw = storage?.getItem(spec.key);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && raw !== '' ? clampWidth(n, spec) : spec.def;
  } catch {
    return spec.def;
  }
}

/** Remember a width; the default is stored as "nothing" so a reset follows future default changes. */
export function saveWidth(spec: PanelSpec, w: number, storage: Storage | undefined = defaultStorage()): void {
  try {
    if (w === spec.def) storage?.removeItem(spec.key);
    else storage?.setItem(spec.key, String(Math.round(w)));
  } catch {
    // Storage full or blocked: the width just isn't remembered.
  }
}
