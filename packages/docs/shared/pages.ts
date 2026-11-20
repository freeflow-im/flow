// The app's page of each kind of file (client/src/main.tsx routes). One table, keyed by every kind, so a new kind
// that is missing here fails the typecheck instead of opening in the spreadsheet page.
import type { DocKind } from './types.ts';

export type FileKind = DocKind | 'file';

export const FILE_PAGES: Record<FileKind, string> = { sheet: 's', deck: 'd', doc: 'doc', markdown: 'md', whiteboard: 'w', file: 'f' };

/** The app's address of a file (`/w/<id>` for a whiteboard), its id encoded. */
export const filePath = (kind: FileKind, id: string): string => `/${FILE_PAGES[kind]}/${encodeURIComponent(id)}`;
