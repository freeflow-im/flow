import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { contextMenuTemplate, type ContextMenuActions } from './contextMenu.js';

const actions = (): ContextMenuActions => ({
  copyImage: vi.fn(),
  copyText: vi.fn(),
  saveImage: vi.fn(),
  openLink: vi.fn(),
  replaceMisspelling: vi.fn(),
  learnSpelling: vi.fn(),
});
const names = (items: MenuItemConstructorOptions[]) => items.map((i) => (i.type === 'separator' ? '-' : (i.label ?? i.role)));
const click = (items: MenuItemConstructorOptions[], label: string) => (items.find((i) => i.label === label)!.click as () => void)();

describe('contextMenuTemplate', () => {
  it('offers to copy and save a picture', () => {
    const act = actions();
    const items = contextMenuTemplate({ mediaType: 'image', srcURL: 'http://127.0.0.1:5000/api/files/abc', editFlags: {} as never }, act);
    expect(names(items)).toEqual(['Copy Image', 'Copy Image Address', 'Save Image As…']);
    click(items, 'Copy Image');
    expect(act.copyImage).toHaveBeenCalled();
    click(items, 'Copy Image Address');
    expect(act.copyText).toHaveBeenCalledWith('http://127.0.0.1:5000/api/files/abc');
    click(items, 'Save Image As…');
    expect(act.saveImage).toHaveBeenCalledWith('http://127.0.0.1:5000/api/files/abc');
  });

  it('has no address to copy for a picture made in the page', () => {
    expect(names(contextMenuTemplate({ mediaType: 'image', srcURL: 'data:image/png;base64,AAAA' }, actions()))).toEqual(['Copy Image', 'Save Image As…']);
  });

  it('offers a linked picture both ways, the link first', () => {
    const items = contextMenuTemplate({ mediaType: 'image', srcURL: 'https://x.test/a.png', linkURL: 'https://x.test/' }, actions());
    expect(names(items)).toEqual(['Open Link in Browser', 'Copy Link Address', '-', 'Copy Image', 'Copy Image Address', 'Save Image As…']);
  });

  it('edits text being typed, with the spelling checker’s guesses', () => {
    const act = actions();
    const items = contextMenuTemplate(
      { isEditable: true, misspelledWord: 'recieve', dictionarySuggestions: ['receive'], editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canDelete: true, canEditRichly: false } },
      act,
    );
    expect(names(items)).toEqual(['receive', 'Learn Spelling', '-', 'undo', 'redo', '-', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll']);
    expect(items.find((i) => i.role === 'redo')!.enabled).toBe(false);
    click(items, 'receive');
    expect(act.replaceMisspelling).toHaveBeenCalledWith('receive');
  });

  it('copies selected text, and shows nothing where there is nothing to do', () => {
    expect(names(contextMenuTemplate({ selectionText: 'hello', editFlags: { canCopy: true } as never }, actions()))).toEqual(['copy']);
    expect(contextMenuTemplate({ selectionText: '', mediaType: 'none' }, { ...actions(), inspect: () => {} })).toEqual([]);
  });

  it('adds Inspect Element when the app is not packaged', () => {
    expect(names(contextMenuTemplate({ selectionText: 'hello' }, { ...actions(), inspect: () => {} }))).toEqual(['copy', '-', 'Inspect Element']);
  });
});
