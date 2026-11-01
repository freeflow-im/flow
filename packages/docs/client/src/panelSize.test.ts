import { describe, expect, it } from 'vitest';
import { ASSISTANT_PANEL, clampWidth, loadWidth, MIN_CENTER_WIDTH, saveWidth, SLIDE_TRAY } from './panelSize.ts';

function memoryStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('clampWidth', () => {
  it('keeps the thumbnail tray between its limits', () => {
    expect(clampWidth(50, SLIDE_TRAY)).toBe(120);
    expect(clampWidth(250.4, SLIDE_TRAY)).toBe(250);
    expect(clampWidth(900, SLIDE_TRAY)).toBe(400);
    expect(clampWidth(NaN, SLIDE_TRAY)).toBe(SLIDE_TRAY.def);
  });

  it('caps the assistant panel at half the viewport and 800px', () => {
    expect(clampWidth(700, ASSISTANT_PANEL, { viewport: 1000, maxFraction: 0.5 })).toBe(500);
    expect(clampWidth(1200, ASSISTANT_PANEL, { viewport: 3000, maxFraction: 0.5 })).toBe(800);
    expect(clampWidth(100, ASSISTANT_PANEL, { viewport: 3000, maxFraction: 0.5 })).toBe(280);
  });

  it('leaves the center area at least its minimum width', () => {
    expect(clampWidth(400, SLIDE_TRAY, { available: 700 })).toBe(700 - MIN_CENTER_WIDTH);
    // When there is no room at all the panel still keeps its own minimum.
    expect(clampWidth(400, SLIDE_TRAY, { available: 300 })).toBe(SLIDE_TRAY.min);
  });
});

describe('loadWidth / saveWidth', () => {
  it('falls back to the default when nothing usable is stored', () => {
    expect(loadWidth(SLIDE_TRAY, memoryStorage())).toBe(200);
    expect(loadWidth(SLIDE_TRAY, memoryStorage({ 'ui.slideTrayWidth': 'wide' }))).toBe(200);
    expect(loadWidth(SLIDE_TRAY, memoryStorage({ 'ui.slideTrayWidth': '' }))).toBe(200);
    expect(loadWidth(ASSISTANT_PANEL, undefined)).toBe(380);
  });

  it('round-trips a width per panel and clamps stored values', () => {
    const s = memoryStorage();
    saveWidth(SLIDE_TRAY, 150, s);
    saveWidth(ASSISTANT_PANEL, 520, s);
    expect(s.data.get('ui.slideTrayWidth')).toBe('150');
    expect(s.data.get('ui.assistantPanelWidth')).toBe('520');
    expect(loadWidth(SLIDE_TRAY, s)).toBe(150);
    expect(loadWidth(ASSISTANT_PANEL, s)).toBe(520);
    expect(loadWidth(SLIDE_TRAY, memoryStorage({ 'ui.slideTrayWidth': '5000' }))).toBe(400);
  });

  it('forgets the width when reset to the default', () => {
    const s = memoryStorage({ 'ui.slideTrayWidth': '150' });
    saveWidth(SLIDE_TRAY, SLIDE_TRAY.def, s);
    expect(s.data.has('ui.slideTrayWidth')).toBe(false);
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {},
    };
    expect(loadWidth(SLIDE_TRAY, broken)).toBe(200);
    expect(() => saveWidth(SLIDE_TRAY, 150, broken)).not.toThrow();
  });
});
