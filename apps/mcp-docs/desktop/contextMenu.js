// The right-click menu a browser gives a page, which Electron leaves to the app: for a picture, a link, selected
// text and text being typed (with the spelling checker's suggestions). The app's own menus (the grid's, a
// slide's) take the click first and stop this one. `contextMenuTemplate` decides what is in it; main.js makes
// it a Menu and shows it.

/**
 * The menu's items for a right-click described by Electron's `context-menu` params, as a Menu template. Empty
 * when there is nothing to offer. `act` does what the items that are not roles do.
 * @param {Electron.ContextMenuParams} params
 * @param {{ copyImage(): void, copyText(text: string): void, saveImage(url: string): void, openLink(url: string): void,
 *   replaceMisspelling(word: string): void, learnSpelling(word: string): void, inspect?: () => void }} act
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
export function contextMenuTemplate(params, act) {
  /** @type {Electron.MenuItemConstructorOptions[][]} */
  const groups = [];
  const flags = params.editFlags ?? {};

  if (params.isEditable && params.misspelledWord) {
    const suggestions = (params.dictionarySuggestions ?? []).slice(0, 5);
    groups.push([
      ...(suggestions.length ? suggestions.map((word) => ({ label: word, click: () => act.replaceMisspelling(word) })) : [{ label: 'No Guesses Found', enabled: false }]),
      { label: 'Learn Spelling', click: () => act.learnSpelling(params.misspelledWord) },
    ]);
  }
  if (params.linkURL && !params.linkURL.startsWith('javascript:')) {
    groups.push([
      { label: 'Open Link in Browser', click: () => act.openLink(params.linkURL) },
      { label: 'Copy Link Address', click: () => act.copyText(params.linkURL) },
    ]);
  }
  if (params.mediaType === 'image' && params.srcURL) {
    groups.push([
      { label: 'Copy Image', click: () => act.copyImage() },
      // A picture drawn from data in the page has no address worth copying.
      ...(params.srcURL.startsWith('data:') || params.srcURL.startsWith('blob:') ? [] : [{ label: 'Copy Image Address', click: () => act.copyText(params.srcURL) }]),
      { label: 'Save Image As…', click: () => act.saveImage(params.srcURL) },
    ]);
  }
  if (params.isEditable) {
    groups.push([
      { role: 'undo', enabled: !!flags.canUndo },
      { role: 'redo', enabled: !!flags.canRedo },
    ]);
    groups.push([
      { role: 'cut', enabled: !!flags.canCut },
      { role: 'copy', enabled: !!flags.canCopy },
      { role: 'paste', enabled: !!flags.canPaste },
      { role: 'pasteAndMatchStyle', enabled: !!flags.canPaste },
      { role: 'selectAll', enabled: !!flags.canSelectAll },
    ]);
  } else if (params.selectionText?.trim()) {
    groups.push([{ role: 'copy', enabled: flags.canCopy !== false }]);
  }
  if (act.inspect && groups.length) groups.push([{ label: 'Inspect Element', click: () => act.inspect?.() }]);

  return groups.flatMap((g, i) => (i ? [{ type: /** @type {const} */ ('separator') }, ...g] : g));
}
