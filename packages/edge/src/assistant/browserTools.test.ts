import { describe, expect, it } from 'vitest';
import { BROWSER_TOOLS } from '@flow/docs/shared/agent/protocol.ts';
import { suiteTools, validateSuiteTool } from '../docs/assistantTools.ts';

const names = (tools: { name: string }[]) => tools.map((t) => t.name);

describe('the web tools (prototype)', () => {
  it('are offered only when the page says the browser extension is there, on any app’s page, last', () => {
    for (const page of ['home', 'mail', 'calendar'] as const) {
      const without = names(suiteTools({ page } as never, true));
      expect(without.some((n) => BROWSER_TOOLS.has(n))).toBe(false);
      const withIt = names(suiteTools({ page, browser: true } as never, true));
      expect(withIt.slice(-BROWSER_TOOLS.size).sort()).toEqual([...BROWSER_TOOLS].sort());
      expect(withIt.slice(0, without.length)).toEqual(without);
    }
  });

  it('are refused without the extension, and their input is checked with it', () => {
    expect(validateSuiteTool('browser_open', { url: 'example.com' }, { page: 'home' })).toEqual({ ok: false, error: 'Unknown tool "browser_open".' });
    expect(validateSuiteTool('browser_open', { url: 'example.com' }, { page: 'home', browser: true })).toEqual({ ok: true, input: { url: 'example.com' } });
    expect(validateSuiteTool('browser_click', { tab: 'x', ref: '3' }, { page: 'home', browser: true })?.ok).toBe(false);
  });

  it('each has an object input schema with a description', () => {
    for (const t of suiteTools({ page: 'home', browser: true }, true).filter((t) => BROWSER_TOOLS.has(t.name))) {
      expect(t.input_schema.type).toBe('object');
      expect(t.description?.length ?? 0).toBeGreaterThan(20);
    }
  });
});
