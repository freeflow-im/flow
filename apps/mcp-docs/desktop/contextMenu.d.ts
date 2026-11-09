// Types of contextMenu.js (plain JavaScript, as main.js is, which imports it).
import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

export interface ContextMenuActions {
  copyImage(): void;
  copyText(text: string): void;
  saveImage(url: string): void;
  openLink(url: string): void;
  replaceMisspelling(word: string): void;
  learnSpelling(word: string): void;
  inspect?: () => void;
}

export function contextMenuTemplate(params: Partial<ContextMenuParams>, act: ContextMenuActions): MenuItemConstructorOptions[];
