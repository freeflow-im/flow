// What jsdom lacks and the components use to measure themselves, for every test (vitest.config.ts): a body's frame and
// the inbox tabs size themselves with a ResizeObserver, and the editor (ProseMirror) measures a text Range to scroll the
// selection into view when it takes the focus. Without the Range methods that scroll throws after the test that caused it
// ("target.getClientRects is not a function"), which vitest counts as an error even when every test passed.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
