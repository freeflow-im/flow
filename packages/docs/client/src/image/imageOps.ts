// The operations the assistant edits a picture with (transform_image), applied to the image editor's engine.
// Every position and size is in pixels of the picture as it is at that point: an operation after a crop counts
// from the cropped picture's corner. The engine is the same one the user edits with, either the open editor's
// or a hidden one (hiddenEngine.ts), so the assistant's result is what the user's own would be.
import type { EditorEngine } from '@ascentsparksoftware/react-image-editor';

const SHAPES = ['rect', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon', 'star', 'line', 'arrow'] as const;
const FILTERS = ['grayscale', 'sepia', 'invert', 'sharpen'] as const;
/** The sliders of the editor's Adjust panel, with the range of each. */
const ADJUSTMENTS = { brightness: [-100, 100], contrast: [-100, 100], saturation: [-100, 100], vibrance: [-100, 100], hue: [-180, 180], blur: [0, 100] } as const;

/** One operation, as the tool's schema describes it (server/agent/tools.ts); fields are checked as they are used. */
export type ImageOp = { op: string } & Record<string, unknown>;

/** What of the engine the operations use; tests pass a stand-in (the real one needs a browser canvas). */
export type OpsEngine = Pick<
  EditorEngine,
  'getOutputSize' | 'cropTo' | 'rotateBy' | 'setStraighten' | 'flip' | 'setOutputWidth' | 'setAdjustments' | 'toggleLook' | 'isLookActive' | 'addTextBox' | 'addShapeAt' | 'addImageAt' | 'redactRect' | 'removeImageBackground' | 'hasCropRegion' | 'getLayers'
> & { readonly backgroundRemovalAvailable: boolean };

/** A picture to put over the picture (overlay), read by whoever runs the operations, with its size in pixels. */
export interface OverlayPicture {
  image: Blob;
  width: number;
  height: number;
}

/** Reads an overlay's `source` (a stored picture's address or file id); throws ImageOpError when it cannot. */
export type OverlayLoader = (source: string) => Promise<OverlayPicture>;

/** A problem with an operation that the assistant can fix (a rectangle outside the picture, an unknown shape). */
export class ImageOpError extends Error {}

const num = (op: ImageOp, key: string): number => {
  const v = op[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ImageOpError(`"${key}" must be a number.`);
  return v;
};
const optNum = (op: ImageOp, key: string): number | undefined => (op[key] === undefined || op[key] === null ? undefined : num(op, key));
const optStr = (op: ImageOp, key: string): string | undefined => (typeof op[key] === 'string' && op[key] ? (op[key] as string) : undefined);
const rectOf = (op: ImageOp) => ({ x: num(op, 'x'), y: num(op, 'y'), width: num(op, 'width'), height: num(op, 'height') });
const sizeText = (engine: OpsEngine): string => {
  const s = engine.getOutputSize();
  return s ? `${s.width} × ${s.height}` : 'unknown size';
};
const outside = (engine: OpsEngine) => new ImageOpError(`That rectangle is outside the picture, which is ${sizeText(engine)} pixels at this point.`);

/**
 * Apply the operations in order; returns a line about each. `bake` (a hidden engine's) flattens what has been
 * done into a plain picture, which turning or flipping needs once the picture is cropped or drawn on: the
 * engine turns the photo alone, under its crop and its layers. Without it (the editor the user has open, whose
 * layers must stay editable) such a turn is refused. A problem stops at that operation; the ones before stand.
 */
export async function applyImageOps(engine: OpsEngine, ops: ImageOp[], bake?: () => Promise<void>, load?: OverlayLoader): Promise<string[]> {
  const done: string[] = [];
  for (const [n, op] of ops.entries()) {
    try {
      done.push(await applyOne(engine, op, bake, load));
    } catch (e) {
      if (e instanceof ImageOpError) throw new ImageOpError(`Operation ${n + 1} (${String(op.op)}): ${e.message}${done.length ? ` The ${done.length} before it were applied.` : ''}`);
      throw e;
    }
  }
  return done;
}

/** Turning and flipping act on the photo alone, so the picture must be plain first. */
async function plain(engine: OpsEngine, bake: (() => Promise<void>) | undefined, what: string): Promise<void> {
  if (!engine.hasCropRegion() && engine.getLayers().length <= 1) return;
  if (!bake) throw new ImageOpError(`The picture in the open editor is cropped or has layers on it, and ${what} would move the photo under them. Do it first, or ask the user to save and close the editor.`);
  await bake();
}

async function applyOne(engine: OpsEngine, op: ImageOp, bake?: () => Promise<void>, load?: OverlayLoader): Promise<string> {
  switch (op.op) {
    case 'crop': {
      if (!engine.cropTo(rectOf(op))) throw outside(engine);
      return `Cropped to ${sizeText(engine)}`;
    }
    case 'rotate': {
      const degrees = num(op, 'degrees');
      if (![90, 180, 270, -90, -180, -270].includes(degrees)) throw new ImageOpError('"degrees" must be 90, 180 or 270 (or negative, for counterclockwise). Use straighten for a small angle.');
      await plain(engine, bake, 'turning it');
      engine.rotateBy(degrees);
      return `Rotated ${degrees}° (now ${sizeText(engine)})`;
    }
    case 'straighten': {
      const degrees = num(op, 'degrees');
      if (Math.abs(degrees) > 45) throw new ImageOpError('"degrees" must be between -45 and 45.');
      await plain(engine, bake, 'straightening it');
      engine.setStraighten(degrees, true);
      return `Straightened by ${degrees}°`;
    }
    case 'flip': {
      if (op.axis !== 'horizontal' && op.axis !== 'vertical') throw new ImageOpError('"axis" must be horizontal or vertical.');
      await plain(engine, bake, 'flipping it');
      engine.flip(op.axis === 'horizontal' ? 'h' : 'v');
      return `Flipped ${op.axis}ly`;
    }
    case 'resize': {
      const width = num(op, 'width');
      const before = engine.getOutputSize();
      if (width < 1) throw new ImageOpError('"width" must be at least 1.');
      if (before && width > before.width) throw new ImageOpError(`The picture is ${before.width} pixels wide and is not scaled up.`);
      engine.setOutputWidth(width);
      return `Resized to ${sizeText(engine)}`;
    }
    case 'adjust': {
      const values: Partial<Record<keyof typeof ADJUSTMENTS, number>> = {};
      for (const key of Object.keys(ADJUSTMENTS) as (keyof typeof ADJUSTMENTS)[]) {
        const v = optNum(op, key);
        if (v !== undefined) values[key] = Math.max(ADJUSTMENTS[key][0], Math.min(ADJUSTMENTS[key][1], v));
      }
      if (!Object.keys(values).length) throw new ImageOpError(`Give at least one of ${Object.keys(ADJUSTMENTS).join(', ')}.`);
      engine.setAdjustments(values, true);
      return `Adjusted ${Object.entries(values).map(([k, v]) => `${k} ${v}`).join(', ')}`;
    }
    case 'filter': {
      const name = op.name;
      if (name === 'none') {
        for (const f of FILTERS) if (engine.isLookActive(f)) engine.toggleLook(f);
        return 'Removed filters';
      }
      if (!FILTERS.includes(name as (typeof FILTERS)[number])) throw new ImageOpError(`"name" must be one of ${FILTERS.join(', ')}, or none.`);
      if (!engine.isLookActive(name as (typeof FILTERS)[number])) engine.toggleLook(name as (typeof FILTERS)[number]);
      return `Applied the ${String(name)} filter`;
    }
    case 'text': {
      const text = optStr(op, 'text');
      if (!text) throw new ImageOpError('"text" is empty.');
      const align = op.align === 'center' || op.align === 'right' ? op.align : 'left';
      const id = engine.addTextBox(
        text,
        { color: optStr(op, 'color') ?? '#000000', fontSize: optNum(op, 'size') ?? 48, fontFamily: optStr(op, 'font'), bold: op.bold === true, italic: op.italic === true, align, background: optStr(op, 'background') },
        { x: num(op, 'x'), y: num(op, 'y'), width: optNum(op, 'width') },
      );
      if (!id) throw new ImageOpError('The text could not be added.');
      return `Added text “${text.length > 40 ? `${text.slice(0, 40)}…` : text}”`;
    }
    case 'shape': {
      const kind = op.kind as (typeof SHAPES)[number];
      if (!SHAPES.includes(kind)) throw new ImageOpError(`"kind" must be one of ${SHAPES.join(', ')}.`);
      const style = { color: optStr(op, 'color') ?? '#e53935', strokeWidth: optNum(op, 'stroke_width') ?? 6, fill: optStr(op, 'fill'), cornerRadius: optNum(op, 'corner_radius') };
      const line = kind === 'line' || kind === 'arrow';
      const id = engine.addShapeAt(kind, style, line ? { from: { x: num(op, 'x1'), y: num(op, 'y1') }, to: { x: num(op, 'x2'), y: num(op, 'y2') } } : { box: rectOf(op) });
      if (!id) throw line ? new ImageOpError('The two points are the same.') : outside(engine);
      return `Added ${kind === 'ellipse' || kind === 'arrow' ? 'an' : 'a'} ${kind}`;
    }
    case 'overlay': {
      const source = optStr(op, 'source');
      if (!source) throw new ImageOpError('"source" is missing: the address of the picture to put on top (an attached picture’s /api/images/... address) or a stored picture’s file_id.');
      if (!load) throw new ImageOpError('Pictures cannot be put on top here.');
      const x = num(op, 'x');
      const y = num(op, 'y');
      const picture = await load(source);
      const size = engine.getOutputSize();
      let width = optNum(op, 'width');
      let height = optNum(op, 'height');
      // With no size given it keeps its own, made smaller if it would run past the picture's edges.
      if (width === undefined && height === undefined && size) {
        const fit = Math.min(1, (size.width - x) / picture.width, (size.height - y) / picture.height);
        if (fit > 0) width = Math.max(1, Math.round(picture.width * fit));
      }
      if (width !== undefined && height === undefined) height = Math.round((width * picture.height) / picture.width);
      if (height !== undefined && width === undefined) width = Math.round((height * picture.width) / picture.height);
      if (size && (x >= size.width || y >= size.height || x + (width ?? picture.width) <= 0 || y + (height ?? picture.height) <= 0)) throw outside(engine);
      const opacity = optNum(op, 'opacity');
      const id = await engine.addImageAt(picture.image, { x, y, width, height }, { opacity: opacity === undefined ? 1 : Math.max(0, Math.min(100, opacity)) / 100 });
      if (!id) throw new ImageOpError('The picture could not be put on top: its size is under one pixel.');
      return `Put a picture on top at ${x}, ${y}, ${width ?? picture.width} × ${height ?? picture.height}${opacity !== undefined && opacity < 100 ? `, ${Math.max(0, opacity)}% opaque` : ''}`;
    }
    case 'redact': {
      const mode = op.mode === 'blur' || op.mode === 'pixelate' ? op.mode : 'solid';
      if (!(await engine.redactRect(rectOf(op), mode))) throw outside(engine);
      return `Redacted a region (${mode})`;
    }
    case 'remove_background': {
      if (!engine.backgroundRemovalAvailable) throw new ImageOpError('Background removal is not available here.');
      if (!(await engine.removeImageBackground('replace'))) throw new ImageOpError('The background could not be removed.');
      return 'Removed the background';
    }
    default:
      throw new ImageOpError(`Unknown operation. Use crop, rotate, straighten, flip, resize, adjust, filter, text, shape, overlay, redact or remove_background.`);
  }
}
