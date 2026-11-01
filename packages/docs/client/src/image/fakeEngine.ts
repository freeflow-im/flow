// A stand-in for the image editor's engine in tests (the real one needs a browser canvas): it keeps the size the
// picture would have and a log of what was asked of it.
import type { OpsEngine } from './imageOps.ts';

export function fakeEngine(width: number, height: number, opts: { backgroundRemoval?: boolean } = {}) {
  const log: string[] = [];
  let size = { width, height };
  let full = { width, height };
  let cropped = false;
  let layers = 1;
  const looks = new Set<string>();
  const inside = (r: { x: number; y: number; width: number; height: number }) => r.x < size.width && r.y < size.height && r.x + r.width > 0 && r.y + r.height > 0 && r.width > 0 && r.height > 0;
  const engine: OpsEngine = {
    backgroundRemovalAvailable: opts.backgroundRemoval ?? false,
    getOutputSize: () => ({ ...size }),
    cropTo: (r) => {
      if (!inside(r)) return false;
      size = { width: Math.min(r.width, size.width - r.x), height: Math.min(r.height, size.height - r.y) };
      cropped = true;
      log.push(`crop ${r.x},${r.y} ${r.width}x${r.height}`);
      return true;
    },
    rotateBy: (deg) => {
      if (Math.abs(deg) % 180 === 90) size = { width: size.height, height: size.width };
      log.push(`rotate ${deg}`);
    },
    setStraighten: (deg) => void log.push(`straighten ${deg}`),
    flip: (axis) => void log.push(`flip ${axis}`),
    setOutputWidth: (w) => {
      if (w !== null) size = { width: w, height: Math.round((size.height * w) / size.width) };
      log.push(`width ${w}`);
      return { ...size };
    },
    setAdjustments: (values) => void log.push(`adjust ${JSON.stringify(values)}`),
    toggleLook: (look) => {
      if (looks.has(look)) looks.delete(look);
      else looks.add(look);
      log.push(`look ${look} ${looks.has(look) ? 'on' : 'off'}`);
    },
    isLookActive: (look) => looks.has(look),
    addTextBox: (text, style, at) => {
      layers++;
      log.push(`text "${text}" at ${at.x},${at.y} size ${style.fontSize} ${style.color}`);
      return `o${layers}`;
    },
    addShapeAt: (kind, style, g) => {
      if (g.box && !inside(g.box)) return null;
      if (g.from && g.to && g.from.x === g.to.x && g.from.y === g.to.y) return null;
      layers++;
      log.push(g.box ? `${kind} in ${g.box.x},${g.box.y} ${g.box.width}x${g.box.height} ${style.color}` : `${kind} from ${g.from!.x},${g.from!.y} to ${g.to!.x},${g.to!.y} ${style.color}`);
      return `o${layers}`;
    },
    addImageAt: async (_src, at, o) => {
      layers++;
      log.push(`image at ${at.x},${at.y} ${at.width}x${at.height}${o?.opacity !== undefined && o.opacity < 1 ? ` opacity ${o.opacity}` : ''}`);
      return `o${layers}`;
    },
    redactRect: async (r, mode) => {
      if (!inside(r)) return false;
      layers++;
      log.push(`redact ${r.x},${r.y} ${r.width}x${r.height} ${mode}`);
      return true;
    },
    removeImageBackground: async () => (log.push('remove background'), true),
    hasCropRegion: () => cropped,
    getLayers: () => Array.from({ length: layers }, (_, n) => ({ id: `o${n}`, label: '', locked: false, visible: true, selected: false, opacity: 1, removable: n > 0 })),
  };
  /** What a hidden engine's bake does: the picture becomes plain, at the size it has now. */
  const bake = async () => {
    full = { ...size };
    cropped = false;
    layers = 1;
    log.push(`bake ${full.width}x${full.height}`);
  };
  return { engine, log, bake };
}
