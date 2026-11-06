# Mail tests: the editor's scroll into view no longer errors under jsdom

- `[qa]` The Mail tests share one setup (`packages/mail/src/test-setup.ts`): the ResizeObserver stand-in that four test files each declared, and `Range.getClientRects`/`getBoundingClientRect`, which jsdom lacks and ProseMirror calls when the editor takes the focus. On a slow run that call threw after the test that caused it, and vitest failed the package with every test passing (CI on main after #713).
