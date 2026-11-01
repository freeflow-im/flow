import { describe, expect, it } from 'vitest';
import { fakeEngine } from './fakeEngine.ts';
import { applyImageOps, ImageOpError } from './imageOps.ts';

describe('image operations', () => {
  it('applies operations in order, in pixels of the picture at that point', async () => {
    const { engine, log, bake } = fakeEngine(3000, 2000);
    const done = await applyImageOps(
      engine,
      [
        { op: 'crop', x: 500, y: 250, width: 2000, height: 1500 },
        { op: 'adjust', brightness: 20, contrast: 500 },
        { op: 'filter', name: 'sepia' },
        { op: 'text', text: 'Hello', x: 100, y: 100, size: 120, color: '#ffffff' },
        { op: 'shape', kind: 'arrow', x1: 100, y1: 900, x2: 800, y2: 900 },
        { op: 'shape', kind: 'rect', x: 10, y: 10, width: 300, height: 200, color: '#00ff00' },
        { op: 'redact', x: 1500, y: 1000, width: 200, height: 100, mode: 'blur' },
        { op: 'resize', width: 1000 },
      ],
      bake,
    );
    expect(log).toEqual([
      'crop 500,250 2000x1500',
      'adjust {"brightness":20,"contrast":100}',
      'look sepia on',
      'text "Hello" at 100,100 size 120 #ffffff',
      'arrow from 100,900 to 800,900 #e53935',
      'rect in 10,10 300x200 #00ff00',
      'redact 1500,1000 200x100 blur',
      'width 1000',
    ]);
    expect(done[0]).toBe('Cropped to 2000 × 1500');
    expect(done.at(-1)).toBe('Resized to 1000 × 750');
    expect(engine.getOutputSize()).toEqual({ width: 1000, height: 750 });
  });

  it('flattens a cropped or drawn-on picture before turning it, when it can', async () => {
    const { engine, log, bake } = fakeEngine(3000, 2000);
    await applyImageOps(engine, [{ op: 'rotate', degrees: 90 }], bake);
    expect(log).toEqual(['rotate 90']);
    await applyImageOps(engine, [{ op: 'crop', x: 0, y: 0, width: 1000, height: 3000 }, { op: 'flip', axis: 'horizontal' }, { op: 'text', text: 'A', x: 0, y: 0 }, { op: 'straighten', degrees: -3 }], bake);
    expect(log.slice(1)).toEqual(['crop 0,0 1000x3000', 'bake 1000x3000', 'flip h', 'text "A" at 0,0 size 48 #000000', 'bake 1000x3000', 'straighten -3']);
  });

  it('refuses to turn a cropped picture in the open editor, whose layers must stay', async () => {
    const { engine, log } = fakeEngine(3000, 2000);
    await expect(applyImageOps(engine, [{ op: 'crop', x: 0, y: 0, width: 100, height: 100 }, { op: 'rotate', degrees: 90 }])).rejects.toThrow(/Operation 2 \(rotate\): The picture in the open editor is cropped.*The 1 before it were applied/);
    expect(log).toEqual(['crop 0,0 100x100']);
  });

  it('says what is wrong with an operation', async () => {
    const { engine, bake } = fakeEngine(800, 600);
    const fails = (op: Record<string, unknown> & { op: string }) => applyImageOps(engine, [op], bake).then(() => null, (e: unknown) => (e instanceof ImageOpError ? e.message : `not an ImageOpError: ${String(e)}`));
    expect(await fails({ op: 'crop', x: 900, y: 0, width: 100, height: 100 })).toMatch(/outside the picture, which is 800 × 600/);
    expect(await fails({ op: 'crop', x: 0, y: 0, width: 100 })).toMatch(/"height" must be a number/);
    expect(await fails({ op: 'rotate', degrees: 45 })).toMatch(/must be 90, 180 or 270/);
    expect(await fails({ op: 'straighten', degrees: 60 })).toMatch(/between -45 and 45/);
    expect(await fails({ op: 'flip' })).toMatch(/horizontal or vertical/);
    expect(await fails({ op: 'resize', width: 5000 })).toMatch(/not scaled up/);
    expect(await fails({ op: 'adjust' })).toMatch(/at least one of brightness/);
    expect(await fails({ op: 'filter', name: 'vintage' })).toMatch(/one of grayscale/);
    expect(await fails({ op: 'text', x: 0, y: 0 })).toMatch(/"text" is empty/);
    expect(await fails({ op: 'shape', kind: 'blob', x: 0, y: 0, width: 5, height: 5 })).toMatch(/"kind" must be one of/);
    expect(await fails({ op: 'shape', kind: 'line', x1: 5, y1: 5, x2: 5, y2: 5 })).toMatch(/same/);
    expect(await fails({ op: 'remove_background' })).toMatch(/not available/);
    expect(await fails({ op: 'sparkle' })).toMatch(/Unknown operation/);
  });

  it('puts a picture on top: at its own size inside the picture, or as big as asked', async () => {
    const { engine, log } = fakeEngine(800, 600);
    const loaded: string[] = [];
    const load = async (source: string) => (loaded.push(source), { image: new Blob(['logo']), width: 200, height: 100 });
    const done = await applyImageOps(
      engine,
      [
        { op: 'overlay', source: '/api/images/a', x: 10, y: 20 },
        { op: 'overlay', source: '/api/images/a', x: 700, y: 0 },
        { op: 'overlay', source: 'file1', x: 0, y: 0, height: 50, opacity: 50 },
        { op: 'overlay', source: 'file1', x: 0, y: 0, width: 300, height: 30 },
      ],
      undefined,
      load,
    );
    expect(log).toEqual(['image at 10,20 200x100', 'image at 700,0 100x50', 'image at 0,0 100x50 opacity 0.5', 'image at 0,0 300x30']);
    expect(done[2]).toBe('Put a picture on top at 0, 0, 100 × 50, 50% opaque');
    expect(loaded).toEqual(['/api/images/a', '/api/images/a', 'file1', 'file1']);
    await expect(applyImageOps(engine, [{ op: 'overlay', source: 'x', x: 0, y: 0 }])).rejects.toThrow(/cannot be put on top here/);
    await expect(applyImageOps(engine, [{ op: 'overlay', source: 'x', x: -500, y: 0 }], undefined, load)).rejects.toThrow(/outside the picture/);
  });

  it('turns filters on once and off with none, and removes a background when it can', async () => {
    const { engine, log } = fakeEngine(800, 600, { backgroundRemoval: true });
    await applyImageOps(engine, [{ op: 'filter', name: 'grayscale' }, { op: 'filter', name: 'grayscale' }, { op: 'filter', name: 'none' }, { op: 'remove_background' }]);
    expect(log).toEqual(['look grayscale on', 'look grayscale off', 'remove background']);
  });
});
