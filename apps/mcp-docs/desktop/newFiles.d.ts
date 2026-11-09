// Types of newFiles.js (plain JavaScript, as main.js is, which imports it).
export interface Kind {
  id: string;
  label: string;
  exts: string[];
  text?: true;
  on: boolean;
}
export const KINDS: Kind[];
export const DEFAULT_KINDS: string[];
export function kindOf(name: string): string | null;
export function isText(file: string, size: number): boolean;
export function watchNewFiles(opts: {
  dirs: string[];
  kinds?: string[];
  onFile: (file: string) => void;
  ignore?: (file: string) => boolean;
  settle?: number;
  bulk?: number;
}): () => void;
