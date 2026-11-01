import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownController } from './controller.ts';

describe('MarkdownController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves typed text after a pause, as a Markdown document', async () => {
    const saved: string[] = [];
    const ctl = new MarkdownController({ version: 1, text: '' }, async (d) => void saved.push(d.text));
    ctl.setText('# Hi');
    ctl.setText('# Hi there');
    expect(ctl.saver.status).toBe('dirty');
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved).toEqual(['# Hi there']);
    expect(ctl.saver.status).toBe('saved');
    expect(ctl.document).toEqual({ version: 1, text: '# Hi there' });
    ctl.dispose();
  });

  it('counts lines and takes versions saved elsewhere', () => {
    const ctl = new MarkdownController({ version: 1, text: 'a\nb\nc' }, async () => {});
    expect(ctl.lineCount()).toBe(3);
    expect(ctl.replaceWith({ version: 1, text: 'a\nb\nc' })).toBe(false);
    expect(ctl.replaceWith({ version: 1, text: '' })).toBe(true);
    expect(ctl.externalChanges).toBe(1);
    expect(ctl.lineCount()).toBe(0);
    ctl.dispose();
  });
});
