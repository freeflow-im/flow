// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AppsHelpCallout } from './AppsHelp';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Understanding apps', () => {
  it('opens a popup that explains the builder, storage, tools, events and ctx, and closes on Escape', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<AppsHelpCallout />));
    expect(document.querySelector('[data-testid="apps-help-dialog"]')).toBeNull();
    act(() => (document.querySelector('[data-testid="apps-help"]') as HTMLButtonElement).click());
    const dialog = document.querySelector('[data-testid="apps-help-dialog"]')!;
    expect(dialog).not.toBeNull();
    for (const t of ['app builder', 'Storage and identity', 'Tools and events', 'ctx.publish', 'ctx.caller', 'ctx.db', 'ctx.files']) expect(dialog.textContent).toContain(t);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(document.querySelector('[data-testid="apps-help-dialog"]')).toBeNull();
    act(() => root.unmount());
  });
});
