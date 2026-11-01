import { describe, expect, it } from 'vitest';
import { editableHtml, MAX_SELECTED_HTML, shortenHtml } from './htmlEdit.ts';

describe('editableHtml', () => {
  it('puts the editing script after the doctype, so the page stays in standards mode', () => {
    const out = editableHtml('<!-- made by a tool -->\n<!DOCTYPE html>\n<html><body><p>Hi</p></body></html>', 'n1');
    expect(out.startsWith('<!-- made by a tool -->\n<!DOCTYPE html><meta data-ff-edit')).toBe(true);
    expect(out.endsWith('\n<html><body><p>Hi</p></body></html>')).toBe(true);
  });

  it('goes first in a page without a doctype', () => {
    expect(editableHtml('<p>Hi</p>', 'n1')).toMatch(/^<meta data-ff-edit[\s\S]*<\/script><p>Hi<\/p>$/);
  });

  it("only lets the editing script run, not the page's own", () => {
    const out = editableHtml('<!doctype html><script>alert(1)</script>', 'abc');
    expect(out).toContain(`content="script-src 'nonce-abc'"`);
    expect(out).toContain('<script data-ff-edit nonce="abc">(function frameScript()');
    // The policy comes before every script in the page.
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<script'));
    expect(out).toContain('<script>alert(1)</script>');
  });

  it('marks everything it adds, so none of it is saved with the page', () => {
    const added = editableHtml('', 'n1');
    expect(added.match(/<(meta|style|script) /g)).toHaveLength(3);
    expect(added.match(/<(meta|style|script) data-ff-edit/g)).toHaveLength(3);
  });
});

describe('shortenHtml', () => {
  it('cuts long element HTML for the assistant', () => {
    expect(shortenHtml('<b>x</b>')).toBe('<b>x</b>');
    expect(shortenHtml('x'.repeat(MAX_SELECTED_HTML + 5))).toBe(`${'x'.repeat(MAX_SELECTED_HTML)}…`);
  });
});
